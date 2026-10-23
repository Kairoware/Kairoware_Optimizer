'use strict';

const api = window.kairo;
const $ = (selector) => document.querySelector(selector);

let isAdmin = false;
let systemDrive = 'C:';
let statsTimer = null;
let scanResults = [];
let startupItems = [];
let processList = [];
const loadedPages = new Set();

// ---------- Helpers ----------

async function call(method, ...args) {
  const res = await api[method](...args);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value === 'boolean') node[key] = value;
    else if (value != null && value !== false) node.setAttribute(key, value);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0).replace('.', ',')} ${units[i]}`;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h ${m}min` : `${h}h ${m}min`;
}

function level(percent) {
  return percent >= 90 ? 'danger' : percent >= 75 ? 'warn' : '';
}

function bar(percent, { alert = true } = {}) {
  const fill = el('span');
  fill.style.width = `${Math.min(100, percent)}%`;
  return el('div', { class: `bar ${alert ? level(percent) : ''}` }, fill);
}

function toast(message, type = 'success') {
  const node = el('div', { class: `toast ${type}` }, message);
  $('#toasts').append(node);
  setTimeout(() => node.classList.add('hide'), 4500);
  setTimeout(() => node.remove(), 5000);
}

async function withBusy(button, label, task) {
  const original = button.textContent;
  button.disabled = true;
  button.classList.add('loading');
  button.textContent = label;
  try {
    return await task();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
    button.textContent = original;
  }
}

const sum = (items, key) => items.reduce((total, item) => total + (item[key] || 0), 0);

// ---------- Navigation ----------

const pageLoaders = {
  dashboard: loadDashboard,
  cleaner: () => scan($('#scan-btn')),
  startup: loadStartup,
  processes: loadProcesses,
  tools: loadPowerPlans,
  settings: loadSettings,
};

function showPage(name) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${name}`));
  document.querySelector('main').scrollTop = 0;

  if (name === 'dashboard') startStats();
  else stopStats();

  if (!loadedPages.has(name)) {
    loadedPages.add(name);
    pageLoaders[name]();
  }
}

// ---------- Admin ----------

function renderAdminBox() {
  const box = $('#admin-box');
  if (isAdmin) {
    box.replaceChildren(
      el('div', { class: 'status' }, el('span', { class: 'dot on' }), 'Administrador'),
      el('p', {}, 'Todas as ferramentas estão disponíveis.'),
    );
    return;
  }
  const button = el('button', { class: 'btn small' }, 'Executar como admin');
  button.addEventListener('click', () => withBusy(button, 'Aguardando…', () => call('relaunchAsAdmin')));
  box.replaceChildren(
    el('div', { class: 'status' }, el('span', { class: 'dot' }), 'Modo limitado'),
    el('p', {}, 'Algumas limpezas e ferramentas precisam de privilégios de administrador.'),
    button,
  );
}

// ---------- Dashboard ----------

async function loadDashboard() {
  try {
    const info = await call('getSystemInfo');
    systemDrive = info.systemDrive;
    const rows = [
      ['Computador', info.hostname],
      ['Sistema', `${info.os} (build ${info.build})`],
      ['Processador', `${info.cpu} · ${info.cores} threads`],
      ['Placa de vídeo', info.gpu.join(', ') || '—'],
      ['Memória', formatBytes(info.totalMemory)],
    ];
    $('#system-info').replaceChildren(
      ...rows.flatMap(([label, value]) => [el('dt', {}, label), el('dd', {}, value)]),
      el('dt', {}, 'Ligado há'),
      el('dd', { id: 'uptime' }, '—'),
    );
    refreshStats();
  } catch (err) {
    toast(`Não foi possível ler as informações do sistema: ${err.message}`, 'error');
  }
}

function setGauge(id, percent, detail) {
  const gauge = $(`#gauge-${id}`);
  gauge.style.setProperty('--value', percent.toFixed(1));
  gauge.className = `gauge ${level(percent)}`;
  gauge.querySelector('span').textContent = `${Math.round(percent)}%`;
  $(`#gauge-${id}-detail`).textContent = detail;
}

async function refreshStats() {
  if (document.hidden) return;
  try {
    const stats = await call('getStats');
    setGauge('cpu', stats.cpu, `${Math.round(stats.cpu)}% em uso`);
    setGauge('ram', (stats.memory.used / stats.memory.total) * 100,
      `${formatBytes(stats.memory.used)} de ${formatBytes(stats.memory.total)}`);

    const disk = stats.disks.find((d) => d.drive.toUpperCase() === systemDrive) || stats.disks[0];
    if (disk) {
      setGauge('disk', ((disk.total - disk.free) / disk.total) * 100, `${formatBytes(disk.free)} livres em ${disk.drive}`);
    }

    $('#disk-list').replaceChildren(
      ...stats.disks.map((d) => {
        const used = d.total - d.free;
        return el('div', { class: 'disk' },
          el('div', { class: 'disk-head' },
            el('strong', {}, `Unidade ${d.drive}`),
            el('span', {}, `${formatBytes(d.free)} livres de ${formatBytes(d.total)}`)),
          bar((used / d.total) * 100));
      }),
    );

    const uptime = $('#uptime');
    if (uptime) uptime.textContent = formatUptime(stats.uptime);
  } catch {
    // Transient failure; next tick will retry.
  }
}

