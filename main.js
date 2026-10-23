const { app, BrowserWindow, ipcMain, protocol, session } = require('electron');
const path = require('node:path');
const system = require('./src/main/system');
const cleaner = require('./src/main/cleaner');
const startup = require('./src/main/startup');
const processes = require('./src/main/processes');
const tools = require('./src/main/tools');
const games = require('./src/main/games');
const gameMode = require('./src/main/gamemode');
const settings = require('./src/main/settings');

protocol.registerSchemesAsPrivileged([
  { scheme: 'kairo-art', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const ICON = path.join(__dirname, 'assets', 'icon.ico');
const BROWSER_PARTITION = 'persist:kairo-browser';

let mainWindow = null;
let bigPictureWindow = null;

function webPreferences(extra = {}) {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    ...extra,
  };
}

function lockDown(win) {
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 620,
    title: 'Kairoware XP',
    icon: ICON,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    show: false,
    webPreferences: webPreferences(),
  });

  lockDown(mainWindow);
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (!bigPictureWindow) mainWindow.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// intent: what the Big Picture opens straight into ('browser' or 'store'), e.g. from a desktop shortcut.
function openBigPicture(intent) {
  if (bigPictureWindow) {
    bigPictureWindow.focus();
    return;
  }

  bigPictureWindow = new BrowserWindow({
    title: 'Kairoware XP Big Picture',
    icon: ICON,
    fullscreen: true,
    frame: false,
    backgroundColor: '#05070c',
    show: false,
    // Navigation sounds must play on gamepad input, which doesn't count as a user gesture.
    // The built-in web browser is a <webview>, locked down in 'will-attach-webview' below.
    webPreferences: webPreferences({ autoplayPolicy: 'no-user-gesture-required', webviewTag: true }),
  });

  // The renderer ignores controller input while another app (e.g. a game) has focus.
  const sendFocus = (focused) => bigPictureWindow?.webContents.send('window-focus', focused);
  bigPictureWindow.on('focus', () => sendFocus(true));
  bigPictureWindow.on('blur', () => sendFocus(false));

  lockDown(bigPictureWindow);
  bigPictureWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'bigpicture.html'), {
    query: ['browser', 'store'].includes(intent) ? { open: intent } : {},
  });
  bigPictureWindow.once('ready-to-show', () => {
    bigPictureWindow.show();
    bigPictureWindow.focus();
    mainWindow?.hide();
  });
  bigPictureWindow.on('closed', () => {
    bigPictureWindow = null;
    mainWindow?.show();
  });
}

function closeBigPicture() {
  if (!mainWindow) createMainWindow();
  bigPictureWindow?.close();
}

// Every handler resolves to { ok, data } or { ok, error } so the renderer gets clean error messages.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

handle('system:info', system.getInfo);
handle('system:stats', system.getStats);
handle('system:is-admin', system.isAdmin);
handle('system:relaunch-admin', async () => {
  await system.relaunchAsAdmin();
  app.quit();
});

handle('cleaner:scan', cleaner.scan);
handle('cleaner:clean', cleaner.clean);

handle('startup:list', startup.list);
handle('startup:set-enabled', startup.setEnabled);

handle('processes:list', processes.list);
handle('processes:kill', processes.kill);

handle('tools:flush-dns', tools.flushDns);
handle('tools:power-plans', tools.listPowerPlans);
handle('tools:set-power-plan', tools.setPowerPlan);
handle('tools:ultimate-performance', tools.enableUltimatePerformance);
handle('tools:restore-point', tools.createRestorePoint);
handle('tools:restart-explorer', tools.restartExplorer);
handle('tools:optimize-drive', tools.optimizeDrive);
handle('tools:disk-cleanup', tools.openDiskCleanup);
handle('tools:sfc', tools.runSfc);

handle('games:list', games.list);
handle('games:launch', games.launch);
handle('games:favorite', games.setFavorite);
handle('games:add', games.add);
handle('games:remove', games.remove);
handle('games:open-folder', games.openFolder);

handle('gamemode:get', gameMode.getState);
handle('gamemode:set', gameMode.setActive);

handle('apps:list', games.listApps);
handle('apps:set-installed', games.setAppInstalled);

handle('settings:get-startup', settings.getStartup);
handle('settings:set-startup', settings.setStartup);
handle('settings:create-shortcut', settings.createShortcut);

handle('bigpicture:open', () => openBigPicture());
handle('bigpicture:close', closeBigPicture);
handle('app:quit', () => app.quit());

// Web pages opened by the Big Picture browser get no Node access, no preload and only http(s) URLs.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    if (params.partition !== BROWSER_PARTITION || !/^https?:\/\//i.test(params.src)) event.preventDefault();
  });

  if (contents.getType() === 'webview') {
    // Single-tab browser: popups and target=_blank links open in the same view.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) contents.loadURL(url);
      return { action: 'deny' };
    });
  }
});

function setupBrowserSession() {
  const ses = session.fromPartition(BROWSER_PARTITION);
  // Some sites refuse unknown browsers, so present a plain Chrome user agent.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|Kairoware XP|kairoware-xp)\/\S+/g, ''));
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(['fullscreen', 'pointerLock', 'clipboard-sanitized-write'].includes(permission));
  });
}

app.whenReady().then(() => {
  protocol.handle('kairo-art', games.serveArt);
  setupBrowserSession();

  if (process.argv.includes('--big-picture')) {
    const intent = process.argv.find((arg) => arg.startsWith('--open='))?.slice('--open='.length);
    openBigPicture(intent);
  } else {
    createMainWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// Restore the user's power plan if Game Mode is still on when the app exits.
app.on('before-quit', (event) => {
  if (!gameMode.isActive()) return;
  event.preventDefault();
  gameMode.disable().finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());
