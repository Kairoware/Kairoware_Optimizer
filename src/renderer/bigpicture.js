'use strict';

const api = window.kairo;
const $ = (selector) => document.querySelector(selector);

const TABS = [
  { id: 'all', label: 'Biblioteca', filter: (g) => g.source !== 'app' },
  { id: 'apps', label: 'Apps', filter: (g) => g.source === 'app', keepOrder: true },
  { id: 'fav', label: 'Favoritos', filter: (g) => g.favorite },
  { id: 'steam', label: 'Steam', filter: (g) => g.source === 'steam' },
  { id: 'xbox', label: 'Xbox', filter: (g) => g.source === 'xbox' },
  { id: 'epic', label: 'Epic Games', filter: (g) => g.source === 'epic' },
  { id: 'gog', label: 'GOG', filter: (g) => g.source === 'gog' },
  { id: 'custom', label: 'Adicionados', filter: (g) => g.source === 'custom' },
];

const SOURCE_LABELS = {
  steam: 'Steam', xbox: 'Xbox', epic: 'Epic Games', gog: 'GOG', custom: 'Adicionado por você', app: 'App',
};

const KEYS = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Enter: 'confirm', ' ': 'confirm', Escape: 'back', Backspace: 'back',
  o: 'options', f: 'favorite', m: 'menu', q: 'prevTab', e: 'nextTab', PageUp: 'prevTab', PageDown: 'nextTab',
  '/': 'view', '-': 'lt', '+': 'rt', '=': 'rt', b: 'ls',
};

let installedApps = [];
let startupBigPicture = false;
let games = [];
let shown = [];
let visibleTabs = [];
let tabId = 'all';
let searchQuery = '';
let focusIndex = 0;
let inputMode = 'keyboard';
let menu = null;
let gameModeActive = false;
let bgLayer = 0;
let bgTimer = null;
let launchTimer = null;
let audio = null;

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

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 3_600_000) return 'há poucos minutos';
  if (diff < 86_400_000) return `há ${Math.floor(diff / 3_600_000)} h`;
  const days = Math.floor(diff / 86_400_000);
  if (days === 1) return 'ontem';
  if (days < 30) return `há ${days} dias`;
  return `em ${new Date(ts).toLocaleDateString('pt-BR')}`;
}

function hue(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

// Hue of a #rrggbb colour, used to tint the backdrop behind apps.
function appHue(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return 250;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round(h * 60 + 360) % 360;
}

const normalize = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function blip(freq = 640, duration = 0.05, volume = 0.035) {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + duration);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + duration);
  } catch {
    // Audio is optional.
  }
}

// Console-style power-on chime: a soft pad plus a rising arpeggio.
function bootSound() {
  try {
    audio ??= new AudioContext();
    const now = audio.currentTime;
    const notes = [[196, 0, 2.4, 0.03], [392, 0.15, 1.6, 0.035], [523.25, 0.3, 1.5, 0.035], [659.25, 0.45, 1.5, 0.03], [783.99, 0.6, 1.8, 0.03]];
    for (const [freq, start, length, volume] of notes) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = freq < 300 ? 'triangle' : 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(volume, now + start + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + length);
      osc.connect(gain).connect(audio.destination);
      osc.start(now + start);
      osc.stop(now + start + length);
    }
  } catch {
    // Audio is optional.
  }
}

const BOOT_MIN_MS = 2600;
const bootStarted = performance.now();

function finishBoot() {
  const remaining = Math.max(0, BOOT_MIN_MS - (performance.now() - bootStarted));
  setTimeout(() => {
    $('#boot').classList.add('done');
    document.body.classList.remove('booting');
    document.body.classList.add('booted');
    setTimeout(() => $('#boot').remove(), 800);
  }, remaining);
}

const isBooting = () => document.body.classList.contains('booting');

function toast(message, type = 'success') {
  const node = el('div', { class: `bp-toast ${type}` }, message);
  $('#bp-toasts').append(node);
  setTimeout(() => node.classList.add('hide'), 3500);
  setTimeout(() => node.remove(), 4000);
}

