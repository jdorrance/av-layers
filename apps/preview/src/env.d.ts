interface ImportMetaEnv {
  readonly VITE_OFFLINE_FIXTURE?: string;
  readonly VITE_MODEL?: string;
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
