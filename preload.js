const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('kairo', {
  getSystemInfo: () => invoke('system:info'),
  getStats: () => invoke('system:stats'),
  isAdmin: () => invoke('system:is-admin'),
  relaunchAsAdmin: () => invoke('system:relaunch-admin'),

  scanCleaner: () => invoke('cleaner:scan'),
  cleanCategories: (ids) => invoke('cleaner:clean', ids),

  listStartup: () => invoke('startup:list'),
  setStartupEnabled: (source, name, enabled) => invoke('startup:set-enabled', source, name, enabled),

  listProcesses: () => invoke('processes:list'),
  killProcess: (name, pids) => invoke('processes:kill', name, pids),

  flushDns: () => invoke('tools:flush-dns'),
  listPowerPlans: () => invoke('tools:power-plans'),
  setPowerPlan: (guid) => invoke('tools:set-power-plan', guid),
  enableUltimatePerformance: () => invoke('tools:ultimate-performance'),
  createRestorePoint: () => invoke('tools:restore-point'),
  restartExplorer: () => invoke('tools:restart-explorer'),
  optimizeDrive: () => invoke('tools:optimize-drive'),
  openDiskCleanup: () => invoke('tools:disk-cleanup'),
  runSfc: () => invoke('tools:sfc'),

  listGames: () => invoke('games:list'),
  launchGame: (id) => invoke('games:launch', id),
  setFavorite: (id, favorite) => invoke('games:favorite', id, favorite),
  addGame: () => invoke('games:add'),
  removeGame: (id) => invoke('games:remove', id),
  openGameFolder: (id) => invoke('games:open-folder', id),

  listApps: () => invoke('apps:list'),
  setAppInstalled: (id, installed) => invoke('apps:set-installed', id, installed),

  getStartup: () => invoke('settings:get-startup'),
  setStartup: (options) => invoke('settings:set-startup', options),
  createShortcut: (kind) => invoke('settings:create-shortcut', kind),

  getGameMode: () => invoke('gamemode:get'),
  setGameMode: (enabled) => invoke('gamemode:set', enabled),

  openBigPicture: () => invoke('bigpicture:open'),
  closeBigPicture: () => invoke('bigpicture:close'),
  quitApp: () => invoke('app:quit'),
  onWindowFocus: (callback) => ipcRenderer.on('window-focus', (_event, focused) => callback(focused)),
});