const focusedGame = () => shown[focusIndex];
const glyphMode = () => (inputMode === 'gamepad' ? Controller.type : 'keyboard');

// ---------- Layers ----------

// The topmost open layer receives input: keyboard > menu > launch screen > browser > library.
function activeLayer() {
  if (VirtualKeyboard.isOpen()) return 'keyboard';
  if (menu) return 'menu';
  if ($('#launch-overlay').classList.contains('open')) return 'launch';
  if (Browser.isOpen()) return 'browser';
  if (AppStore.isOpen()) return 'store';
  return 'library';
}

function hintsFor(layer) {
  switch (layer) {
    case 'keyboard':
      return inputMode === 'gamepad'
        ? [['confirm', 'Digitar'], ['options', 'Apagar'], ['favorite', 'Espaço'], ['prevTab', 'Maiúsculas'],
          ['nextTab', 'Símbolos'], ['menu', 'Concluir'], ['back', 'Cancelar']]
        : [['confirm', 'Concluir'], ['back', 'Cancelar']];
    case 'menu':
      return [['confirm', 'Selecionar'], ['back', 'Voltar']];
    case 'launch':
      return [['back', 'Fechar']];
    case 'browser':
      return Browser.hints();
    case 'store':
      return AppStore.hints();
    default:
      return [
        ['confirm', focusedGame()?.source === 'app' ? 'Abrir' : 'Jogar'], ['options', 'Opções'], ['favorite', 'Favoritar'],
        ['view', 'Pesquisar'], ['ls', 'Navegador'], [['prevTab', 'nextTab'], 'Categorias'], ['menu', 'Menu'],
      ];
  }
}

function renderHints() {
  const mode = glyphMode();
  $('#hints').replaceChildren(
    ...hintsFor(activeLayer()).map(([actions, label]) =>
      el('span', { class: 'hint' },
        el('span', { class: 'keys' }, [actions].flat().map((action) => Controller.glyph(action, mode))),
        label)),
  );
}

// ---------- Library ----------

function byRecent(a, b) {
  return b.lastPlayed - a.lastPlayed || a.name.localeCompare(b.name, 'pt-BR');
}

function tabList() {
  if (!searchQuery) return TABS;
  const query = normalize(searchQuery);
  return [{ id: 'search', label: `Pesquisa: ${searchQuery}`, filter: (g) => normalize(g.name).includes(query) }, ...TABS];
}

// Apps tab: the built-in Navegador and Loja de apps, followed by apps installed from the store.
function appItems() {
  const apps = [...BUILTIN_APPS, ...APP_CATALOG.filter((a) => installedApps.includes(a.id))];
  return apps.map((app) => ({
    id: `app-${app.id}`,
    name: app.name,
    source: 'app',
    app,
    favorite: false,
    lastPlayed: 0,
  }));
}

async function loadGames(preferId = focusedGame()?.id) {
  const [library, apps] = await Promise.all([call('listGames'), call('listApps').catch(() => [])]);
  installedApps = apps;
  games = [...library, ...appItems()];
  renderTabs();
  renderGrid(preferId);
}

async function setAppInstalled(id, installed) {
  installedApps = await call('setAppInstalled', id, installed);
  games = [...games.filter((g) => g.source !== 'app'), ...appItems()];
  renderTabs();
  renderGrid(focusedGame()?.id);
}

function openApp(app) {
  if (app.id === 'browser') Browser.open();
  else if (app.id === 'store') AppStore.open();
  else Browser.openApp(app);
}

function renderTabs() {
  visibleTabs = tabList().filter((t) => ['all', 'apps', 'search'].includes(t.id) || games.some(t.filter));
  if (!visibleTabs.some((t) => t.id === tabId)) tabId = 'all';
  $('#tabs').replaceChildren(
    ...visibleTabs.map((t) =>
      el('button', { class: `tab${t.id === tabId ? ' active' : ''}`, onclick: () => selectTab(t.id) }, t.label)),
  );
}

