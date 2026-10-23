'use strict';

// Controller support for the Big Picture mode: identifies Xbox / PlayStation pads, draws their
// button glyphs, turns gamepad state into actions and exposes the analog sticks every frame.
const Controller = (() => {
  // Standard Gamepad mapping. Xbox and PlayStation pads share the indices; only the labels differ.
  const BUTTONS = {
    0: 'confirm', 1: 'back', 2: 'options', 3: 'favorite', 4: 'prevTab', 5: 'nextTab', 6: 'lt', 7: 'rt',
    8: 'view', 9: 'menu', 10: 'ls', 11: 'rs', 12: 'up', 13: 'down', 14: 'left', 15: 'right', 16: 'home',
  };
  const REPEATABLE = new Set(['up', 'down', 'left', 'right', 'lt', 'rt', 'options']);
  const DEADZONE = 0.18;
  const STICK_THRESHOLD = 0.55;

  const PS_SHAPES = {
    cross: '<path d="M5.5 5.5l9 9m0-9l-9 9" stroke="#8fb4ff" stroke-width="2.4" stroke-linecap="round"/>',
    circle: '<circle cx="10" cy="10" r="5.4" fill="none" stroke="#ff7b7b" stroke-width="2.2"/>',
    square: '<rect x="5" y="5" width="10" height="10" rx="1" fill="none" stroke="#f39be0" stroke-width="2.2"/>',
    triangle: '<path d="M10 4.6l5.8 10H4.2z" fill="none" stroke="#4fe0b5" stroke-width="2.2" stroke-linejoin="round"/>',
  };

  const LABELS = {
    xbox: {
      confirm: { text: 'A', cls: 'face xa' },
      back: { text: 'B', cls: 'face xb' },
      options: { text: 'X', cls: 'face xx' },
      favorite: { text: 'Y', cls: 'face xy' },
      prevTab: { text: 'LB', cls: 'bumper' },
      nextTab: { text: 'RB', cls: 'bumper' },
      lt: { text: 'LT', cls: 'trigger' },
      rt: { text: 'RT', cls: 'trigger' },
      menu: { text: '☰', cls: 'round' },
      view: { text: '⧉', cls: 'round' },
      home: { text: 'Xbox', cls: 'pill' },
      ls: { text: 'LS', cls: 'stick' },
      rs: { text: 'RS', cls: 'stick' },
      lstick: { text: 'L', cls: 'stick' },
      rstick: { text: 'R', cls: 'stick' },
      dpad: { text: '✚', cls: 'round' },
    },
    playstation: {
      confirm: { shape: 'cross' },
      back: { shape: 'circle' },
      options: { shape: 'square' },
      favorite: { shape: 'triangle' },
      prevTab: { text: 'L1', cls: 'bumper' },
      nextTab: { text: 'R1', cls: 'bumper' },
      lt: { text: 'L2', cls: 'trigger' },
      rt: { text: 'R2', cls: 'trigger' },
      menu: { text: 'OPTIONS', cls: 'pill' },
      view: { text: 'CREATE', cls: 'pill' },
      home: { text: 'PS', cls: 'pill' },
      ls: { text: 'L3', cls: 'stick' },
      rs: { text: 'R3', cls: 'stick' },
      lstick: { text: 'L', cls: 'stick' },
      rstick: { text: 'R', cls: 'stick' },
      dpad: { text: '✚', cls: 'round' },
    },
    keyboard: {
      confirm: 'Enter', back: 'Esc', options: 'O', favorite: 'F', prevTab: 'Q', nextTab: 'E',
      lt: '−', rt: '+', menu: 'M', view: '/', home: 'M', ls: 'B', lstick: 'Mouse', rstick: 'Roda', dpad: '↑↓←→',
    },
  };

  let active = null; // { index, type, name }
  let windowFocused = document.hasFocus();
  let passthrough = false;
  let lastFrame = 0;
  const held = new Map();
  const handlers = {};

  // Chromium ids look like "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)"
  // or "Xbox 360 Controller (XInput STANDARD GAMEPAD)".
  function identify(id) {
    const text = id.toLowerCase();
    if (/054c|dualsense|dualshock|playstation/.test(text) || /^wireless controller/.test(text)) {
      if (/0df2|edge/.test(text)) return { type: 'playstation', name: 'DualSense Edge' };
      if (/0ce6|dualsense/.test(text)) return { type: 'playstation', name: 'DualSense' };
      if (/05c4|09cc|dualshock/.test(text)) return { type: 'playstation', name: 'DualShock 4' };
      return { type: 'playstation', name: 'Controle PlayStation' };
    }
    if (/045e|xbox|xinput/.test(text)) return { type: 'xbox', name: 'Controle Xbox' };
    return { type: 'generic', name: id.replace(/\s*\(.*\)$/, '') || 'Controle' };
  }

  function setActive(pad) {
    if (active?.index === pad.index) return;
    active = { index: pad.index, ...identify(pad.id) };
    handlers.change?.(active);
  }

  function glyph(action, mode) {
    const set = mode === 'keyboard' ? LABELS.keyboard : mode === 'playstation' ? LABELS.playstation : LABELS.xbox;
    let spec = set[action] ?? action;
    if (typeof spec === 'string') spec = { text: spec };
    // The DualShock 4 calls its left middle button SHARE.
    if (mode === 'playstation' && action === 'view' && active?.name === 'DualShock 4') spec = { ...spec, text: 'SHARE' };

    const node = document.createElement('kbd');
    node.className = `key ${spec.cls ?? ''}`;
    if (spec.shape) {
      node.classList.add('ps-face');
      node.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${PS_SHAPES[spec.shape]}</svg>`;
    } else {
      node.textContent = spec.text;
    }
    return node;
  }

  function rumble(strong = 0.3, weak = 0.5, duration = 80) {
    const pad = active ? navigator.getGamepads()[active.index] : null;
    pad?.vibrationActuator?.playEffect?.('dual-rumble', { duration, strongMagnitude: strong, weakMagnitude: weak })?.catch(() => {});
  }

  function poll(now) {
    const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0;
    lastFrame = now;

    const pressed = new Map(); // action -> came from the left stick
    const axes = [0, 0, 0, 0];
    for (const pad of navigator.getGamepads()) {
      if (!pad) continue;
      let used = false;
      pad.buttons.forEach((button, i) => {
        if (button.pressed && BUTTONS[i]) {
          pressed.set(BUTTONS[i], false);
          used = true;
        }
      });
      pad.axes.slice(0, 4).forEach((value, i) => {
        if (Math.abs(value) < DEADZONE) return;
        used = true;
        if (Math.abs(value) > Math.abs(axes[i])) axes[i] = value;
      });
      if (used) setActive(pad);
    }

    const [lx, ly] = axes;
    if (lx < -STICK_THRESHOLD && !pressed.has('left')) pressed.set('left', true);
    if (lx > STICK_THRESHOLD && !pressed.has('right')) pressed.set('right', true);
    if (ly < -STICK_THRESHOLD && !pressed.has('up')) pressed.set('up', true);
    if (ly > STICK_THRESHOLD && !pressed.has('down')) pressed.set('down', true);

    const enabled = windowFocused && document.visibilityState === 'visible';

    // In passthrough the page owns the controller; View + Menu together takes it back.
    if (passthrough && enabled && pressed.has('view') && pressed.has('menu') && !(held.has('view') && held.has('menu'))) {
      passthrough = false;
      for (const action of pressed.keys()) held.set(action, { since: now, last: now, suppressed: true });
      handlers.passthrough?.(false);
    }

    for (const [action, fromStick] of pressed) {
      const state = held.get(action);
      if (!state) {
        // Presses made while a game has focus are tracked but never fire, even after focus returns.
        const suppressed = !enabled || passthrough;
        held.set(action, { since: now, last: now, suppressed });
        if (!suppressed) handlers.action?.(action, { fromStick, repeat: false });
      } else if (!state.suppressed && REPEATABLE.has(action) && now - state.since > 380 && now - state.last > 90) {
        state.last = now;
        handlers.action?.(action, { fromStick, repeat: true });
      }
    }
    for (const action of [...held.keys()]) {
      if (!pressed.has(action)) held.delete(action);
    }

    if (enabled && !passthrough) handlers.frame?.(axes, dt);
    requestAnimationFrame(poll);
  }

  function start(options) {
    Object.assign(handlers, options);
    window.addEventListener('gamepadconnected', (event) => setActive(event.gamepad));
    window.addEventListener('gamepaddisconnected', (event) => {
      if (active?.index !== event.gamepad.index) return;
      const next = [...navigator.getGamepads()].find(Boolean);
      active = null;
      if (next) setActive(next);
      else handlers.disconnect?.();
    });
    requestAnimationFrame(poll);
  }

  return {
    start,
    glyph,
    rumble,
    get type() {
      return active?.type === 'playstation' ? 'playstation' : 'xbox';
    },
    get name() {
      return active?.name ?? '';
    },
    get passthrough() {
      return passthrough;
    },
    setWindowFocused(focused) {
      windowFocused = focused;
    },
    setPassthrough(enabled) {
      passthrough = enabled;
      handlers.passthrough?.(enabled);
    },
  };
})();
