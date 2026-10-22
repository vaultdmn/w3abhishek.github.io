import { XSession, type XSessionConfig } from './auth/XSession.js';
import { GuestAuth } from './auth/GuestAuth.js';
import { SpacesApi } from './spaces/SpacesApi.js';

export type XSpaceKitConfig = {
  xSession: XSessionConfig;
};

export class XSpaceKit {
  readonly session: XSession;
  readonly guestAuth: GuestAuth;
  readonly spaces: SpacesApi;

  constructor(cfg: XSpaceKitConfig, init?: { fetch?: typeof fetch }) {
    this.session = new XSession(cfg.xSession, init);
    this.guestAuth = new GuestAuth(this.session, init);
    this.spaces = new SpacesApi(this.session, init);
  }
}