function selectTab(id) {
  if (id === tabId) return;
  tabId = id;
  blip(520);
  renderTabs();
  renderGrid();
}

function cycleTab(step) {
  const index = visibleTabs.findIndex((t) => t.id === tabId);
  selectTab(visibleTabs[(index + step + visibleTabs.length) % visibleTabs.length].id);
}

function applySearch(text) {
  searchQuery = text.trim();
  tabId = searchQuery ? 'search' : 'all';
  renderTabs();
  renderGrid();
}

async function openSearch() {
  const previous = searchQuery;
  const result = await VirtualKeyboard.open({
    title: 'Pesquisar na biblioteca',
    value: searchQuery,
    placeholder: 'Nome do jogo',
    doneLabel: 'Pesquisar',
    onChange: applySearch,
  });
  if (result === null) applySearch(previous);
}

function placeholder(game) {
  const node = el('div', { class: 'placeholder' });
  node.style.setProperty('--hue', hue(game.name));
  if (game.icon) {
    const icon = el('img', { class: 'icon', alt: '', src: game.icon });
    icon.addEventListener('error', () => icon.remove());
    node.append(icon);
  }
  node.append(el('span', {}, game.name));
  return node;
}

function appTile(app) {
  const node = el('div', { class: 'app-tile' }, el('span', { class: 'app-glyph' }, app.glyph), el('span', { class: 'app-name' }, app.name));
  node.style.setProperty('--c', app.color);
  return node;
}

function artwork(game, container) {
  if (game.app) {
    container.append(appTile(game.app));
    return container;
  }
  container.append(placeholder(game));
  if (game.cover) {
    const img = el('img', { class: 'cover', alt: '', src: game.cover });
    img.addEventListener('load', () => container.classList.add('has-cover'));
    img.addEventListener('error', () => img.remove());
    container.append(img);
  }
  return container;
}

function renderGrid(preferId) {
  const tab = visibleTabs.find((t) => t.id === tabId) ?? TABS[0];
  shown = games.filter(tab.filter);
  if (!tab.keepOrder) shown.sort(byRecent);

  if (!shown.length) {
    const message = tabId === 'search'
      ? 'Nenhum jogo corresponde à pesquisa.'
      : 'Nenhum jogo encontrado. Abra o Menu para adicionar um jogo.';
    $('#grid').replaceChildren(el('div', { class: 'empty' }, message));
    focusIndex = 0;
    updateHero(null);
    return;
  }

  $('#grid').replaceChildren(
    ...shown.map((game, index) => {
      const tile = el('button', {
        class: `tile${game.favorite ? ' favorite' : ''}`,
        tabindex: '-1',
        onclick: () => setFocus(index),
        ondblclick: () => launch(game),
      });
      artwork(game, tile).append(el('span', { class: 'fav' }, '★'));
      return tile;
    }),
  );

  const index = shown.findIndex((g) => g.id === preferId);
  setFocus(Math.max(0, index), { instant: true });
}

function setFocus(index, { instant = false } = {}) {
  const tiles = $('#grid').querySelectorAll('.tile');
  if (!tiles.length) return;
  focusIndex = Math.max(0, Math.min(index, tiles.length - 1));
  tiles.forEach((tile, i) => tile.classList.toggle('focused', i === focusIndex));
  tiles[focusIndex].scrollIntoView({ block: 'nearest', behavior: instant ? 'auto' : 'smooth' });
  updateHero(focusedGame());
}

function columns() {
  const tiles = $('#grid').children;
  if (!tiles.length) return 1;
  const top = tiles[0].offsetTop;
  let count = 0;
  for (const tile of tiles) {
    if (tile.offsetTop !== top) break;
    count++;
  }
  return count || 1;
}

