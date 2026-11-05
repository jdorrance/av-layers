/// <reference types="vite/client" />

type WindySingleclickPoint = { lat: number; lon: number };

declare const W: {
  map: {
    map: import('./raster-layer').NativeRasterMap;
    layerOrder?: import('./raster-layer').ForecastLayerOrder;
  };
  singleclick: { singleclick: {
    on(name: string, listener: (point: WindySingleclickPoint) => void): unknown;
    off(name: string, listener: (point: WindySingleclickPoint) => void): unknown;
  } };
  store: import('./controller').HostStore;
  broadcast: { emit(name: string, ...args: unknown[]): void };
};
declare const L: import('./raster-layer').NativeRasterApi;
declare const __WINDY_CONFIG__: typeof import('./pluginConfig').default & { built: number; builtReadable: string };