function startStats() {
  if (statsTimer) return;
  refreshStats();
  statsTimer = setInterval(refreshStats, 2000);
}

function stopStats() {
  clearInterval(statsTimer);
  statsTimer = null;
}

async function quickOptimize(button) {
  await withBusy(button, 'Otimizando…', async () => {
    const ids = ['user-temp', 'crash-dumps', 'thumbnails', ...(isAdmin ? ['windows-temp'] : [])];
    const results = await call('cleanCategories', ids);
    await call('flushDns').catch(() => {});
    toast(`Otimização concluída: ${formatBytes(sum(results, 'freed'))} liberados e cache DNS limpo.`);
    loadedPages.delete('cleaner');
  });
}

// ---------- Cleaner ----------

async function scan(button) {
  $('#clean-list').replaceChildren(el('div', { class: 'empty' }, 'Analisando arquivos…'));
  await withBusy(button, 'Analisando…', async () => {
    scanResults = await call('scanCleaner');
    renderCleanList();
  });
  updateCleanSummary();
}

function renderCleanList() {
  $('#clean-list').replaceChildren(
    ...scanResults.map((c) =>
      el('label', { class: 'clean-item' },
        el('input', {
          type: 'checkbox',
          value: c.id,
          checked: c.size > 0 && c.id !== 'recycle-bin' && (!c.admin || isAdmin),
          onchange: updateCleanSummary,
        }),
        el('div', { class: 'clean-text' },
          el('strong', {}, c.name, c.admin && !isAdmin ? el('span', { class: 'tag' }, 'Admin') : null),
          el('small', {}, c.description)),
        el('span', { class: 'size' }, formatBytes(c.size)))),
  );
  updateCleanSummary();
}

function selectedCategories() {
  return [...document.querySelectorAll('#clean-list input:checked')].map((input) => input.value);
}

function updateCleanSummary() {
  const ids = selectedCategories();
  $('#clean-total').textContent = formatBytes(sum(scanResults.filter((c) => ids.includes(c.id)), 'size'));
  $('#clean-btn').disabled = ids.length === 0;
}

async function clean(button) {
  const ids = selectedCategories();
  if (ids.includes('recycle-bin') && !confirm('A Lixeira será esvaziada permanentemente. Deseja continuar?')) return;

  await withBusy(button, 'Limpando…', async () => {
    const results = await call('cleanCategories', ids);
    const failed = sum(results, 'failed');
    toast(`${formatBytes(sum(results, 'freed'))} liberados.` +
      (failed ? ` ${failed} arquivo(s) em uso ou protegidos foram mantidos.` : ''));
    scanResults = await call('scanCleaner');
    renderCleanList();
  });
  updateCleanSummary();
}

// ---------- Startup ----------

function startupDisplayName(item) {
  return item.source.endsWith('folder') ? item.name.replace(/\.(lnk|url|bat|cmd)$/i, '') : item.name;
}

function updateStartupCount() {
  const enabled = startupItems.filter((i) => i.enabled).length;
  $('#startup-count').textContent = startupItems.length ? `(${enabled} de ${startupItems.length} ativados)` : '';
}

async function loadStartup() {
  const list = $('#startup-list');
  list.replaceChildren(el('div', { class: 'empty' }, 'Carregando…'));
  try {
    startupItems = (await call('listStartup')).sort((a, b) =>
      startupDisplayName(a).localeCompare(startupDisplayName(b), 'pt-BR'));
    updateStartupCount();
    if (!startupItems.length) {
      list.replaceChildren(el('div', { class: 'empty' }, 'Nenhum programa de inicialização encontrado.'));
      return;
    }
    list.replaceChildren(...startupItems.map(renderStartupItem));
  } catch (err) {
    list.replaceChildren(el('div', { class: 'empty' }, err.message));
  }
}

function renderStartupItem(item) {
  const name = startupDisplayName(item);
  const input = el('input', { type: 'checkbox', checked: item.enabled });
  input.addEventListener('change', async () => {
    input.disabled = true;
    try {
      await call('setStartupEnabled', item.source, item.name, input.checked);
      item.enabled = input.checked;
      updateStartupCount();
      toast(`${name} ${item.enabled ? 'ativado' : 'desativado'} na inicialização.`);
    } catch (err) {
      input.checked = !input.checked;
      toast(err.message, 'error');
    } finally {
      input.disabled = false;
    }
  });

  return el('div', { class: 'row' },
    el('div', { class: 'row-main' },
      el('strong', {}, name),
      el('code', { title: item.command }, item.command)),
    el('span', { class: 'tag muted' }, item.location),
    el('label', { class: 'switch', title: item.enabled ? 'Desativar' : 'Ativar' }, input, el('span', { class: 'slider' })));
}

// ---------- Processes ----------

