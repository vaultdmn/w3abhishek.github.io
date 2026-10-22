---
title: "xspacekit: an unofficial SDK for X Spaces audio"
date: 2026-10-23 09:00:00 +0530
categories: [research, networking]
tags: [x-spaces, webrtc, janus, reverse-engineering, sdk, opus, hls]
description: "A protocol walkthrough + SDK architecture plan for X Spaces audio: guest auth, space lifecycle, chat events, and WebRTC/Janus signaling over the HTTP gateway."
---

> Heads up: this post is reverse-engineering research. The HAR/capture used for verification contains live cookies/tokens, so all notes here use placeholders (e.g. `<AUTH_TOKEN>`, `<CT0>`, `<GUEST_JWT>`). Don’t copy real values into code or public docs.

## TL;DR

**xspacekit** is an unofficial SDK that can:

- Bootstrap a Periscope “guest” session for Audiospace (`authorizeToken`, `turnServers`).
- Fetch Space metadata from X GraphQL (`AudioSpaceById`).
- Join as listener and poll occupancy (`audiospace/join`, `audiospace/call/status`).
- Request/enable speaker permission (`audiospace/request/submit`).
- Ingest events (speaker/occupancy/chat) via X Live Chat NDJSON (`api.x.com/live-chat`) and/or Periscope chat bootstrap (`accessChat`).
- Negotiate audio delivery via:
  - **HLS playback** for listening, and
  - **WebRTC via Janus videoroom**, where signaling is carried over an **HTTP long-poll gateway**.

The smallest end-to-end milestone is: **guest auth → fetch metadata → join as listener → start reading occupancy + HLS playback**.

---

## 1) Auth: two layers (X web session + Periscope guest)

### 1.1 X GraphQL session (cookies + CSRF)

Observed GraphQL calls to `https://x.com/i/api/graphql/...` include:

- `authorization: Bearer <X_BEARER>`
- `x-csrf-token: <CT0>`
- `Cookie: auth_token=<AUTH_TOKEN>; ct0=<CT0>; guest_id=<GUEST_ID>; ...`

Some requests also include:

- `x-client-transaction-id: <X_CLIENT_TX_ID>`
- `x-twitter-auth-type: OAuth2Session`
- `x-twitter-active-user: yes`

### 1.2 Periscope guest auth (Audiospace backend)

To talk to the Audiospace backend (`guest-cf.pscp.tv`), the client uses two endpoints:

1) **Authorize guest token**

```http
POST https://proxsee-cf.pscp.tv/api/v2/authorizeToken
Content-Type: application/json

{
  "service": "guest",
  "cookie": "atu<REDACTED>"
}
```

Response shape:

```json
{ "authorization_token": "eyJ...<REDACTED>" }
```

2) **TURN credentials**

```http
POST https://proxsee-cf.pscp.tv/api/v2/turnServers
Content-Type: application/json

{ "cookie": "atu<REDACTED>" }
```

Response shape:

```json
{
  "ttl": "86400",
  "username": "<TURN_USERNAME>",
  "password": "<TURN_PASSWORD>",
  "uris": ["turns:turn.pscp.tv:443?transport=tcp"]
}
```

---

## 2) Space lifecycle: metadata → join → (request permission → speaking)

### 2.1 Fetch Space metadata

Metadata comes from X GraphQL (`AudioSpaceById`).

- **Query id (observed):** `bpQedjCUnMgs3yXNi8fZlA`

Example URL pattern:

```http
GET https://x.com/i/api/graphql/bpQedjCUnMgs3yXNi8fZlA/AudioSpaceById
  ?variables={...}
  &features={...}
```

Key fields observed:

- `rest_id` (= broadcast id)
- `state` (e.g. `Running`)
- `title`
- `started_at`
- participant lists (`admins`, `speakers`, etc.)

### 2.2 Join as listener

Observed:

```http
POST https://guest-cf.pscp.tv/api/v1/audiospace/join
Authorization: <GUEST_JWT>
Content-Type: application/json

{
  "broadcast_id": "<BROADCAST_ID>",
  "join_as_admin": false,
  "should_auto_join": false,
  "chat_token": "<CHAT_TOKEN>",
  "ntpForBroadcasterFrame": 2208988800021999900,
  "ntpForLiveFrame": 2208988800021999900
}
```

Response shape:

```json
{ "can_auto_join": false }
```

### 2.3 Speaker permission workflow (the full sequence)

In the verified flow, “speaking” is gated behind explicit permission:

1) **Request speaker permission**

```http
POST https://guest-cf.pscp.tv/api/v1/audiospace/request/submit
Authorization: <GUEST_JWT>

{
  "broadcast_id": "<BROADCAST_ID>",
  "chat_token": "<CHAT_TOKEN>",
  "ntpForBroadcasterFrame": 2208988800021999900,
  "ntpForLiveFrame": 2208988800021999900
}
```

Response shape:

```json
{ "success": true, "session_uuid": "<SESSION_UUID>" }
```

2) **Stream negotiation** (WebRTC/Janus bootstrap)

```http
POST https://guest-cf.pscp.tv/api/v1/audiospace/stream/negotiate
Authorization: <GUEST_JWT>

{ "session_uuid": "<SESSION_UUID>" }
```

Response shape:

```json
{ "janus_jwt": "<JANUS_JWT>", "webrtc_gw_url": "<WEBRTC_GATEWAY_URL>" }
```

3) **Janus gateway signaling** (details in §4)

### 2.4 Occupancy polling (what to drive your state machine with)

