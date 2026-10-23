const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runPowerShell, runPowerShellJson } = require('./powershell');

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const WINDIR = process.env.SystemRoot || 'C:\\Windows';
const PROGRAMDATA = process.env.ProgramData || 'C:\\ProgramData';

const CHROMIUM_USER_DATA = [
  ['Google', 'Chrome', 'User Data'],
  ['Microsoft', 'Edge', 'User Data'],
  ['BraveSoftware', 'Brave-Browser', 'User Data'],
  ['Vivaldi', 'User Data'],
];

async function listDirs(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function browserCacheTargets() {
  const targets = [];
  for (const parts of CHROMIUM_USER_DATA) {
    const userData = path.join(LOCAL, ...parts);
    for (const profile of await listDirs(userData)) {
      if (profile !== 'Default' && !/^Profile \d+$/.test(profile)) continue;
      for (const cache of ['Cache', 'Code Cache', 'GPUCache']) {
        targets.push({ dir: path.join(userData, profile, cache) });
      }
    }
  }
  const firefox = path.join(LOCAL, 'Mozilla', 'Firefox', 'Profiles');
  for (const profile of await listDirs(firefox)) {
    targets.push({ dir: path.join(firefox, profile, 'cache2') });
  }
  return targets;
}

// A target is a directory whose contents are removed; `match` limits it to top-level files with matching names.
const CATEGORIES = [
  {
    id: 'user-temp',
    name: 'Temporários do usuário',
    description: 'Arquivos deixados por instaladores e programas na pasta %TEMP%.',
    targets: async () => [{ dir: os.tmpdir() }],
  },
  {
    id: 'windows-temp',
    name: 'Temporários do Windows',
    description: 'Pasta Temp do sistema. A limpeza completa requer administrador.',
    admin: true,
    targets: async () => [{ dir: path.join(WINDIR, 'Temp') }],
  },
  {
    id: 'browser-cache',
    name: 'Cache de navegadores',
    description: 'Chrome, Edge, Brave, Vivaldi e Firefox. Feche os navegadores para liberar mais espaço.',
    targets: browserCacheTargets,
  },
  {
    id: 'thumbnails',
    name: 'Cache de miniaturas',
    description: 'Miniaturas e ícones do Explorer; são recriados automaticamente.',
    targets: async () => [
      { dir: path.join(LOCAL, 'Microsoft', 'Windows', 'Explorer'), match: /^(thumbcache|iconcache)_.*\.db$/i },
    ],
  },
  {
    id: 'crash-dumps',
    name: 'Relatórios de erro',
    description: 'Dumps de falhas e relatórios do Relatório de Erros do Windows.',
    targets: async () => [
      { dir: path.join(LOCAL, 'CrashDumps') },
      { dir: path.join(LOCAL, 'Microsoft', 'Windows', 'WER') },
      { dir: path.join(PROGRAMDATA, 'Microsoft', 'Windows', 'WER', 'ReportArchive') },
      { dir: path.join(PROGRAMDATA, 'Microsoft', 'Windows', 'WER', 'ReportQueue') },
    ],
  },
  {
    id: 'update-cache',
    name: 'Cache do Windows Update',
    description: 'Downloads de atualizações já baixadas. Requer administrador.',
    admin: true,
    targets: async () => [{ dir: path.join(WINDIR, 'SoftwareDistribution', 'Download') }],
  },
  {
    id: 'recycle-bin',
    name: 'Lixeira',
    description: 'Esvazia a Lixeira de todas as unidades. Não pode ser desfeito.',
    recycleBin: true,
  },
];

async function measureDir(dir, match, stats) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.isSymbolicLink()) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!match) subdirs.push(full);
        return;
      }
      if (match && !match.test(entry.name)) return;
      try {
        const { size } = await fs.lstat(full);
        stats.size += size;
        stats.files++;
      } catch {
        // File vanished or is inaccessible.
      }
    }),
  );
  for (const sub of subdirs) await measureDir(sub, null, stats);
}

// Deletes what it can; files in use or without permission are counted as failed and left alone.
async function clearDir(dir, match, stats) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.isSymbolicLink()) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!match) subdirs.push(full);
        return;
      }
      if (match && !match.test(entry.name)) return;
      try {
        const { size } = await fs.lstat(full);
        await fs.unlink(full);
        stats.freed += size;
        stats.files++;
      } catch {
        stats.failed++;
      }
    }),
  );
  for (const sub of subdirs) {
    await clearDir(sub, null, stats);
    await fs.rmdir(sub).catch(() => {});
  }
}

async function uniqueTargets(category) {
  const seen = new Set();
  return (await category.targets()).filter(({ dir }) => {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function recycleBinStats() {
  const data = await runPowerShellJson(`
$bin = (New-Object -ComObject Shell.Application).NameSpace(10)
$size = [int64]0; $count = 0
foreach ($item in $bin.Items()) { $size += [int64]$item.Size; $count++ }
[pscustomobject]@{ size = $size; files = $count } | ConvertTo-Json -Compress`);
  return { size: data?.size ?? 0, files: data?.files ?? 0 };
}

async function scan() {
  return Promise.all(
    CATEGORIES.map(async (category) => {
      const { id, name, description, admin = false } = category;
      let stats = { size: 0, files: 0 };
      if (category.recycleBin) {
        stats = await recycleBinStats().catch(() => stats);
      } else {
        for (const target of await uniqueTargets(category)) await measureDir(target.dir, target.match, stats);
      }
      return { id, name, description, admin, ...stats };
    }),
  );
}

async function clean(ids) {
  if (!Array.isArray(ids)) throw new Error('Seleção inválida.');
  const results = [];
  for (const category of CATEGORIES.filter((c) => ids.includes(c.id))) {
    const stats = { id: category.id, freed: 0, files: 0, failed: 0 };
    if (category.recycleBin) {
      const before = await recycleBinStats().catch(() => ({ size: 0, files: 0 }));
      await runPowerShell('Clear-RecycleBin -Force -ErrorAction SilentlyContinue');
      stats.freed = before.size;
      stats.files = before.files;
    } else {
      for (const target of await uniqueTargets(category)) await clearDir(target.dir, target.match, stats);
    }
    results.push(stats);
  }
  return results;
}

module.exports = { scan, clean };
