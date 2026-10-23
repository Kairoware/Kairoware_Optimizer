'use strict';

// On-screen keyboard driven by the controller (also works with mouse and a physical keyboard).
// VirtualKeyboard.open() resolves with the typed text, or null when cancelled.
const VirtualKeyboard = (() => {
  const LAYOUTS = {
    letters: [
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
      ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
      ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'ç'],
      ['shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '-', 'backspace'],
      ['symbols', '@', '.com', 'space', '.', '/', 'done'],
    ],
    symbols: [
      ['!', '?', '#', '$', '%', '&', '*', '(', ')', '='],
      ['á', 'à', 'â', 'ã', 'é', 'ê', 'í', 'ó', 'ô', 'õ'],
      ['ú', '_', '+', ':', ';', '"', "'", '<', '>', '|'],
      ['shift', '[', ']', '{', '}', '~', '^', '\\', ',', 'backspace'],
      ['letters', 'www.', 'https://', 'space', '.', '/', 'done'],
    ],
  };
  const WIDTH = { space: 4, done: 1.8, backspace: 1.6, shift: 1.6, symbols: 1.6, letters: 1.6, '.com': 1.3, 'www.': 1.3, 'https://': 1.6 };
  const LABEL = { space: 'Espaço', backspace: '⌫', shift: '⇧', symbols: '?123', letters: 'ABC' };
  const SPECIAL = new Set(['space', 'backspace', 'shift', 'symbols', 'letters', 'done']);

  let state = null;
  let hooks = {};
  const root = () => document.getElementById('vkeyboard');

  function init(options) {
    hooks = options;
  }

  function isOpen() {
    return state !== null;
  }

  // options: title, value, placeholder, doneLabel, selectAll (first key replaces the value),
  // onChange(value) for live updates, direct { insert, backspace, enter } to type into another target.
  function open(options = {}) {
    if (state) close(null);
    return new Promise((resolve) => {
      state = {
        title: options.title ?? 'Digite',
        value: options.value ?? '',
        placeholder: options.placeholder ?? '',
        doneLabel: options.doneLabel ?? 'OK',
        selected: Boolean(options.selectAll && options.value),
        onChange: options.onChange ?? null,
        direct: options.direct ?? null,
        layout: 'letters',
        shift: false,
        row: 1,
        col: 0,
        openedAt: performance.now(),
        resolve,
      };
      render();
      root().classList.add('open');
      hooks.onToggle?.();
    });
  }

  function close(result) {
    if (!state) return;
    const { resolve } = state;
    state = null;
    root().classList.remove('open');
    hooks.onToggle?.();
    resolve(result);
  }

  const currentKey = () => LAYOUTS[state.layout][state.row][state.col];

  function label(key) {
    if (key === 'done') return state.doneLabel;
    if (LABEL[key]) return LABEL[key];
    return state.shift ? key.toUpperCase() : key;
  }

  function render() {
    root().querySelector('.vk-title').textContent = state.title;
    const rows = LAYOUTS[state.layout];
    state.row = Math.min(state.row, rows.length - 1);
    state.col = Math.min(state.col, rows[state.row].length - 1);

    root().querySelector('.vk-rows').replaceChildren(
      ...rows.map((row, r) => {
        const rowNode = document.createElement('div');
        rowNode.className = 'vk-row';
        row.forEach((key, c) => {
          const button = document.createElement('button');
          button.className = `vk-key${SPECIAL.has(key) ? ' special' : ''}${key === 'done' ? ' accent' : ''}`;
          button.tabIndex = -1;
          button.style.flexGrow = WIDTH[key] ?? 1;
          button.textContent = label(key);
          // Keep focus where it is (e.g. inside a web page receiving the text).
          button.addEventListener('mousedown', (event) => event.preventDefault());
          button.addEventListener('click', () => {
            state.row = r;
            state.col = c;
            press(key);
            if (state) highlight();
          });
          rowNode.append(button);
        });
        return rowNode;
      }),
    );
    renderValue();
    highlight();
  }

  function renderValue() {
    const node = root().querySelector('.vk-value');
    node.textContent = state.value || state.placeholder;
    node.classList.toggle('is-placeholder', !state.value);
    node.classList.toggle('selected', state.selected);
  }

  function highlight() {
    root().querySelectorAll('.vk-row').forEach((row, r) =>
      [...row.children].forEach((key, c) => {
        key.classList.toggle('focused', r === state.row && c === state.col);
        key.classList.toggle('active', LAYOUTS[state.layout][r][c] === 'shift' && state.shift);
      }));
  }

  function changed() {
    renderValue();
    state.onChange?.(state.value);
  }

  function type(text) {
    if (state.selected) {
      state.value = '';
      state.selected = false;
    }
    state.direct?.insert(text);
    state.value += text;
    changed();
    if (state.shift) {
      state.shift = false;
      render();
    }
  }

  function backspace() {
    if (state.selected) {
      state.value = '';
      state.selected = false;
    } else {
      state.direct?.backspace();
      state.value = [...state.value].slice(0, -1).join('');
    }
    changed();
  }

  function done() {
    const { value, direct } = state;
    direct?.enter?.();
    close(value);
  }

  function press(key) {
    switch (key) {
      case 'space': type(' '); break;
      case 'backspace': backspace(); break;
      case 'shift': state.shift = !state.shift; render(); break;
      case 'symbols': state.layout = 'symbols'; render(); break;
      case 'letters': state.layout = 'letters'; render(); break;
      case 'done': done(); break;
      default: type(state.shift ? key.toUpperCase() : key);
    }
  }

  function move(direction) {
    const rows = root().querySelectorAll('.vk-row');
    if (direction === 'left' || direction === 'right') {
      const count = rows[state.row].children.length;
      state.col = (state.col + (direction === 'left' ? -1 : 1) + count) % count;
    } else {
      // Keep the column visually aligned when moving between rows with keys of different widths.
      const from = rows[state.row].children[state.col].getBoundingClientRect();
      const center = from.left + from.width / 2;
      state.row = (state.row + (direction === 'up' ? -1 : 1) + rows.length) % rows.length;
      let best = Infinity;
      [...rows[state.row].children].forEach((key, i) => {
        const rect = key.getBoundingClientRect();
        const distance = Math.abs(rect.left + rect.width / 2 - center);
        if (distance < best) {
          best = distance;
          state.col = i;
        }
      });
    }
    highlight();
  }

  // Controller actions. Returns true when the action moved the selection (for the nav sound).
  function handleAction(action, meta = {}) {
    // A button still held from opening the keyboard must not start repeating inside it.
    if (meta.repeat && performance.now() - state.openedAt < 700) return false;
    switch (action) {
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        move(action);
        return true;
      case 'confirm': press(currentKey()); break;
      case 'options': backspace(); break;
      case 'favorite': type(' '); break;
      case 'prevTab': state.shift = !state.shift; render(); break;
      case 'nextTab': state.layout = state.layout === 'letters' ? 'symbols' : 'letters'; render(); break;
      case 'menu': done(); break;
      case 'back': close(null); break;
    }
    if (state) highlight();
    return false;
  }

  function handleKey(event) {
    if (event.ctrlKey || event.altKey) return;
    event.preventDefault();
    if (event.key === 'Escape') close(null);
    else if (event.key === 'Enter') done();
    else if (event.key === 'Backspace') backspace();
    else if (event.key.startsWith('Arrow')) move(event.key.slice(5).toLowerCase());
    else if (event.key.length === 1) type(event.key);
  }

  return { init, open, close, isOpen, handleAction, handleKey };
})();