async function loadProcesses() {
  const list = $('#process-list');
  if (!processList.length) list.replaceChildren(el('div', { class: 'empty' }, 'Carregando…'));
  try {
    processList = await call('listProcesses');
    renderProcesses();
  } catch (err) {
    list.replaceChildren(el('div', { class: 'empty' }, err.message));
  }
}

function renderProcesses() {
  const filter = $('#process-filter').value.trim().toLowerCase();
  const rows = processList.filter((p) =>
    !filter || p.name.toLowerCase().includes(filter) || p.description.toLowerCase().includes(filter));
  const max = Math.max(1, ...processList.map((p) => p.memory));

  if (!rows.length) {
    $('#process-list').replaceChildren(el('div', { class: 'empty' }, 'Nenhum processo encontrado.'));
    return;
  }

  $('#process-list').replaceChildren(
    ...rows.map((p) => {
      const button = el('button', {
        class: 'btn small danger',
        disabled: p.protected,
        title: p.protected ? 'Processo essencial do sistema' : null,
      }, 'Finalizar');
      button.addEventListener('click', () => killProcess(p, button));

      return el('div', { class: 'row' },
        el('div', { class: 'row-main' },
          el('strong', {}, p.description || p.name),
          el('small', {}, `${p.name}.exe${p.count > 1 ? ` · ${p.count} processos` : ''}`)),
        bar((p.memory / max) * 100, { alert: false }),
        el('span', { class: 'size' }, formatBytes(p.memory)),
        button);
    }),
  );
}

async function killProcess(proc, button) {
  const label = proc.description || proc.name;
  if (!confirm(`Finalizar "${label}"?\nTrabalhos não salvos nesse programa serão perdidos.`)) return;
  await withBusy(button, 'Finalizando…', async () => {
    await call('killProcess', proc.name, proc.pids);
    toast(`${label} finalizado.`);
    await loadProcesses();
  });
}

// ---------- Tools ----------

async function loadPowerPlans() {
  try {
    const plans = await call('listPowerPlans');
    $('#power-select').replaceChildren(
      ...plans.map((p) => el('option', { value: p.guid, selected: p.active }, p.active ? `${p.name} (ativo)` : p.name)),
    );
  } catch (err) {
    toast(`Não foi possível ler os planos de energia: ${err.message}`, 'error');
  }
}

const toolActions = {
  'flush-dns': () => call('flushDns'),
  ultimate: async () => {
    const message = await call('enableUltimatePerformance');
    await loadPowerPlans();
    return message;
  },
  'restore-point': () => call('createRestorePoint'),
  'optimize-drive': () => call('optimizeDrive'),
  'restart-explorer': () => call('restartExplorer'),
  sfc: () => call('runSfc'),
  'disk-cleanup': () => call('openDiskCleanup'),
};

// ---------- Settings ----------

function renderStartup(state) {
  $('#set-startup').checked = state.enabled;
  $('#set-startup-bp').checked = state.enabled && state.bigPicture;
  $('#set-startup-bp').disabled = !state.enabled;
}

async function loadSettings() {
  try {
    renderStartup(await call('getStartup'));
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function saveStartup() {
  const enabled = $('#set-startup').checked;
  const bigPicture = $('#set-startup-bp').checked;
  try {
    const state = await call('setStartup', { enabled, bigPicture });
    renderStartup(state);
    if (!state.enabled) toast('O Kairoware XP não vai mais abrir com o Windows.');
    else toast(state.bigPicture ? 'O Kairoware XP vai abrir no modo Big Picture com o Windows.' : 'O Kairoware XP vai abrir com o Windows.');
  } catch (err) {
    toast(err.message, 'error');
    loadSettings();
  }
}

// ---------- Init ----------

async function init() {
  document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));

  $('#open-bp').addEventListener('click', () => call('openBigPicture').catch((err) => toast(err.message, 'error')));
  $('#quick-optimize').addEventListener('click', (e) => quickOptimize(e.currentTarget));
  $('#scan-btn').addEventListener('click', (e) => scan(e.currentTarget));
  $('#clean-btn').addEventListener('click', (e) => clean(e.currentTarget));
  $('#startup-refresh').addEventListener('click', loadStartup);
  $('#process-refresh').addEventListener('click', loadProcesses);
  $('#process-filter').addEventListener('input', renderProcesses);

  $('#power-apply').addEventListener('click', (e) =>
    withBusy(e.currentTarget, 'Aplicando…', async () => {
      toast(await call('setPowerPlan', $('#power-select').value));
      await loadPowerPlans();
    }));

  $('#set-startup').addEventListener('change', saveStartup);
  $('#set-startup-bp').addEventListener('change', saveStartup);
  document.querySelectorAll('[data-shortcut]').forEach((button) =>
    button.addEventListener('click', () =>
      withBusy(button, 'Criando…', async () => toast(await call('createShortcut', button.dataset.shortcut)))));

  document.querySelectorAll('[data-tool]').forEach((button) =>
    button.addEventListener('click', () =>
      withBusy(button, 'Executando…', async () => toast(await toolActions[button.dataset.tool]()))));

  isAdmin = await call('isAdmin').catch(() => false);
  renderAdminBox();
  showPage('dashboard');
}

init();
