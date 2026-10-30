declare module '@windy/map' {
  export const map: {
    addLayer(layer: unknown): unknown;
    removeLayer(layer: unknown): unknown;
    on(event: string, listener: (event: { latlng?: { lat: number; lng: number } }) => void): unknown;
    off(event: string, listener: (event: { latlng?: { lat: number; lng: number } }) => void): unknown;
  };
}

declare module '@windy/store' {
  const store: {
    get(key: string): unknown;
    set(key: string, value: unknown): boolean;
    on(event: string, listener: (value: number) => void): unknown;
    off?(event: string, listener: (value: number) => void): unknown;
  };
  export default store;
}

declare module '@windy/broadcast' {
  const broadcast: { emit(name: string, ...args: unknown[]): void };
  export default broadcast;
}

declare module '@windy/interfaces' {
  export interface ExternalPluginConfig {
    name: string;
    version: string;
    icon?: string;
    title: string;
    description?: string;
    author?: string;
    repository?: string;
    desktopUI?: string;
    mobileUI?: string;
    routerPath?: string;
    private?: boolean;
  }
}

declare const L: {
    tileLayer(url: string, options?: Record<string, unknown>): {
      setUrl(url: string): unknown;
      setOpacity(opacity: number): unknown;
      remove(): unknown;
    };
  };
