const path = require('node:path');
const { app, shell } = require('electron');

const LOGIN_ITEM = 'Kairoware XP';
const DEV_ICON = path.join(__dirname, '..', '..', 'assets', 'icon.ico');

const SHORTCUTS = {
  'big-picture': {
    file: 'Kairoware XP Big Picture.lnk',
    args: ['--big-picture'],
    description: 'Abre o Kairoware XP no modo Big Picture',
  },
  browser: {
    file: 'Kairoware XP Navegador.lnk',
    args: ['--big-picture', '--open=browser'],
    description: 'Abre o navegador do Kairoware XP feito para controle',
  },
};

// In development electron.exe needs the app folder as its first argument.
const launchArgs = (extra = []) => (app.isPackaged ? extra : [app.getAppPath(), ...extra]);
const quote = (arg) => (/\s/.test(arg) ? `"${arg}"` : arg);

function getStartup() {
  const info = app.getLoginItemSettings({ path: process.execPath, args: launchArgs(['--big-picture']) });
  const item = info.launchItems?.find((i) => i.name === LOGIN_ITEM);
  if (item) return { enabled: item.enabled, bigPicture: item.args.includes('--big-picture') };
  return { enabled: info.openAtLogin, bigPicture: info.openAtLogin };
}

function setStartup({ enabled, bigPicture }) {
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    name: LOGIN_ITEM,
    path: process.execPath,
    args: launchArgs(bigPicture ? ['--big-picture'] : []),
  });
  return getStartup();
}

function createShortcut(kind) {
  const shortcut = SHORTCUTS[kind];
  if (!shortcut) throw new Error('Atalho inválido.');
  const ok = shell.writeShortcutLink(path.join(app.getPath('desktop'), shortcut.file), 'create', {
    target: process.execPath,
    args: launchArgs(shortcut.args).map(quote).join(' '),
    description: shortcut.description,
    // Packaged builds embed the icon in the .exe; files inside the asar can't be used by the shell.
    icon: app.isPackaged ? process.execPath : DEV_ICON,
    iconIndex: 0,
  });
  if (!ok) throw new Error('Não foi possível criar o atalho.');
  return `Atalho "${shortcut.file.replace(/\.lnk$/, '')}" criado na área de trabalho.`;
}

module.exports = { getStartup, setStartup, createShortcut };
