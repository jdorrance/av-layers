/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OFFLINE_FIXTURE?: string;
  readonly VITE_MODEL?: string;
  readonly AV_API_BASE?: string;
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
