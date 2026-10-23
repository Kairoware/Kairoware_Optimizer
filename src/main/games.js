const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { app, dialog, shell, net, BrowserWindow } = require('electron');
const { run, runPowerShell, runPowerShellJson, psString, toArray } = require('./powershell');

const IGNORED_STEAM_APPS = new Set(['228980']); // Steamworks Common Redistributables
const IGNORED_STEAM_NAMES = /redistributable|steam linux runtime|proton|steamworks/i;
const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';

let games = new Map();
let steamDir = null;
let store = null;

// ---------- Persistent library data (custom games, favorites, last played) ----------

const storePath = () => path.join(app.getPath('userData'), 'library.json');
// Data folder used before the app was renamed from "Kairoware Optimizer" to "Kairoware XP".
const legacyStorePath = () => path.join(app.getPath('appData'), 'Kairoware Optimizer', 'library.json');

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function loadStore() {
  if (store) return store;
  store = await readJson(storePath())
    .catch(() => readJson(legacyStorePath()))
    .catch(() => ({}));
  store.custom ??= [];
  store.favorites ??= [];
  store.lastPlayed ??= {};
  return store;
}

async function saveStore() {
  await fs.mkdir(path.dirname(storePath()), { recursive: true });
  await fs.writeFile(storePath(), JSON.stringify(store, null, 2));
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

// ---------- Steam ----------

function vdfValue(text, key) {
  const match = text.match(new RegExp(`"${key}"\\s+"([^"]*)"`, 'i'));
  return match ? match[1].replace(/\\\\/g, '\\') : null;
}

async function findSteamDir() {
  try {
    const out = await run('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
    const match = out.match(/SteamPath\s+REG_SZ\s+(.+)/);
    if (match) return path.normalize(match[1].trim());
  } catch {
    // Steam not installed for this user.
  }
  return path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam');
}

async function scanSteam() {
  steamDir = await findSteamDir();
  if (!(await exists(steamDir))) return [];

  const libraries = new Map([[steamDir.toLowerCase(), steamDir]]);
  try {
    const vdf = await fs.readFile(path.join(steamDir, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const match of vdf.matchAll(/"path"\s+"([^"]+)"/gi)) {
      const lib = path.normalize(match[1].replace(/\\\\/g, '\\'));
      libraries.set(lib.toLowerCase(), lib);
    }
  } catch {
    // Only the default library exists.
  }

  const found = [];
  for (const lib of libraries.values()) {
    const appsDir = path.join(lib, 'steamapps');
    let manifests;
    try {
      manifests = (await fs.readdir(appsDir)).filter((f) => /^appmanifest_\d+\.acf$/i.test(f));
    } catch {
      continue;
    }
    for (const file of manifests) {
      let text;
      try {
        text = await fs.readFile(path.join(appsDir, file), 'utf8');
      } catch {
        continue;
      }
      const appid = vdfValue(text, 'appid');
      const name = vdfValue(text, 'name');
      const installed = Number(vdfValue(text, 'StateFlags') || 0) & 4;
      if (!appid || !name || !installed || IGNORED_STEAM_APPS.has(appid) || IGNORED_STEAM_NAMES.test(name)) continue;
      found.push({
        id: `steam-${appid}`,
        name,
        source: 'steam',
        appid,
        installDir: path.join(appsDir, 'common', vdfValue(text, 'installdir') || ''),
      });
    }
  }
  return found;
}

// Steam keeps library art locally, either as "<appid>_<name>.jpg" (older clients)
// or inside "<appid>/" (possibly in a hashed subfolder) on newer ones.
async function findSteamArt(appid, names) {
  const cache = path.join(steamDir, 'appcache', 'librarycache');
  const candidates = names.map((n) => path.join(cache, `${appid}_${n}.jpg`));
  let nested = [];
  try {
    nested = await fs.readdir(path.join(cache, appid), { recursive: true });
  } catch {
    // No per-app folder.
  }
  for (const n of names) {
    const hit = nested.find((f) => path.basename(f).toLowerCase() === `${n}.jpg`);
    if (hit) candidates.push(path.join(cache, appid, hit));
  }
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

// ---------- Epic Games ----------

async function scanEpic() {
  const dir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  let files;
  try {
    files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.item'));
  } catch {
    return [];
  }

  const found = [];
  for (const file of files) {
    try {
      const item = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
      const categories = item.AppCategories || [];
      if (!categories.includes('games') || categories.includes('addons') || item.bIsIncompleteInstall) continue;
      const catalogId = `${item.CatalogNamespace}:${item.CatalogItemId}:${item.AppName}`;
      found.push({
        id: `epic-${item.AppName}`,
        name: item.DisplayName,
        source: 'epic',
        installDir: item.InstallLocation,
        exe: item.LaunchExecutable ? path.join(item.InstallLocation, item.LaunchExecutable) : null,
        launchUrl: `com.epicgames.launcher://apps/${encodeURIComponent(catalogId)}?action=launch&silent=true`,
      });
    } catch {
      // Corrupt or partial manifest.
    }
  }
  return found;
}

// ---------- GOG ----------

async function scanGog() {
  const entries = toArray(
    await runPowerShellJson(`
$root = 'HKLM:\\SOFTWARE\\WOW6432Node\\GOG.com\\Games'
if (-not (Test-Path $root)) { '[]'; return }
ConvertTo-Json -Compress -InputObject @(Get-ChildItem $root | ForEach-Object {
  $p = Get-ItemProperty -LiteralPath $_.PSPath
  if ($p.dependsOn) { return }
  [pscustomobject]@{ id = $_.PSChildName; name = $p.gameName; exe = $p.exe; dir = $p.path; workingDir = $p.workingDir; args = $p.launchParam }
})`),
  );
  return entries
    .filter((g) => g.name && g.exe)
    .map((g) => ({
      id: `gog-${g.id}`,
      name: g.name,
      source: 'gog',
      exe: g.exe,
      args: (g.args || '').match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, '')) ?? [],
      cwd: g.workingDir || g.dir,
      installDir: g.dir,
    }));
}

// ---------- Xbox app / Microsoft Store (PC Game Pass) ----------

// GDK games ship a MicrosoftGame.config next to the package; its display name is often an
// "ms-resource:" reference, resolved here through SHLoadIndirectString.
const XBOX_SCRIPT = `
Add-Type -Namespace Kairo -Name Shell -MemberDefinition '[DllImport("shlwapi.dll", CharSet = CharSet.Unicode)] public static extern int SHLoadIndirectString(string source, System.Text.StringBuilder buffer, int size, IntPtr reserved);'
function Resolve-Text($pkg, $value) {
  if (-not $value) { return $null }
  if ($value -notlike 'ms-resource:*') { return $value }
  $res = $value.Substring(12)
  if ($res.StartsWith('//')) { $uri = "ms-resource:$res" }
  elseif ($res.StartsWith('/')) { $uri = "ms-resource://$($pkg.Name)$res" }
  elseif ($res.Contains('/')) { $uri = "ms-resource://$($pkg.Name)/$res" }
  else { $uri = "ms-resource://$($pkg.Name)/Resources/$res" }
  $buffer = New-Object System.Text.StringBuilder 1024
  if ([Kairo.Shell]::SHLoadIndirectString("@{$($pkg.PackageFullName)? $uri}", $buffer, $buffer.Capacity, [IntPtr]::Zero) -eq 0) { return $buffer.ToString() }
  return $null
}
$games = foreach ($pkg in Get-AppxPackage -PackageTypeFilter Main) {
  if ($pkg.IsFramework -or -not $pkg.InstallLocation) { continue }
  $config = Join-Path $pkg.InstallLocation 'MicrosoftGame.config'
  if (-not (Test-Path -LiteralPath $config)) { continue }
  try { [xml]$xml = Get-Content -LiteralPath $config -Raw } catch { continue }
  $visuals = $xml.Game.ShellVisuals
  $manifest = $null
  try { $manifest = Get-AppxPackageManifest -Package $pkg } catch {}
  $appId = $null
  if ($manifest) { $appId = @($manifest.Package.Applications.Application)[0].Id }
  if (-not $appId) { $appId = @($xml.Game.ExecutableList.Executable)[0].Id }
  if (-not $appId) { continue }
  $name = Resolve-Text $pkg $visuals.DefaultDisplayName
  if (-not $name -and $manifest) { $name = Resolve-Text $pkg $manifest.Package.Properties.DisplayName }
  if (-not $name) { $name = $pkg.Name }
  [pscustomobject]@{
    id = $pkg.PackageFamilyName; name = $name; aumid = "$($pkg.PackageFamilyName)!$appId"; dir = $pkg.InstallLocation
    logo = @($visuals.Square480x480Logo, $visuals.Square150x150Logo, $visuals.StoreLogo) | Where-Object { $_ } | Select-Object -First 1
    splash = $visuals.SplashScreenImage
  }
}
ConvertTo-Json -Compress -InputObject @($games)`;

async function scanXbox() {
  const entries = toArray(await runPowerShellJson(XBOX_SCRIPT, { timeout: 120_000 }));
  return entries.map((g) => ({
    id: `xbox-${g.id}`,
    name: g.name,
    source: 'xbox',
    aumid: g.aumid,
    installDir: g.dir,
    art: {
      icon: g.logo ? path.join(g.dir, g.logo) : null,
      hero: g.splash ? path.join(g.dir, g.splash) : null,
    },
  }));
}

// ---------- Custom ----------

async function customGames() {
  await loadStore();
  return store.custom.map((g) => ({ ...g, source: 'custom', installDir: path.dirname(g.exe) }));
}

async function productName(exe) {
  try {
    return await runPowerShell(
      `$v = (Get-Item -LiteralPath ${psString(exe)}).VersionInfo; if ($v.ProductName) { $v.ProductName } else { $v.FileDescription }`,
    );
  } catch {
    return '';
  }
}

// ---------- Public API ----------

function toView(game) {
  const id = encodeURIComponent(game.id);
  const isSteam = game.source === 'steam';
  return {
    id: game.id,
    name: game.name,
    source: game.source,
    favorite: store.favorites.includes(game.id),
    lastPlayed: store.lastPlayed[game.id] || 0,
    cover: isSteam ? `kairo-art://cover/${id}` : null,
    hero: isSteam || game.art?.hero ? `kairo-art://hero/${id}` : null,
    icon: game.exe || game.art?.icon ? `kairo-art://icon/${id}` : null,
    removable: game.source === 'custom',
  };
}

async function list() {
  await loadStore();
  const scans = [scanSteam(), scanEpic(), scanGog(), scanXbox(), customGames()];
  const results = await Promise.all(scans.map((p) => p.catch(() => [])));
  games = new Map(results.flat().map((g) => [g.id, g]));
  return [...games.values()].map(toView);
}

function getGame(id) {
  const game = games.get(id);
  if (!game) throw new Error('Jogo não encontrado. Atualize a biblioteca.');
  return game;
}

function launchExe(exe, args = [], cwd = path.dirname(exe)) {
  if (path.extname(exe).toLowerCase() !== '.exe') {
    return shell.openPath(exe).then((err) => {
      if (err) throw new Error(err);
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, detached: true, stdio: 'ignore' });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    // Games that require elevation fail to spawn directly; the shell handles the UAC prompt.
    child.once('error', async () => {
      const err = await shell.openPath(exe);
      if (err) reject(new Error(err));
      else resolve();
    });
  });
}

