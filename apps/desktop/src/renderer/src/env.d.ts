import type { OrbitApi } from '@orbitdrop/contracts';

declare global {
  interface Window {
    /** Exposed by the preload script (contextBridge). Views use useOrbit() instead of this global. */
    readonly orbit: OrbitApi;
  }
}

export {};
