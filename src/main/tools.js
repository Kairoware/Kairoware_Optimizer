const { spawn } = require('node:child_process');
const { run, runPowerShell } = require('./powershell');
const { isAdmin } = require('./system');

const ULTIMATE_PERFORMANCE = 'e9a42b02-d5df-448d-aa00-03f14749eb61';
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireAdmin() {
  if (!(await isAdmin())) throw new Error('Esta ferramenta requer executar o programa como administrador.');
}

async function flushDns() {
  await run('ipconfig', ['/flushdns']);
  return 'Cache DNS limpo.';
}

// Win32_PowerPlan requires admin on recent builds, so parse powercfg instead. Running it through
// PowerShell (whose console is switched to UTF-8) keeps accented plan names intact.
async function listPowerPlans() {
  const out = await runPowerShell('powercfg /list');
  return [...out.matchAll(/([0-9a-f]{8}-[0-9a-f-]{27})\s+\((.+)\)(\s*\*)?/gi)].map((m) => ({
    guid: m[1],
    name: m[2],
    active: Boolean(m[3]),
  }));
}

async function setPowerPlan(guid) {
  if (!GUID_PATTERN.test(guid)) throw new Error('Plano de energia inválido.');
  await run('powercfg', ['/setactive', guid]);
  return 'Plano de energia aplicado.';
}

async function enableUltimatePerformance() {
  const plans = await listPowerPlans();
  if (!plans.some((p) => p.guid.toLowerCase() === ULTIMATE_PERFORMANCE)) {
    // Duplicating the hidden scheme onto its own GUID unlocks it without creating extra copies.
    await run('powercfg', ['-duplicatescheme', ULTIMATE_PERFORMANCE, ULTIMATE_PERFORMANCE]);
  }
  await run('powercfg', ['/setactive', ULTIMATE_PERFORMANCE]);
  return 'Plano Desempenho Máximo ativado.';
}

async function createRestorePoint() {
  await requireAdmin();
  await runPowerShell("Checkpoint-Computer -Description 'Kairoware XP' -RestorePointType 'MODIFY_SETTINGS'", {
    timeout: 10 * 60_000,
  });
  return 'Ponto de restauração solicitado (o Windows cria no máximo um a cada 24 horas).';
}

async function restartExplorer() {
  await runPowerShell(`
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }`);
  return 'Windows Explorer reiniciado.';
}

async function optimizeDrive() {
  await requireAdmin();
  const letter = (process.env.SystemDrive || 'C:').charAt(0);
  await runPowerShell(`Optimize-Volume -DriveLetter ${letter}`, { timeout: 2 * 60 * 60_000 });
  return `Unidade ${letter}: otimizada (TRIM em SSD, desfragmentação em HD).`;
}

async function openDiskCleanup() {
  spawn('cleanmgr.exe', [], { detached: true, stdio: 'ignore' }).unref();
  return 'Limpeza de Disco do Windows aberta.';
}

async function runSfc() {
  try {
    await runPowerShell("Start-Process cmd.exe -ArgumentList '/k sfc /scannow' -Verb RunAs");
  } catch {
    throw new Error('A elevação foi cancelada.');
  }
  return 'Verificação de arquivos do sistema iniciada em uma nova janela.';
}

module.exports = {
  flushDns,
  listPowerPlans,
  setPowerPlan,
  enableUltimatePerformance,
  createRestorePoint,
  restartExplorer,
  optimizeDrive,
  openDiskCleanup,
  runSfc,
};
