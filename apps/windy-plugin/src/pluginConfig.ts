const config = {
  name: 'windy-plugin-av-layer',
  version: '0.1.0',
  icon: '🪂',
  title: 'AV usable lift',
  description: 'Forecast usable lift above sea level and terrain, with available precipitation layers.',
  author: 'AV Forecast Layers',
  repository: 'https://github.com/jdorrance/av-layers',
  desktopUI: 'rhpane',
  mobileUI: 'fullscreen',
  listenToSingleclick: true,
  routerPath: '/av-layer',
  private: true
} as const;

export default config;
