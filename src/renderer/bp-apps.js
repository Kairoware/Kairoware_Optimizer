'use strict';

// App catalog and store for the Big Picture mode. Apps are web apps opened in the controller
// browser without its toolbar. Input styles:
//   tv      – the D-pad and A/B are sent to the page as arrow keys / Enter / Escape (TV interfaces)
//   gamepad – the page receives the controller directly (cloud gaming)
//   cursor  – the same virtual cursor as the browser

// Smart TV user agent: makes youtube.com/tv serve its TV ("leanback") interface.
const TV_USER_AGENT =
  'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36';

const BUILTIN_APPS = [
  { id: 'browser', name: 'Navegador', glyph: '🌐', color: '#7c5cff', builtin: true, description: 'Navegue em qualquer site usando o controle.' },
  { id: 'store', name: 'Loja de apps', glyph: '🛍️', color: '#0ea5e9', builtin: true, description: 'Instale apps feitos para usar na TV e com controle.' },
];

const APP_CATALOG = [
  {
    id: 'youtube-tv', name: 'YouTube TV', category: 'Vídeo', glyph: '▶', color: '#ff0033', input: 'tv',
    url: 'https://www.youtube.com/tv', userAgent: TV_USER_AGENT,
    description: 'A interface de TV do YouTube, navegável pelo direcional do controle.',
  },
  {
    id: 'youtube-music', name: 'YouTube Music', category: 'Música', glyph: '♪', color: '#e11d48', input: 'cursor',
    url: 'https://music.youtube.com/',
    description: 'Músicas, álbuns e playlists do YouTube.',
  },
  {
    id: 'twitch', name: 'Twitch', category: 'Transmissões', glyph: 'T', color: '#9146ff', input: 'cursor',
    url: 'https://www.twitch.tv/',
    description: 'Assista a transmissões ao vivo de jogos.',
  },
  {
    id: 'pluto-tv', name: 'Pluto TV', category: 'TV ao vivo', glyph: 'P', color: '#c2a000', input: 'cursor',
    url: 'https://pluto.tv/br/live-tv',
    description: 'Canais de TV ao vivo e filmes gratuitos.',
  },
  {
    id: 'xbox-cloud', name: 'Xbox Cloud Gaming', category: 'Jogos na nuvem', glyph: 'X', color: '#16a34a', input: 'gamepad',
    url: 'https://www.xbox.com/play',
    description: 'Jogue títulos do Game Pass Ultimate pela nuvem, com o seu controle.',
  },
  {
    id: 'geforce-now', name: 'GeForce NOW', category: 'Jogos na nuvem', glyph: 'G', color: '#65a30d', input: 'gamepad',
    url: 'https://play.geforcenow.com/',
    description: 'Jogue sua biblioteca da Steam e da Epic em servidores na nuvem.',
  },
  {
    id: 'discord', name: 'Discord', category: 'Social', glyph: 'D', color: '#5865f2', input: 'cursor',
    url: 'https://discord.com/app',
    description: 'Converse com amigos e servidores.',
  },
];

const AppStore = (() => {
  const q = (selector) => document.querySelector(selector);

  let ctx = null;
  let isOpen = false;
  let index = 0;

  function init(context) {
    ctx = context;
  }

  function card(app, i) {
    const installed = ctx.isInstalled(app.id);
    const node = document.createElement('button');
    node.className = `store-card${installed ? ' installed' : ''}`;
    node.tabIndex = -1;
    node.style.setProperty('--c', app.color);

    const icon = document.createElement('span');
    icon.className = 'app-icon';
    icon.textContent = app.glyph;

    const info = document.createElement('span');
    info.className = 'store-info';
    const name = document.createElement('strong');
    name.textContent = app.name;
    const category = document.createElement('span');
    category.className = 'store-category';
    category.textContent = app.category;
    const description = document.createElement('span');
    description.className = 'store-description';
    description.textContent = app.description;
    info.append(name, category, description);

    const state = document.createElement('span');
    state.className = 'store-state';
    state.textContent = installed ? '✓ Instalado' : 'Instalar';

    node.append(icon, info, state);
    node.addEventListener('click', () => {
      focus(i);
      activate(app);
    });
    return node;
  }

  function render() {
    q('#store-grid').replaceChildren(...APP_CATALOG.map(card));
    focus(index);
  }

  function focus(i) {
    const cards = q('#store-grid').children;
    index = Math.max(0, Math.min(i, cards.length - 1));
    [...cards].forEach((c, n) => c.classList.toggle('focused', n === index));
    cards[index]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    ctx.renderHints();
  }

  function move(direction) {
    const cards = q('#store-grid').children;
    const top = cards[0].offsetTop;
    let cols = 0;
    for (const c of cards) {
      if (c.offsetTop !== top) break;
      cols++;
    }
    const col = index % cols;
    if ((direction === 'left' && col === 0) || (direction === 'right' && col === cols - 1)) return false;
    const next = index + { left: -1, right: 1, up: -cols, down: cols }[direction];
    if (next < 0 || next >= cards.length) return false;
    focus(next);
    return true;
  }

  async function activate(app) {
    if (ctx.isInstalled(app.id)) {
      ctx.openApp(app);
      return;
    }
    await ctx.setInstalled(app.id, true);
    ctx.toast(`${app.name} instalado. Ele aparece na aba Apps.`);
    render();
  }

  async function uninstall(app) {
    if (!ctx.isInstalled(app.id)) return;
    await ctx.setInstalled(app.id, false);
    ctx.toast(`${app.name} desinstalado.`);
    render();
  }

  function open() {
    isOpen = true;
    q('#store').classList.add('open');
    render();
  }

  function close() {
    isOpen = false;
    q('#store').classList.remove('open');
    ctx.renderHints();
  }

  function handleAction(action, meta = {}) {
    if (meta.repeat && !['up', 'down', 'left', 'right'].includes(action)) return;
    const app = APP_CATALOG[index];
    switch (action) {
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        if (move(action)) ctx.blip();
        break;
      case 'confirm': activate(app).catch((err) => ctx.toast(err.message, 'error')); break;
      case 'favorite': uninstall(app).catch((err) => ctx.toast(err.message, 'error')); break;
      case 'back': close(); break;
    }
  }

  function hints() {
    const installed = ctx.isInstalled(APP_CATALOG[index].id);
    return [
      ['confirm', installed ? 'Abrir' : 'Instalar'],
      ...(installed ? [['favorite', 'Desinstalar']] : []),
      ['back', 'Fechar loja'],
    ];
  }

  return { init, open, close, handleAction, hints, isOpen: () => isOpen, refresh: () => isOpen && render() };
})();
