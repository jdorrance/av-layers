import type { ExternalPluginConfig } from '@windy/interfaces';

const BUILD_API_BASE = '__AV_API_BASE__';

export const API_BASE = BUILD_API_BASE;

const config: ExternalPluginConfig = {
  name: 'windy-plugin-av-layer',
  version: '0.1.0',
  icon: '🪂',
  title: 'AV usable lift',
  description: 'GFS usable lift above sea level and model ground, plus precipitation rate.',
  author: 'AV Forecast Layers',
  repository: 'https://github.com/jdorrance/av-layers',
  desktopUI: 'rhpane',
  mobileUI: 'fullscreen',
  routerPath: '/av-layer',
  private: true
};

export default config;