function move(direction) {
  if (!shown.length) return;
  const cols = columns();
  const col = focusIndex % cols;
  let next = focusIndex + { left: -1, right: 1, up: -cols, down: cols }[direction];

  if ((direction === 'left' && col === 0) || (direction === 'right' && col === cols - 1)) return;
  // Moving down into a shorter last row lands on its last tile.
  if (direction === 'down' && next >= shown.length) {
    if (Math.floor(focusIndex / cols) === Math.floor((shown.length - 1) / cols)) return;
    next = shown.length - 1;
  }
  if (next < 0 || next >= shown.length) return;

  blip();
  setFocus(next);
}

// ---------- Hero & backdrop ----------

function updateHero(game) {
  $('#hero-title').textContent = game?.name ?? (games.length ? 'Nenhum jogo encontrado' : 'Sua biblioteca está vazia');
  $('#hero-source').textContent = game ? SOURCE_LABELS[game.source] : '';
  $('#hero-fav').hidden = !game?.favorite;
  $('#hero-play').hidden = !game;
  $('#hero-play').textContent = game?.app ? '▶  Abrir' : '▶  Jogar';
  if (game?.app) $('#hero-sub').textContent = game.app.description;
  else if (game) $('#hero-sub').textContent = game.lastPlayed ? `Jogado ${relativeTime(game.lastPlayed)}` : 'Ainda não jogado pelo Kairoware XP';
  else $('#hero-sub').textContent = '';
  renderHints();

  clearTimeout(bgTimer);
  bgTimer = setTimeout(() => setBackground(game), 160);
}

function setBackground(game) {
  const sources = game ? [game.hero, game.cover].filter(Boolean) : [];

  const apply = (url, blurred) => {
    bgLayer = 1 - bgLayer;
    const next = $(bgLayer ? '#bg-b' : '#bg-a');
    const prev = $(bgLayer ? '#bg-a' : '#bg-b');
    next.style.backgroundImage = url ? `url("${url}")` : '';
    next.style.setProperty('--hue', game?.app ? appHue(game.app.color) : game ? hue(game.name) : 250);
    next.classList.toggle('blur', blurred);
    next.classList.add('visible');
    prev.classList.remove('visible');
  };

  const tryNext = (i) => {
    if (i >= sources.length) return apply(null, false);
    const img = new Image();
    img.onload = () => {
      if (focusedGame() === game) apply(sources[i], sources[i] !== game.hero);
    };
    img.onerror = () => tryNext(i + 1);
    img.src = sources[i];
  };
  tryNext(0);
}

// ---------- Actions ----------

function hideLaunch() {
  clearTimeout(launchTimer);
  $('#launch-overlay').classList.remove('open');
  renderHints();
}

async function launch(game) {
  if (!game) return;
  if (game.app) {
    blip(760, 0.08);
    openApp(game.app);
    return;
  }
  blip(880, 0.14, 0.05);
  Controller.rumble(0.45, 0.7, 220);
  $('#launch-title').textContent = game.name;
  $('#launch-art').replaceChildren();
  artwork(game, $('#launch-art'));
  $('#launch-overlay').classList.add('open');
  renderHints();
  clearTimeout(launchTimer);
  launchTimer = setTimeout(hideLaunch, 6000);

  try {
    await call('launchGame', game.id);
    game.lastPlayed = Date.now();
    updateHero(game);
  } catch (err) {
    hideLaunch();
    toast(err.message, 'error');
  }
}

