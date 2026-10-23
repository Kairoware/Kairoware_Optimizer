'use strict';

// Controller-friendly web browser for the Big Picture mode, built on a single <webview>.
// Left stick moves a virtual cursor, right stick scrolls, A/✕ clicks and text fields open the
// virtual keyboard.
const Browser = (() => {
  const SITES = [
    { name: 'Pesquisar ou digitar endereço', url: null, color: '#7c5cff', glyph: '⌕' },
    { name: 'YouTube', url: 'https://www.youtube.com/', color: '#ff2d55', glyph: '▶' },
    { name: 'Twitch', url: 'https://www.twitch.tv/', color: '#9146ff', glyph: 'T' },
    { name: 'Xbox Cloud Gaming', url: 'https://www.xbox.com/play', color: '#16a34a', glyph: 'X' },
    { name: 'GeForce NOW', url: 'https://play.geforcenow.com/', color: '#76b900', glyph: 'G' },
    { name: 'Loja Steam', url: 'https://store.steampowered.com/', color: '#2a6db0', glyph: 'S' },
    { name: 'Epic Games Store', url: 'https://store.epicgames.com/pt-BR/', color: '#475569', glyph: 'E' },
    { name: 'Google', url: 'https://www.google.com/', color: '#4285f4', glyph: 'G' },
    { name: 'Wikipédia', url: 'https://pt.wikipedia.org/', color: '#64748b', glyph: 'W' },
  ];
  const PARTITION = 'persist:kairo-browser';
  const CURSOR_SPEED = 1200;
  const SCROLL_SPEED = 1600;
  const EDITABLE_CHECK = `(() => {
    const el = document.activeElement;
    if (!el) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden'].includes(el.type);
  })()`;

  // TV apps are driven like a TV remote: D-pad → arrow keys, A → Enter, B → Escape.
  const TV_KEYS = { up: 'Up', down: 'Down', left: 'Left', right: 'Right', confirm: 'Enter', back: 'Escape' };

  const q = (selector) => document.querySelector(selector);
  const curve = (v) => Math.sign(v) * Math.abs(v) ** 1.6;

  let ctx = null;
  let isOpen = false;
  let currentApp = null; // app from the catalog when running in app mode
  let mode = 'home';
  let webview = null;
  let ready = false;
  let homeIndex = 0;
  let zoom = 1;
  let cursorTimer = null;
  const cursor = { x: 0, y: 0 };

  function init(context) {
    ctx = context;
    q('#site-grid').replaceChildren(
      ...SITES.map((site, i) => {
        const card = document.createElement('button');
        card.className = 'site';
        card.tabIndex = -1;
        card.style.setProperty('--c', site.color);
        const glyph = document.createElement('span');
        glyph.className = 'site-glyph';
        glyph.textContent = site.glyph;
        const name = document.createElement('span');
        name.textContent = site.name;
        card.append(glyph, name);
        card.addEventListener('click', () => {
          focusSite(i);
          openSite(site);
        });
        return card;
      }),
    );

    q('#browser-back').addEventListener('click', goBack);
    q('#browser-forward').addEventListener('click', goForward);
    q('#browser-reload').addEventListener('click', reload);
    q('#browser-home-btn').addEventListener('click', showHome);
    q('#browser-close').addEventListener('click', close);
    q('#browser-address').addEventListener('click', editAddress);
  }

  // ---------- Open / close ----------

  function open(url) {
    if (currentApp) close();
    isOpen = true;
    q('#browser').classList.add('open');
    if (url) navigate(url);
    else showHome();
  }

  // Opens a catalog app full screen, without the browser toolbar.
  function openApp(app) {
    if (isOpen) close();
    currentApp = app;
    isOpen = true;
    mode = 'page';
    q('#browser').classList.add('open', 'app-mode');
    q('#browser-home').hidden = true;
    createWebview(app.url, app.userAgent);
    if (app.input === 'gamepad') ctx.releaseController();
    ctx.renderHints();
  }

  function close() {
    const app = currentApp;
    destroyWebview();
    isOpen = false;
    currentApp = null;
    q('#browser').classList.remove('open', 'app-mode');
    if (app?.input === 'gamepad') ctx.resumeController();
    ctx.renderHints();
  }

  function showHome() {
    destroyWebview();
    mode = 'home';
    q('#browser-home').hidden = false;
    setAddress('');
    updateNavButtons();
    focusSite(homeIndex);
    ctx.renderHints();
  }

  function destroyWebview() {
    if (webview) {
      webview.remove();
      webview = null;
      ready = false;
    }
    setFullscreen(false);
    q('#browser').classList.remove('loading');
    q('#browser-cursor').classList.remove('visible');
  }

  function setFullscreen(on) {
    q('#browser').classList.toggle('fullscreen', on);
    document.body.classList.toggle('browser-fullscreen', on);
  }

  // ---------- Navigation ----------

  function toUrl(input) {
    const text = input.trim();
    if (/^https?:\/\//i.test(text)) return text;
    if (/^[^\s/]+\.[a-z]{2,}(?::\d+)?(\/\S*)?$/i.test(text)) return `https://${text}`;
    return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
  }

  function createWebview(url, userAgent) {
    webview = document.createElement('webview');
    webview.setAttribute('partition', PARTITION);
    webview.setAttribute('allowpopups', '');
    if (userAgent) webview.setAttribute('useragent', userAgent);
    webview.setAttribute('src', url);

    webview.addEventListener('dom-ready', () => {
      ready = true;
      webview.setZoomFactor(zoom);
      updateNavButtons();
      // Apps receive key/controller input directly, so give them focus right away.
      if (currentApp) webview.focus();
    });
    webview.addEventListener('did-start-loading', () => q('#browser').classList.add('loading'));
    webview.addEventListener('did-stop-loading', () => q('#browser').classList.remove('loading'));
    webview.addEventListener('did-navigate', (event) => {
      setAddress(event.url);
      updateNavButtons();
    });
    webview.addEventListener('did-navigate-in-page', (event) => {
      if (!event.isMainFrame) return;
      setAddress(event.url);
      updateNavButtons();
    });
    webview.addEventListener('did-fail-load', (event) => {
      if (event.isMainFrame && event.errorCode !== -3) {
        ctx.toast(`Não foi possível abrir a página (${event.errorDescription}).`, 'error');
      }
    });
    webview.addEventListener('enter-html-full-screen', () => setFullscreen(true));
    webview.addEventListener('leave-html-full-screen', () => setFullscreen(false));

    q('#browser-body').prepend(webview);
  }

  function navigate(input) {
    const url = toUrl(input);
    mode = 'page';
    q('#browser-home').hidden = true;
    setAddress(url);
    if (!webview) createWebview(url);
    else if (ready) webview.loadURL(url).catch(() => {});
    else webview.src = url;
    requestAnimationFrame(() => {
      const { width, height } = bodySize();
      placeCursor(width / 2, height / 2);
    });
    ctx.renderHints();
  }

  function openSite(site) {
    if (site.url) navigate(site.url);
    else editAddress();
  }

  function goBack() {
    if (mode === 'home') close();
    else if (ready && webview.canGoBack()) webview.goBack();
    else if (currentApp) close();
    else showHome();
  }

  function goForward() {
    if (ready && webview.canGoForward()) webview.goForward();
  }

  function reload() {
    if (ready) webview.reload();
  }

  function setAddress(url) {
    const node = q('#browser-url');
    node.textContent = url || 'Pesquisar no Google ou digitar endereço';
    node.classList.toggle('is-placeholder', !url);
  }

  function updateNavButtons() {
    q('#browser-forward').disabled = !(ready && webview.canGoForward());
    q('#browser-reload').disabled = !ready;
  }

  function zoomBy(step) {
    if (!ready) return;
    zoom = Math.round(Math.min(2, Math.max(0.5, zoom + step)) * 10) / 10;
    webview.setZoomFactor(zoom);
    ctx.toast(`Zoom ${Math.round(zoom * 100)}%`);
  }

  async function editAddress() {
    const current = mode === 'page' && ready ? webview.getURL() : '';
    const text = await ctx.keyboard({
      title: 'Endereço ou pesquisa',
      value: current,
      selectAll: true,
      placeholder: 'Pesquisar no Google ou digitar endereço',
      doneLabel: 'Ir',
    });
    if (text?.trim()) {
      if (!isOpen) open();
      navigate(text);
    }
  }

  // ---------- Virtual cursor ----------

  function bodySize() {
    const rect = q('#browser-body').getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  function placeCursor(x, y) {
    const { width, height } = bodySize();
    cursor.x = Math.max(0, Math.min(width - 1, x));
    cursor.y = Math.max(0, Math.min(height - 1, y));
    q('#browser-cursor').style.transform = `translate(${cursor.x}px, ${cursor.y}px)`;
  }

  function showCursor() {
    const node = q('#browser-cursor');
    node.classList.add('visible');
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => node.classList.remove('visible'), 4000);
  }

  function moveCursor(dx, dy) {
    placeCursor(cursor.x + dx, cursor.y + dy);
    showCursor();
    webview.sendInputEvent({ type: 'mouseMove', x: Math.round(cursor.x), y: Math.round(cursor.y) });
  }

  // Positive dy scrolls down (Chromium wheel deltas point the other way).
  function scroll(dx, dy) {
    webview.sendInputEvent({
      type: 'mouseWheel',
      x: Math.round(cursor.x),
      y: Math.round(cursor.y),
      deltaX: -dx,
      deltaY: -dy,
      canScroll: true,
    });
  }

  function onFrame(axes, dt) {
    if (!isOpen || mode !== 'page' || !ready || ctx.blocked()) return;
    if (currentApp && currentApp.input !== 'cursor') return;
    const [lx, ly, rx, ry] = axes;
    if (lx || ly) moveCursor(curve(lx) * CURSOR_SPEED * dt, curve(ly) * CURSOR_SPEED * dt);
    if (rx || ry) scroll(curve(rx) * SCROLL_SPEED * dt, curve(ry) * SCROLL_SPEED * dt);
  }

  function click() {
    if (!ready) return;
    const x = Math.round(cursor.x);
    const y = Math.round(cursor.y);
    const node = q('#browser-cursor');
    showCursor();
    node.classList.remove('click');
    void node.offsetWidth; // restart the click animation
    node.classList.add('click');

    webview.focus();
    webview.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    webview.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    ctx.rumble(0.1, 0.3, 40);

    // Like a console browser: clicking a text field with the controller opens the keyboard.
    setTimeout(async () => {
      if (!ready || ctx.inputMode() !== 'gamepad') return;
      const editable = await webview.executeJavaScript(EDITABLE_CHECK).catch(() => false);
      if (editable) typeIntoPage();
    }, 180);
  }

  function sendKey(keyCode, char) {
    webview.sendInputEvent({ type: 'keyDown', keyCode });
    if (char) webview.sendInputEvent({ type: 'char', keyCode: char });
    webview.sendInputEvent({ type: 'keyUp', keyCode });
  }

  async function typeIntoPage() {
    if (!ready) return;
    webview.focus();
    await ctx.keyboard({
      title: 'Digitar na página',
      doneLabel: 'Enviar',
      direct: {
        insert: (text) => webview.insertText(text),
        backspace: () => sendKey('Backspace'),
        enter: () => sendKey('Enter', '\r'),
      },
    });
  }

  // ---------- Home (site shortcuts) ----------

  function focusSite(index) {
    const cards = q('#site-grid').children;
    homeIndex = Math.max(0, Math.min(index, cards.length - 1));
    [...cards].forEach((card, i) => card.classList.toggle('focused', i === homeIndex));
    cards[homeIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function moveHome(direction) {
    const cards = q('#site-grid').children;
    const top = cards[0].offsetTop;
    let cols = 0;
    for (const card of cards) {
      if (card.offsetTop !== top) break;
      cols++;
    }
    const col = homeIndex % cols;
    if ((direction === 'left' && col === 0) || (direction === 'right' && col === cols - 1)) return false;
    const next = homeIndex + { left: -1, right: 1, up: -cols, down: cols }[direction];
    if (next < 0 || next >= cards.length) return false;
    focusSite(next);
    return true;
  }

  // ---------- Controller ----------

  function appMenuItems() {
    const items = [{ label: 'Recarregar app', run: reload }];
    if (currentApp.input === 'gamepad') {
      items.push({ label: 'Devolver o controle ao app', detail: 'Aperte os dois botões do meio juntos para voltar a este menu.', run: ctx.releaseController });
    }
    if (currentApp.input === 'cursor') {
      items.push({ label: 'Zoom padrão (100%)', run: () => { zoom = 1; if (ready) webview.setZoomFactor(1); } });
    }
    items.push({ label: `Fechar ${currentApp.name}`, run: close });
    return items;
  }

  function openMenu() {
    if (currentApp) ctx.openMenu(currentApp.name, appMenuItems());
    else ctx.openMenu('Navegador', menuItems());
  }

  function menuItems() {
    const items = [
      { label: 'Início', detail: 'Atalhos para sites e jogos na nuvem.', run: showHome },
      { label: 'Endereço ou pesquisa', run: editAddress },
    ];
    if (mode === 'page') {
      items.push(
        { label: 'Recarregar página', run: reload },
        { label: 'Zoom padrão (100%)', run: () => { zoom = 1; if (ready) webview.setZoomFactor(1); } },
        {
          label: 'Liberar controle para o site',
          detail: 'Para jogos na nuvem: o site passa a receber o controle. Aperte os dois botões do meio juntos para voltar.',
          run: ctx.releaseController,
        },
      );
    }
    items.push({ label: 'Fechar navegador', run: close });
    return items;
  }

  function handleAction(action, meta = {}) {
    if (meta.repeat && !['up', 'down', 'left', 'right', 'lt', 'rt'].includes(action)) return;
    if (['menu', 'home'].includes(action) || (currentApp && action === 'view')) {
      openMenu();
      return;
    }
    if (currentApp?.input === 'tv') {
      if (TV_KEYS[action] && ready) {
        webview.focus();
        sendKey(TV_KEYS[action]);
      }
      return;
    }
    if (mode === 'home') {
      switch (action) {
        case 'up':
        case 'down':
        case 'left':
        case 'right':
          if (moveHome(action)) ctx.blip();
          break;
        case 'confirm': openSite(SITES[homeIndex]); break;
        case 'options': editAddress(); break;
        case 'back': close(); break;
      }
      return;
    }

    switch (action) {
      // D-pad: up/down scroll, left/right nudge the cursor. The left stick already moves the cursor.
      case 'up':
      case 'down':
        if (!meta.fromStick) scroll(0, action === 'up' ? -320 : 320);
        break;
      case 'left':
      case 'right':
        if (!meta.fromStick && ready) moveCursor(action === 'left' ? -40 : 40, 0);
        break;
      case 'confirm': click(); break;
      case 'back': goBack(); break;
      case 'options': editAddress(); break;
      case 'favorite': typeIntoPage(); break;
      case 'prevTab': if (ready && webview.canGoBack()) webview.goBack(); break;
      case 'nextTab': goForward(); break;
      case 'lt': zoomBy(-0.1); break;
      case 'rt': zoomBy(0.1); break;
      case 'view': showHome(); break;
    }
  }

  function hints() {
    if (currentApp?.input === 'gamepad' && ctx.isPassthrough()) return [[['view', 'menu'], 'Juntos: menu do app']];
    if (ctx.inputMode() !== 'gamepad') return [['back', 'Voltar']];
    if (currentApp?.input === 'tv') {
      return [['dpad', 'Navegar'], ['confirm', 'Selecionar'], ['back', 'Voltar'], ['menu', 'Menu do app']];
    }
    if (mode === 'home') return [['confirm', 'Abrir'], ['options', 'Endereço'], ['menu', 'Menu'], ['back', 'Fechar']];
    return [
      ['lstick', 'Cursor'], ['rstick', 'Rolar'], ['confirm', 'Clicar'], ['favorite', 'Digitar'],
      ['options', 'Endereço'], [['lt', 'rt'], 'Zoom'], ['back', 'Voltar'], ['menu', 'Menu'],
    ];
  }

  return {
    init,
    open,
    openApp,
    openMenu,
    close,
    handleAction,
    onFrame,
    hints,
    isOpen: () => isOpen,
    isAppOpen: () => currentApp !== null,
  };
})();
