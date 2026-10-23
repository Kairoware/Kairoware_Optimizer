const { execFile } = require('node:child_process');

const PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '',
].join('\n');

// PowerShell writes errors as CLIXML when its output is redirected; pull out the readable message.
function cleanError(stderr = '') {
  let text = stderr;
  if (text.startsWith('#< CLIXML')) {
    text = [...text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
      .map((m) => m[1])
      .join('')
      .replace(/_x000D__x000A_/g, '\n')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function run(file, args = [], { timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(cleanError(stderr) || cleanError(stdout) || err.message));
      resolve(stdout.trim());
    });
  });
}

function runPowerShell(script, options) {
  const encoded = Buffer.from(PRELUDE + script, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], options);
}

async function runPowerShellJson(script, options) {
  const out = await runPowerShell(script, options);
  return out ? JSON.parse(out) : null;
}

// Quote a value as a PowerShell single-quoted string literal (PowerShell also treats curly quotes as quotes).
function psString(value) {
  return `'${String(value).replace(/['‘’‚‛]/g, "''")}'`;
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

module.exports = { run, runPowerShell, runPowerShellJson, psString, toArray };