async function toggleFavorite(game) {
  if (!game || game.app) return;
  try {
    await call('setFavorite', game.id, !game.favorite);
    game.favorite = !game.favorite;
    blip(game.favorite ? 760 : 420);
    toast(game.favorite ? `${game.name} adicionado aos favoritos.` : `${game.name} removido dos favoritos.`);

    if (tabId === 'fav' && !game.favorite) {
      const neighbor = shown[focusIndex + 1] ?? shown[focusIndex - 1];
      renderTabs();
      renderGrid(neighbor?.id);
    } else {
      renderTabs();
      $('#grid').children[focusIndex]?.classList.toggle('favorite', game.favorite);
      updateHero(game);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function addGame() {
  const id = await call('addGame');
  if (!id) return;
  tabId = 'all';
  await loadGames(id);
  toast('Jogo adicionado à biblioteca.');
}

async function removeGame(game) {
  await call('removeGame', game.id);
  await loadGames(shown[focusIndex + 1]?.id ?? shown[focusIndex - 1]?.id);
  toast(`${game.name} removido da biblioteca.`);
}

async function toggleGameMode() {
  const state = await call('setGameMode', !gameModeActive);
  gameModeActive = state.active;
  $('#gamemode-pill').classList.toggle('on', gameModeActive);
  toast(gameModeActive ? 'Modo Jogo ativado: plano de energia de alto desempenho.' : 'Modo Jogo desativado: plano de energia restaurado.');
}

async function quickOptimize() {
  toast('Otimizando…');
  const isAdmin = await call('isAdmin').catch(() => false);
  const ids = ['user-temp', 'crash-dumps', 'thumbnails', ...(isAdmin ? ['windows-temp'] : [])];
  const results = await call('cleanCategories', ids);
  await call('flushDns').catch(() => {});
  const freed = results.reduce((total, r) => total + r.freed, 0);
  toast(`Otimização concluída: ${formatBytes(freed)} liberados.`);
}

function releaseController() {
  Controller.setPassthrough(true);
  const mode = Controller.type;
  const combo = mode === 'playstation' ? `${Controller.name === 'DualShock 4' ? 'SHARE' : 'CREATE'} + OPTIONS` : 'Visualizar + Menu';
  toast(`O controle agora está com o site. Aperte ${combo} juntos para voltar ao Kairoware XP.`);
  renderHints();
}

function resumeController() {
  if (Controller.passthrough) Controller.setPassthrough(false);
}

async function toggleStartupBigPicture() {
  const state = await call('setStartup', { enabled: !startupBigPicture, bigPicture: true });
  startupBigPicture = state.enabled && state.bigPicture;
  toast(startupBigPicture
    ? 'O Kairoware XP vai abrir no modo Big Picture quando o Windows iniciar.'
    : 'O Kairoware XP não vai mais abrir com o Windows.');
}

// ---------- Menus ----------

function openMenu(title, items) {
  menu = { title, items, index: 0 };
  renderMenu();
  $('#menu-overlay').classList.add('open');
  renderHints();
  blip(520);
}

function closeMenu() {
  menu = null;
  $('#menu-overlay').classList.remove('open');
  renderHints();
}

function renderMenu() {
  $('#menu-title').textContent = menu.title;
  $('#menu-list').replaceChildren(
    ...menu.items.map((item, i) => {
      const label = typeof item.label === 'function' ? item.label() : item.label;
      return el('button', {
        class: `menu-item${i === menu.index ? ' focused' : ''}`,
        tabindex: '-1',
        onmouseenter: () => setMenuIndex(i),
        onclick: () => {
          setMenuIndex(i);
          runMenuItem();
        },
      }, label, item.detail ? el('small', {}, item.detail) : null);
    }),
  );
}

function setMenuIndex(index) {
  menu.index = (index + menu.items.length) % menu.items.length;
  [...$('#menu-list').children].forEach((node, i) => node.classList.toggle('focused', i === menu.index));
}

async function runMenuItem() {
  const item = menu.items[menu.index];
  blip(760, 0.08);
  if (!item.keepOpen) closeMenu();
  try {
    await item.run();
    if (menu && item.keepOpen) renderMenu();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openMainMenu() {
  openMenu('Menu', [
    {
      label: () => `Modo Jogo: ${gameModeActive ? 'ativado' : 'desativado'}`,
      detail: 'Usa o plano de energia de alto desempenho enquanto você joga.',
      keepOpen: true,
      run: toggleGameMode,
    },
    { label: 'Navegador da Web', detail: 'YouTube, Twitch, jogos na nuvem e qualquer site, tudo pelo controle.', run: () => Browser.open() },
    { label: 'Loja de apps', detail: 'YouTube TV, jogos na nuvem, música e mais.', run: () => AppStore.open() },
    {
      label: () => `Iniciar no Big Picture com o Windows: ${startupBigPicture ? 'sim' : 'não'}`,
      detail: 'Liga o PC direto na interface de console.',
      keepOpen: true,
      run: toggleStartupBigPicture,
    },
    { label: 'Pesquisar na biblioteca', detail: 'Encontre um jogo pelo nome usando o teclado virtual.', run: openSearch },
    { label: 'Otimização rápida', detail: 'Limpa arquivos temporários e o cache DNS.', run: quickOptimize },
    { label: 'Adicionar jogo', detail: 'Escolha o executável de um jogo instalado.', run: addGame },
    { label: 'Atualizar biblioteca', detail: 'Procura novamente jogos da Steam, Epic e GOG.', run: async () => {
      await loadGames();
      toast(`${games.length} jogos na biblioteca.`);
    } },
    { label: 'Voltar à área de trabalho', detail: 'Sai do Big Picture e abre o Kairoware XP.', run: () => call('closeBigPicture') },
    { label: 'Fechar o Kairoware XP', run: () => call('quitApp') },
  ]);
}

function openGameMenu(game) {
  if (!game) return;
  if (game.app) {
    const items = [{ label: 'Abrir', run: () => openApp(game.app) }];
    if (!game.app.builtin) items.push({ label: 'Desinstalar', run: () => setAppInstalled(game.app.id, false) });
    openMenu(game.name, items);
    return;
  }
  const items = [
    { label: 'Jogar', run: () => launch(game) },
    { label: game.favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos', run: () => toggleFavorite(game) },
    { label: 'Abrir pasta do jogo', run: () => call('openGameFolder', game.id) },
  ];
  if (game.removable) items.push({ label: 'Remover da biblioteca', run: () => removeGame(game) });
  openMenu(game.name, items);
}

// ---------- Input ----------

function dispatch(action, meta = {}) {
  if (isBooting()) return;
  switch (activeLayer()) {
    case 'keyboard':
      if (VirtualKeyboard.handleAction(action, meta)) blip();
      return;

    case 'launch':
      if (action === 'back' || action === 'confirm') hideLaunch();
      return;

    case 'menu':
      if (action === 'up' || action === 'down') {
        setMenuIndex(menu.index + (action === 'up' ? -1 : 1));
        blip();
      } else if (action === 'confirm') {
        runMenuItem();
      } else if (action === 'back' || action === 'menu' || action === 'home') {
        blip(420);
        closeMenu();
      }
      return;

    case 'browser':
      Browser.handleAction(action, meta);
      return;

    case 'store':
      AppStore.handleAction(action, meta);
      return;
  }

  switch (action) {
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      move(action);
      break;
    case 'confirm': launch(focusedGame()); break;
    case 'options': if (!meta.repeat) openGameMenu(focusedGame()); break;
    case 'favorite': toggleFavorite(focusedGame()); break;
    case 'view': openSearch(); break;
    case 'ls': Browser.open(); break;
    case 'menu':
    case 'home':
      openMainMenu();
      break;
    case 'prevTab': cycleTab(-1); break;
    case 'nextTab': cycleTab(1); break;
    case 'back':
      if (searchQuery) applySearch('');
      else if (tabId !== 'all') selectTab('all');
      break;
  }
}

function setInputMode(mode) {
  if (mode === inputMode) return;
  inputMode = mode;
  document.body.classList.toggle('gamepad', mode === 'gamepad');
  renderHints();
}

function onKey(event) {
  if (VirtualKeyboard.isOpen()) {
    setInputMode('keyboard');
    VirtualKeyboard.handleKey(event);
    return;
  }
  const action = KEYS[event.key] ?? KEYS[event.key.toLowerCase()];
  if (!action || event.altKey || event.ctrlKey) return;
  event.preventDefault();
  setInputMode('keyboard');
  if (event.repeat && !['up', 'down', 'left', 'right'].includes(action)) return;
  dispatch(action, { repeat: event.repeat });
}

function showController(info) {
  $('#controller-name').textContent = info.name;
  $('#controller-chip').hidden = false;
  setInputMode('gamepad');
  renderHints();
  toast(`${info.name} conectado`);
}

// ---------- Status bar ----------

function tickClock() {
  $('#clock').textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

async function refreshStats() {
  if (document.hidden) return;
  try {
    const stats = await call('getStats');
    $('#stat-cpu').textContent = `CPU ${Math.round(stats.cpu)}%`;
    $('#stat-ram').textContent = `RAM ${Math.round((stats.memory.used / stats.memory.total) * 100)}%`;
  } catch {
    // Next tick will retry.
  }
}

// ---------- Init ----------

async function init() {
  bootSound();
  VirtualKeyboard.init({ onToggle: renderHints });
  AppStore.init({
    toast,
    blip,
    renderHints,
    openApp,
    isInstalled: (id) => installedApps.includes(id),
    setInstalled: setAppInstalled,
  });
  Browser.init({
    toast,
    blip,
    renderHints,
    openMenu,
    releaseController,
    resumeController,
    isPassthrough: () => Controller.passthrough,
    rumble: Controller.rumble,
    keyboard: (options) => VirtualKeyboard.open(options),
    inputMode: () => inputMode,
    blocked: () => VirtualKeyboard.isOpen() || menu !== null,
  });

  Controller.start({
    action: (action, meta) => {
      setInputMode('gamepad');
      dispatch(action, meta);
    },
    frame: (axes, dt) => {
      if (axes.some(Boolean)) setInputMode('gamepad');
      Browser.onFrame(axes, dt);
    },
    change: showController,
    disconnect: () => {
      $('#controller-chip').hidden = true;
      setInputMode('keyboard');
      toast('Controle desconectado', 'error');
    },
    passthrough: (enabled) => {
      $('#controller-chip').classList.toggle('released', enabled);
      $('#controller-name').textContent = enabled ? `${Controller.name} (no site)` : Controller.name;
      renderHints();
      if (enabled) return;
      toast('Controle retomado pelo Kairoware XP.');
      // Leaving a cloud-gaming app's control lands on its menu (close / give control back).
      if (Browser.isAppOpen()) Browser.openMenu();
    },
  });
  api.onWindowFocus((focused) => Controller.setWindowFocused(focused));

  window.addEventListener('keydown', onKey);
  window.addEventListener('mousemove', () => setInputMode('keyboard'));
  $('#hero-play').addEventListener('click', () => launch(focusedGame()));
  $('#quick-browser').addEventListener('click', () => Browser.open());
  $('#quick-store').addEventListener('click', () => AppStore.open());
  $('#launch-overlay').addEventListener('click', hideLaunch);
  $('#menu-overlay').addEventListener('click', (event) => {
    if (event.target.id === 'menu-overlay') closeMenu();
  });

  renderHints();
  tickClock();
  setInterval(tickClock, 10_000);
  refreshStats();
  setInterval(refreshStats, 2000);

  call('getGameMode')
    .then((state) => {
      gameModeActive = state.active;
      $('#gamemode-pill').classList.toggle('on', gameModeActive);
    })
    .catch(() => {});

  call('getStartup')
    .then((state) => {
      startupBigPicture = state.enabled && state.bigPicture;
    })
    .catch(() => {});

  try {
    await loadGames();
  } catch (err) {
    toast(`Não foi possível carregar a biblioteca: ${err.message}`, 'error');
  }

  // Desktop shortcuts can open the Big Picture straight into the browser or the store.
  const intent = new URLSearchParams(location.search).get('open');
  if (intent === 'browser') Browser.open();
  else if (intent === 'store') AppStore.open();

  finishBoot();
}

init();
