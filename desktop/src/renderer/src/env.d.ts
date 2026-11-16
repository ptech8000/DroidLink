import type { DroidLinkApi } from '../../preload';

declare global {
  interface Window {
    droidlink: DroidLinkApi;
  }
}

export {};
