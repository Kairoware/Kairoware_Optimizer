const os = require('node:os');
const fs = require('node:fs/promises');
const { app } = require('electron');
const { runPowerShell, runPowerShellJson, psString, toArray } = require('./powershell');

let adminCache = null;
let drives = [];
let lastCpu = cpuSnapshot();

function cpuSnapshot() {
  return os.cpus().reduce(
    (acc, { times }) => {
      acc.idle += times.idle;
      acc.total += times.user + times.nice + times.sys + times.idle + times.irq;
      return acc;
    },
    { idle: 0, total: 0 },
  );
}

function cpuUsage() {
  const now = cpuSnapshot();
  const idle = now.idle - lastCpu.idle;
  const total = now.total - lastCpu.total;
  lastCpu = now;
  return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
}

async function isAdmin() {
  if (adminCache === null) {
    const out = await runPowerShell(
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    );
    adminCache = out === 'True';
  }
  return adminCache;
}

async function getInfo() {
  const data = await runPowerShellJson(`
$os = Get-CimInstance Win32_OperatingSystem
[pscustomobject]@{
  os = $os.Caption
  build = $os.BuildNumber
  gpu = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name })
  drives = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { $_.DeviceID })
} | ConvertTo-Json -Compress`);

  drives = toArray(data.drives);
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    os: data.os,
    build: data.build,
    cpu: cpus[0]?.model.trim() ?? 'Desconhecido',
    cores: cpus.length,
    gpu: toArray(data.gpu),
    totalMemory: os.totalmem(),
    systemDrive: (process.env.SystemDrive || 'C:').toUpperCase(),
    drives,
  };
}

async function getStats() {
  const total = os.totalmem();
  const disks = await Promise.all(
    drives.map(async (drive) => {
      try {
        const s = await fs.statfs(`${drive}\\`);
        return { drive, total: s.blocks * s.bsize, free: s.bavail * s.bsize };
      } catch {
        return null;
      }
    }),
  );
  return {
    cpu: cpuUsage(),
    memory: { total, used: total - os.freemem() },
    disks: disks.filter(Boolean),
    uptime: os.uptime(),
  };
}

async function relaunchAsAdmin() {
  // In development the app path must be passed explicitly, since the elevated process starts in System32.
  const args = app.isPackaged ? process.argv.slice(1) : [app.getAppPath()];
  let command = `Start-Process -FilePath ${psString(process.execPath)} -Verb RunAs`;
  if (args.length) command += ` -ArgumentList ${psString(args.map((a) => `"${a}"`).join(' '))}`;
  try {
    await runPowerShell(command);
  } catch {
    throw new Error('A elevação foi cancelada.');
  }
}

module.exports = { isAdmin, getInfo, getStats, relaunchAsAdmin };
