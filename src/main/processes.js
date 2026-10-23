const path = require('node:path');
const { runPowerShell, runPowerShellJson, psString, toArray } = require('./powershell');

const PROTECTED = new Set([
  'system', 'idle', 'registry', 'secure system', 'memory compression', 'smss', 'csrss', 'wininit',
  'winlogon', 'services', 'lsass', 'lsaiso', 'svchost', 'dwm', 'fontdrvhost', 'sihost', 'ctfmon',
  path.parse(process.execPath).name.toLowerCase(),
]);

// Processes are grouped by name, so a browser with 30 child processes shows up as a single entry.
async function list() {
  const raw = toArray(
    await runPowerShellJson(
      "ConvertTo-Json -Compress -InputObject @(Get-Process | Select-Object @{n='pid';e={$_.Id}}, @{n='name';e={$_.ProcessName}}, @{n='memory';e={$_.WorkingSet64}}, @{n='description';e={$_.Description}})",
    ),
  );

  const groups = new Map();
  for (const p of raw) {
    const key = p.name.toLowerCase();
    const group = groups.get(key) ?? { name: p.name, description: '', memory: 0, pids: [] };
    group.memory += p.memory || 0;
    group.pids.push(p.pid);
    if (!group.description && p.description) group.description = p.description;
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((g) => ({ ...g, count: g.pids.length, protected: PROTECTED.has(g.name.toLowerCase()) }))
    .sort((a, b) => b.memory - a.memory)
    .slice(0, 50);
}

async function kill(name, pids) {
  if (typeof name !== 'string' || PROTECTED.has(name.toLowerCase())) {
    throw new Error('Este processo é essencial e não pode ser finalizado.');
  }
  const ids = toArray(pids).filter((pid) => Number.isInteger(pid) && pid > 0);
  if (!ids.length) throw new Error('Nenhum processo para finalizar.');

  // Only stop processes that still carry the same name, in case a PID was reused.
  try {
    await runPowerShell(
      `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq ${psString(name)} } | Stop-Process -Force`,
    );
  } catch {
    throw new Error('Acesso negado. Tente executar como administrador.');
  }
}

module.exports = { list, kill };