Best observed state source in the capture:

```http
POST https://guest-cf.pscp.tv/api/v1/audiospace/call/status
Authorization: <GUEST_JWT>

{
  "broadcast_id": "<BROADCAST_ID>",
  "include_non_active_sessions": false
}
```

Response shape:

```json
{
  "success": true,
  "call_in_disabled": false,
  "guest_sessions": [
    {
      "session_uuid": "<SESSION_UUID>",
      "session_state": 9,
      "guest_is_audio_only": true,
      "is_muted_by_admin": false,
      "is_muted_by_guest": true,
      "ended_at": "0001-01-01T00:00:00Z"
    }
  ]
}
```

In this capture, after stream negotiation the speaker session appears to progress from `session_state=9` to `session_state=10` soon after. Exact semantic decoding of those integers is still incomplete.

---

## 3) Signaling & events: NDJSON live-chat + chat bootstrap

### 3.1 Live chat feed (NDJSON)

Observed endpoint:

```http
GET https://api.x.com/live-chat?broadcastId=<BROADCAST_ID>&sessionId=<SESSION_ID>
Authorization: <X_BEARER>
x-csrf-token: <CT0>
```

Response content-type: `application/x-ndjson`

Events include fields like `chatType`, `controlType`, and target session UUIDs.

---

## 4) Audio transport: HLS for playback + Janus videoroom over HTTP gateway

### 4.1 Listen: HLS playback

The HAR shows classic HLS delivery:

- `application/x-mpegURL` (m3u8)
- `audio/aac` chunks

### 4.2 WebRTC bootstrap: audiospace/stream/negotiate → Janus gateway

The WebRTC path in this capture is:

1) `POST /audiospace/stream/negotiate` → `janus_jwt`, `webrtc_gw_url`
2) Janus signaling happens via an **HTTP gateway**:

- Create gateway session:
  - `POST <gw>/v1/gateway`
- Attach plugin:
  - `POST <gw>/v1/gateway/<janus_session>` with `{ "janus": "attach", "plugin": "janus.plugin.videoroom" }`
- Exchange videoroom messages:
  - `POST <gw>/v1/gateway/<janus_session>` with `janus: "message"` and `janus: "trickle"`
- Keepalive / events:
  - `GET <gw>/v1/gateway/<janus_session>?maxev=1`

### 4.3 Janus videoroom: observed publisher vs subscriber message sequence

This capture contains **both** a publisher path and a separate subscriber/listening path in a different gateway session.

#### Publisher / speaking path (observed)

- `request: "create"` (sets codecs; `audiocodec: "opus"`, `videocodec: "h264"`)
- `request: "join"`, `ptype: "publisher"`
- `request: "configure"`, with `jsep: { type: "offer" }` (includes `session_uuid`, `stream_name`, and `vidman_token`)
- repeated `janus: "trickle"` calls with ICE candidates

#### Subscriber / listening path (observed)

In another gateway session:

- `request: "join"`, `ptype: "subscriber"`
- `request: "start"`, `jsep: { type: "answer" }`

For xspacekit, the important implementation detail is to treat offer/answer as a *sequenced exchange* across gateway messages, not as “configure always pairs with answer in the same gateway request”.

### 4.4 RTMPS ingest path

No `rtmps://`/`rtmp://` ingest URLs or stream keys were captured in this HAR. Treat RTMPS as **open** until you capture a timeline where the publisher uses ingest-based upstream.

---

## 5) xspacekit architecture plan (TypeScript)

### 5.1 Design goals

- **Isolation by protocol adapter**: GraphQL ids, feature flags, and gateway message shapes can rotate.
- **No brittle coupling between auth, transport, and events**.
- **Pluggable media layer**: HLS and WebRTC should share a common “AudioStream” abstraction.

### 5.2 Module layout

A practical TypeScript layout:

- `auth/`
  - `XSession.ts` (GraphQL request + CSRF + cookie plumbing)
  - `GuestAuth.ts` (`authorizeToken`, `turnServers`)
- `spaces/`
  - `SpacesApi.ts` (`AudioSpaceById`)
- `signaling/`
  - `LiveChatClient.ts` (NDJSON polling/parsing)
  - `JanusGateway.ts` (HTTP gateway long-poll + message framing)
- `transports/`
  - `HlsTransport.ts` (listen-only playback URLs)
  - `WebRtcTransport.ts` (SDP/ICE adapter around WebRTC primitives)
  - `RtmpsTransport.ts` (optional until verified)
- `audio/`
  - codecs + `AudioStream.ts`
- `cli/`

---

## 6) Milestones: build smallest working loop first

1) guest auth bootstrap (`authorizeToken` + `turnServers`)
2) fetch metadata (`AudioSpaceById`)
3) join as listener (`audiospace/join` + `call/status`)
4) read occupancy + HLS playback
5) implement Janus HTTP gateway adapter
6) bring up speaking: `request/submit` → `stream/negotiate` → Janus configure/trickle
7) only then: RTMPS ingest (if you can capture it)
8) CLI + LLM voice-agent piping

---

## 7) Open questions (what to capture next)

- Full mapping of `session_state` integers to semantic meanings.
- The complete videoroom state machine that bridges `request/submit` → “speaking enabled”.
- The complete role mapping between videoroom messages and “listening” vs “speaking/publishing”.
- RTMPS ingest verification.

If you’re capturing your own HARs, focus on the moments where WebRTC media is *actually* published/subscribed; that’s where the remaining gaps usually close.
