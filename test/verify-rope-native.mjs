import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { functionBodyOf, stripExportBlocks } from './tools/js-text.mjs';

const client = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
const sidebar = stripExportBlocks(readFileSync(new URL('../src/sidebar-right.js', import.meta.url), 'utf8'));
const body = functionBodyOf(client, 'function RopeDock(');
assert.ok(body, 'RopeDock must exist');
const start = client.indexOf('const ROPE_OPEN_THRESHOLD =');
const end = client.indexOf('function RopeDock()');
assert.ok(start >= 0 && end > start, 'rope constants and position helpers must exist');
const runtime = sidebar + client.slice(start, end) + 'function RopeDock() ' + body;

function harness(mode, source = runtime) {
  const cells = [], mounted = new Set(), effects = [], calls = [], released = [];
  const store = new Map(), sel = { ropeShown: true, ropeScale: 1 };
  let cursor = 0, expanded = false, kind = null, queries = 0;
  const element = () => ({
    style: {}, offsetWidth: 64, offsetHeight: 74,
    classList: { add() {}, remove() {} },
    setPointerCapture() {}, releasePointerCapture(id) { released.push(id); },
  });
  const React = {
    Fragment: 'fragment',
    useState(init) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = typeof init === 'function' ? init() : init;
      return [cells[i], value => { cells[i] = typeof value === 'function' ? value(cells[i]) : value; }];
    },
    useRef(init) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = { current: init };
      return cells[i];
    },
    useEffect(fn) {
      const i = cursor++;
      if (!mounted.has(i)) { mounted.add(i); effects.push(fn); }
    },
    createElement(type, props, ...children) {
      if (props && props.ref && !props.ref.current) props.ref.current = element();
      return { type, props: props || {}, children };
    },
  };
  const noop = () => {};
  const sandbox = {
    React, useStore: () => sel, useWeLocale: noop,
    ropeArtOf: () => ({ w: 64, h: 74, img: 'test.png' }),
    clampNum: value => value, ROPE_SCALE_MIN: 0.5, ROPE_SCALE_MAX: 2,
    ROPE_POS_KEY: 'rope-position', UpdateNotice: noop, PresetIntroDialog: noop, QuickPanel: noop,
    emit: noop, weT: text => text, renderWeIcon: noop,
    localStorage: { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value) },
    window: { innerWidth: 1280, innerHeight: 800, addEventListener: noop, removeEventListener: noop },
    document: {
      addEventListener: noop, removeEventListener: noop,
      querySelector() { queries++; throw new Error('native rope must not query or mutate the host frame'); },
    },
  };
  vm.runInNewContext(source + '\nglobalThis.api = { RopeDock, installSidebarRight };', sandbox);
  let uninstall = noop;
  if (mode === 'official') {
    uninstall = sandbox.api.installSidebarRight({
      slots: { inject: (_, fn) => fn(), register: () => noop },
      get(name) {
        if (name === 'sidebarRightTabs') return { register: () => noop };
        if (name === 'sidebarRight') return {
          openTab(next) { calls.push('open'); expanded = true; kind = next; },
          isExpanded: () => expanded, active: () => kind ? { kind } : null,
          toggleExpanded() { calls.push('close'); expanded = !expanded; },
        };
        return null;
      },
    });
  }
  const render = () => {
    cursor = 0;
    const tree = sandbox.api.RopeDock();
    while (effects.length) effects.shift()();
    return { rope: tree.children.find(node => node && node.props.className === 'we-rope we-rope--settle'),
      panel: tree.children.find(node => node && node.type === 'aside') };
  };
  const event = (x, y, extra = {}) => ({
    pointerType: 'mouse', button: 0, pointerId: 7, clientX: x, clientY: y, preventDefault: noop, ...extra,
  });
  const click = () => {
    const { rope } = render();
    rope.props.onPointerDown(event(600, 10));
    rope.props.onPointerUp(event(600, 10));
  };
  const drag = (dy, canceled = false) => {
    const { rope } = render();
    rope.props.onPointerDown(event(600, 200));
    rope.props.onPointerMove(event(600, 200 + dy));
    rope.props[canceled ? 'onPointerCancel' : 'onPointerUp'](event(600, 200 + dy));
  };
  return { render, click, drag, event, calls, released, store, sel, uninstall,
    opened: () => mode === 'official' ? expanded : render().panel.props['aria-hidden'] === 'false',
    queryCount: () => queries, selectOtherTab: () => { expanded = true; kind = 'unrelated'; } };
}

function verify(mode, source = runtime) {
  const h = harness(mode, source);
  assert.equal(h.opened(), false);
  h.click(); assert.equal(h.opened(), true, mode + ': click opens');
  h.click(); assert.equal(h.opened(), false, mode + ': click closes');
  for (const key of ['Enter', ' ']) {
    h.render().rope.props.onKeyDown(h.event(0, 0, { key }));
    assert.equal(h.opened(), true, mode + ': keyboard opens');
    h.render().rope.props.onKeyDown(h.event(0, 0, { key }));
    assert.equal(h.opened(), false, mode + ': keyboard closes');
  }
  h.drag(120); assert.equal(h.opened(), true, mode + ': downward pull opens');
  h.drag(-120); assert.equal(h.opened(), false, mode + ': upward pull closes');
  h.drag(20); assert.equal(h.opened(), false, mode + ': short drag does not open');
  h.drag(120, true); assert.equal(h.opened(), false, mode + ': canceled pull does not open');
  h.render().rope.props.onKeyDown(h.event(0, 0, { key: 'Tab' }));
  assert.equal(h.opened(), false, mode + ': unrelated key is untouched');
  const { rope } = h.render();
  rope.props.onPointerDown(h.event(600, 10));
  rope.props.onPointerMove(h.event(700, 150, { pointerId: 8 }));
  rope.props.onPointerUp(h.event(600, 10));
  assert.equal(h.opened(), true, mode + ': unrelated pointer cannot turn click into pull');
  assert.equal(h.queryCount(), 0, 'rope must not touch host grid, overflow, transforms or animations');
  assert.ok(h.released.length >= 7, 'pointer capture must be returned after interaction');
  const position = JSON.parse(h.store.get('rope-position'));
  assert.equal(position.y, 8, 'mascot returns to its native top inset');
  assert.ok(position.x >= 8 && position.x <= 1208, 'position remains viewport-clamped');
  if (mode === 'official') {
    h.selectOtherTab();
    h.drag(-120);
    assert.equal(h.opened(), true, 'upward pull must not close another plugin tab');
    h.uninstall();
    h.click();
    assert.equal(h.render().panel.props['aria-hidden'], 'false', 'official service teardown restores drawer fallback');
  }
}

for (const mode of ['drawer', 'official']) {
  verify(mode);
  console.log('PASS native mascot click, keyboard, pull, cancel and pointer ownership: ' + mode);
}
for (const [name, from, to] of [
  ['click', 'if (!canceled && !d.moved) wallSidebarToggle();', 'if (!canceled && !d.moved) {}'],
  ['downward pull', 'dy >= ROPE_OPEN_THRESHOLD', 'dy >= 1000000'],
  ['keyboard', 'e.preventDefault(); wallSidebarToggle();', 'e.preventDefault();'],
]) {
  assert.ok(runtime.includes(from), 'mutation anchor missing: ' + name);
  const mutated = runtime.replace(from, to);
  assert.throws(() => verify('official', mutated), { name: 'AssertionError' }, 'negative control must fail: ' + name);
  console.log('PASS negative control rejects broken ' + name);
}
console.log('ALL NATIVE MASCOT CHECKS PASSED');