async function launch(id) {
  const game = getGame(id);
  if (game.source === 'steam') await shell.openExternal(`steam://rungameid/${game.appid}`);
  else if (game.source === 'epic') await shell.openExternal(game.launchUrl);
  else if (game.source === 'xbox') spawn('explorer.exe', [`shell:AppsFolder\\${game.aumid}`], { detached: true, stdio: 'ignore' }).unref();
  else await launchExe(game.exe, game.args, game.cwd);

  store.lastPlayed[id] = Date.now();
  await saveStore();
}

async function setFavorite(id, favorite) {
  await loadStore();
  store.favorites = store.favorites.filter((f) => f !== id);
  if (favorite) store.favorites.push(id);
  await saveStore();
}

async function add() {
  await loadStore();
  const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Adicionar jogo',
    filters: [{ name: 'Jogos e atalhos', extensions: ['exe', 'lnk'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return null;

  const exe = filePaths[0];
  if (store.custom.some((g) => g.exe.toLowerCase() === exe.toLowerCase())) {
    throw new Error('Este jogo já está na biblioteca.');
  }
  const game = { id: `custom-${crypto.randomUUID()}`, name: (await productName(exe)) || path.parse(exe).name, exe };
  store.custom.push(game);
  await saveStore();
  return game.id;
}

async function remove(id) {
  await loadStore();
  store.custom = store.custom.filter((g) => g.id !== id);
  store.favorites = store.favorites.filter((f) => f !== id);
  delete store.lastPlayed[id];
  await saveStore();
}

// ---------- Big Picture apps (installed from the app store) ----------

async function listApps() {
  await loadStore();
  return store.apps ?? [];
}

async function setAppInstalled(id, installed) {
  if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) throw new Error('App inválido.');
  await loadStore();
  store.apps = (store.apps ?? []).filter((a) => a !== id);
  if (installed) store.apps.push(id);
  await saveStore();
  return store.apps;
}

async function openFolder(id) {
  const game = getGame(id);
  const err = await shell.openPath(game.installDir || path.dirname(game.exe));
  if (err) throw new Error(err);
}

// Serves kairo-art://<cover|hero|icon>/<game id>: local Steam art first, then the Steam CDN,
// Xbox package art, and executable icons for everything else.
async function serveArt(request) {
  const url = new URL(request.url);
  const kind = url.hostname;
  const game = games.get(decodeURIComponent(url.pathname.slice(1)));
  try {
    const packaged = game?.art?.[kind];
    if (packaged && (await exists(packaged))) return net.fetch(pathToFileURL(packaged).toString());
    if (game && kind === 'icon' && game.exe) {
      const icon = await app.getFileIcon(game.exe, { size: 'large' });
      return new Response(icon.toPNG(), { headers: { 'content-type': 'image/png' } });
    }
    if (game?.source === 'steam' && (kind === 'cover' || kind === 'hero')) {
      const names = kind === 'cover' ? ['library_600x900', 'library_capsule'] : ['library_hero'];
      const local = await findSteamArt(game.appid, names);
      if (local) return net.fetch(pathToFileURL(local).toString());
      const remote = await net.fetch(`${STEAM_CDN}/${game.appid}/${names[0]}.jpg`);
      if (remote.ok) return remote;
    }
  } catch {
    // Fall through to 404; the UI shows a placeholder.
  }
  return new Response(null, { status: 404 });
}

module.exports = { list, launch, setFavorite, add, remove, openFolder, serveArt, listApps, setAppInstalled };
