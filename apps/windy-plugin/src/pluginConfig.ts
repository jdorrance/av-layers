const config = {
  name: 'windy-plugin-av-layer',
  version: '0.1.0',
  icon: '🪂',
  title: 'AV usable lift',
  description: 'Usable lift forecast drawn with the wind field.',
  author: 'AV Forecast Layers',
  repository: 'https://github.com/jdorrance/av-layers',
  desktopUI: 'rhpane',
  mobileUI: 'fullscreen',
  listenToSingleclick: false,
  routerPath: '/av-layer',
  private: true
} as const;

export default config;
