/// <reference types="vite/client" />

declare const W: {
  map: { map: import('./raster-layer').NativeRasterMap & {
    on(event: 'click', listener: (event: { latlng?: { lat: number; lng: number } }) => void): unknown;
    off(event: 'click', listener: (event: { latlng?: { lat: number; lng: number } }) => void): unknown;
  } };
  store: import('./controller').HostStore;
  broadcast: { emit(name: string, ...args: unknown[]): void };
};
declare const L: import('./raster-layer').NativeRasterApi;
declare const __WINDY_CONFIG__: typeof import('./pluginConfig').default & { built: number; builtReadable: string };
