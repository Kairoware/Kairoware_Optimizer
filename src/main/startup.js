const { runPowerShell, runPowerShellJson, psString, toArray } = require('./powershell');

// Startup entries are enabled/disabled the same way Task Manager does it: through the StartupApproved keys,
// so the original entry is never deleted and the change is fully reversible.
const APPROVED_KEYS = {
  'hkcu-run': ['CurrentUser', 'Run'],
  'hklm-run': ['LocalMachine', 'Run'],
  'hklm-run32': ['LocalMachine', 'Run32'],
  'user-folder': ['CurrentUser', 'StartupFolder'],
  'common-folder': ['LocalMachine', 'StartupFolder'],
};

const LIST_SCRIPT = `
$base = 'Software\\Microsoft\\Windows\\CurrentVersion'
function Test-Enabled($hive, $sub, $name) {
  try {
    $k = $hive.OpenSubKey("$base\\Explorer\\StartupApproved\\$sub")
    if ($k) {
      $v = $k.GetValue($name)
      $k.Close()
      if ($v -is [byte[]] -and $v.Length -gt 0) { return ($v[0] % 2) -eq 0 }
    }
  } catch {}
  return $true
}
$items = New-Object System.Collections.ArrayList
$cu = [Microsoft.Win32.Registry]::CurrentUser
$lm = [Microsoft.Win32.Registry]::LocalMachine
$registrySources = @(
  @{ id = 'hkcu-run'; hive = $cu; path = "$base\\Run"; sub = 'Run'; label = 'Registro (usuário)' },
  @{ id = 'hklm-run'; hive = $lm; path = "$base\\Run"; sub = 'Run'; label = 'Registro (todos)' },
  @{ id = 'hklm-run32'; hive = $lm; path = 'Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'; sub = 'Run32'; label = 'Registro (todos, 32 bits)' }
)
foreach ($s in $registrySources) {
  $k = $s.hive.OpenSubKey($s.path)
  if (-not $k) { continue }
  foreach ($name in $k.GetValueNames()) {
    if (-not $name) { continue }
    [void]$items.Add([pscustomobject]@{
      source = $s.id; name = $name; command = [string]$k.GetValue($name)
      location = $s.label; enabled = (Test-Enabled $s.hive $s.sub $name)
    })
  }
  $k.Close()
}
$folderSources = @(
  @{ id = 'user-folder'; hive = $cu; dir = [Environment]::GetFolderPath('Startup'); label = 'Pasta Inicializar (usuário)' },
  @{ id = 'common-folder'; hive = $lm; dir = [Environment]::GetFolderPath('CommonStartup'); label = 'Pasta Inicializar (todos)' }
)
foreach ($s in $folderSources) {
  if (-not $s.dir -or -not (Test-Path -LiteralPath $s.dir)) { continue }
  foreach ($f in Get-ChildItem -LiteralPath $s.dir -File -Force) {
    if ($f.Name -ieq 'desktop.ini') { continue }
    [void]$items.Add([pscustomobject]@{
      source = $s.id; name = $f.Name; command = $f.FullName
      location = $s.label; enabled = (Test-Enabled $s.hive 'StartupFolder' $f.Name)
    })
  }
}
ConvertTo-Json -Compress -InputObject @($items)`;

async function list() {
  return toArray(await runPowerShellJson(LIST_SCRIPT));
}

async function setEnabled(source, name, enabled) {
  const key = APPROVED_KEYS[source];
  if (!key || typeof name !== 'string' || !name) throw new Error('Item de inicialização inválido.');
  const [hive, sub] = key;
  try {
    await runPowerShell(`
$k = [Microsoft.Win32.Registry]::${hive}.CreateSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\${sub}')
$bytes = [byte[]](@(${enabled ? 2 : 3}) + @(0) * 11)
$k.SetValue(${psString(name)}, $bytes, [Microsoft.Win32.RegistryValueKind]::Binary)
$k.Close()`);
  } catch (err) {
    if (hive === 'LocalMachine') throw new Error('Este item vale para todos os usuários e requer administrador.');
    throw err;
  }
}

module.exports = { list, setEnabled };
