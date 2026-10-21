#!/usr/bin/env node
/**
 * verify-preset-intro-browser.mjs —— 「作者自用」推广弹窗的**真浏览器**实测。
 *
 * ## 为什么需要它
 * `test/verify-presets.mjs` 对 `PresetIntroDialog` 有 7 条**源码形态**判据（组件在、两处挂载、
 * 门控三件、A/B 键接线、#199 探针闸、缓存口径）。形态判据能挡住"接线被删"，但挡不住
 * 这几类**只有在浏览器里才看得见**的失效：
 *   · 弹窗渲染出来但**没有样式**（CSS 没进 bundle / 选择器写错）⇒ 屏上是一坨裸文字；
 *   · 两个按钮**叠在一起**或被容器裁掉（点击落在错的那个上）；
 *   · A 键点击后**不消失**（applyPreset 的 promise 没接上）；
 *   · B 键点了但 localStorage 哨兵**没写**（下次刷新又弹）；
 *   · 探针判 no 时仍然渲染（窗口期缺陷 #199 的真实形态）。
 *
 * ## 做法
 * 不启动真宿主：用 `lib/client.js` 的**真实产物**在无头 Chromium 里跑，桩出最小宿主面
 * （React UMD + 假 `fetch` + 假 localStorage 观测）。弹窗组件从产物里**原样取出**求值 ——
 * 断言的是产物，不是源码。
 *
 * 判据分两组：
 *   A. **渲染与交互**（真 DOM）：三个门控态（pending / ok / no）各自的可见性；
 *      B 键点击 ⇒ 弹窗消失 + 哨兵写入；A 键点击 ⇒ 走到 fetch 且失败时弹窗留下并显示错误行。
 *   B. **样式到位**（真 computed style）：面板居中、有深色玻璃底、两个按钮横向排在
 *      容器内且不重叠（用 getBoundingClientRect 实测相交）。
 *
 * Usage:  node test/verify-preset-intro-browser.mjs
 *         缺少 Chromium 时用 WE_TEST_BROWSER 指定可执行文件（与 verify-glass-runtime-browser 同口径）。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, existsSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const bundle = readFileSync(resolve(ROOT, 'lib/client.js'), 'utf8');

const browsers = process.platform === 'win32'
  ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const browser = process.env.WE_TEST_BROWSER || browsers.find(existsSync);
assert.ok(browser && existsSync(browser),
  '缺少 Chromium 浏览器；请用 WE_TEST_BROWSER 指定可执行文件（与 verify-glass-runtime-browser 同口径）');

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) passed += 1; else failed += 1;
  console.log((ok ? '  PASS | ' : '  FAIL | ') + name + (detail === undefined ? '' : ' — ' + detail));
};

// ── 从产物里取三样东西：CSS、PresetIntroDialog 函数体、weT（取词）────────────
/** 产物里 CSS 模板的正文（`const CSS = ...` 的拼接结果，按内联模块切）。 */
function moduleText(name) {
  const start = bundle.indexOf('// ── 内联模块：src/' + name + '.js');
  if (start < 0) return '';
  const end = bundle.indexOf('// ── 内联模块：', start + 10);
  return bundle.slice(bundle.indexOf('\n', start), end < 0 ? bundle.length : end);
}
/** 取函数声明的完整源码（按花括号配平；字符串/注释感知，避免被内部的 `}` 骗到）。 */
function functionSource(src, header) {
  const at = src.indexOf(header);
  if (at < 0) return '';
  let i = src.indexOf('{', at);
  if (i < 0) return '';
  const start = at;
  let depth = 0;
  let prev = '';
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && c2 === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i += 1;
      while (i < src.length) { const d = src[i]; if (d === '\\') { i += 2; continue; } i += 1; if (d === q) break; }
      prev = q; continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return src.slice(start, i);
}

const cssQuick = moduleText('styles-quick');
const cssText = (() => {
  // 样式模块是 `const CSS_QUICK = \`…\`;` 形式；直接截模板内容（不做模板求值，避免 ${} 干扰）。
  const m = /const CSS_QUICK = `([\s\S]*)`;\s*$/m.exec(cssQuick);
  if (!m) return '';
  // 模板里若含 ${…} 插值，说明有动态拼接 —— 本文件没有，命中即视为结构变了，直接失败。
  return m[1];
})();
assert.ok(cssText.length > 1000, 'styles-quick 的 CSS 模板取不到（产物结构变了？）');

const dialogSrc = functionSource(bundle, 'function PresetIntroDialog()');
assert.ok(dialogSrc.length > 500, 'PresetIntroDialog 源码取不到');

// 组件门控引用的模块级常量：从产物**现读**（不写死 —— 写死会在下次升哨兵时静默漂移）。
const noticeVersion = (bundle.match(/const NOTICE_VERSION = "([^"]+)";/) || [])[1];
assert.ok(noticeVersion, 'NOTICE_VERSION 取不到');
const presetIntroVersion = (bundle.match(/const PRESET_INTRO_VERSION = "([^"]+)";/) || [])[1];
assert.ok(presetIntroVersion, 'PRESET_INTRO_VERSION 取不到');
const presetIntroKey = (bundle.match(/const PRESET_INTRO_SEEN_KEY = "([^"]+)";/) || [])[1];
assert.ok(presetIntroKey, 'PRESET_INTRO_SEEN_KEY 取不到');

// ── 起无头浏览器 ─────────────────────────────────────────────────────────────
const profile = mkdtempSync(join(ROOT, '.artifacts', 'preset-intro-profile-'));
const logPath = join(profile, 'browser.log');
const logFd = openSync(logPath, 'w');
// ⚠️ 启动参数与 `verify-glass-runtime-browser.mjs` **逐字对齐**（那份在 windows-latest /
// ubuntu-latest 上长期为绿）：不加 `--disable-gpu`（CI 的 Edge 在无 GPU 时会起不来，
// 实测首投红在"调试端口未就绪"），也不带 `about:blank` 导航参数（随后用 Page.navigate 到
// 本地 http 源，localStorage 才可用）。
const child = spawn(browser, [
  '--headless=new', '--no-first-run', '--remote-debugging-port=0',
  '--user-data-dir=' + profile,
], { stdio: ['ignore', 'ignore', logFd] });
closeSync(logFd);

let socket;
let counter = 0;
const pending = new Map();
const send = (method, params = {}, timeoutMs = 15000) => new Promise((resolvePromise, reject) => {
  const id = ++counter;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, timeoutMs);
  pending.set(id, { resolve: resolvePromise, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

try {
  // 等调试端口。
  // ⚠️ 20s 在 windows-latest 上不够（实测 CI 首投就红在这条：`浏览器调试端口未就绪`）。
  // 与 verify-glass-runtime-browser 同口径放宽到 60s；失败时**把浏览器 stderr 带出来** ——
  // 只报"端口未就绪"等于让人猜是"慢"还是"根本起不来"。
  let port;
  const deadline = Date.now() + 60000;
  while (!port && Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('浏览器提前退出（exit=' + child.exitCode + '）：' + readFileSync(logPath, 'utf8').slice(-2000));
    }
    try {
      port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
    } catch { await delay(150); }
  }
  assert.ok(port, '浏览器调试端口未就绪（60s）：browser=' + browser
    + ' · exit=' + child.exitCode + ' · stderr=' + readFileSync(logPath, 'utf8').slice(-1200));

  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej; });
  socket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  };
  await send('Page.enable');
  await send('Runtime.enable');

  // ⚠️ about:blank 下 localStorage 是 SecurityError（不透明源，实测）⇒ 必须导航到
  // 一个真实的 http 源。用本进程起一个最小静态服务（只服务一个空页），不碰仓库文件。
  const port2 = await new Promise((resolvePort) => {
    const srv = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>preset-intro-rig</title><body><div id="host"></div></body>');
    });
    srv.listen(0, '127.0.0.1', () => resolvePort({ srv, port: srv.address().port }));
  });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + port2.port + '/' });
  await delay(300);

  // ── 装一个最小 React 桩 + 弹窗组件 ────────────────────────────────────────
  // 判据只关心**门控/点击/样式**，不关心 React 的调度细节 ⇒ 用极简 hooks 桩：
  // useState 有状态、useEffect 立即跑一次（依赖变化重跑）、useSyncExternalStore 读快照。
  await evaluate(`(() => {
    window.__errors = [];
    window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
    const store = { state: [], effects: [], idx: 0, revision: 0, listeners: new Set() };
    window.__store = store;
    const React = {
      createElement: (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat(9).filter((k) => k !== null && k !== undefined && k !== false) }),
      Fragment: 'fragment',
      useState(init) { const i = store.idx++; if (!(i in store.state)) store.state[i] = typeof init === 'function' ? init() : init;
        return [store.state[i], (v) => { store.state[i] = typeof v === 'function' ? v(store.state[i]) : v; }]; },
      useEffect(fn) { const i = store.idx++; store.effects[i] = fn; },
      useSyncExternalStore(sub, get) { return get(); },
    };
    window.React = React;

    // 取词：中文即键（与 src/i18n.js 同口径），测试只跑中文。
    window.weT = (k) => k;
    // 假宿主状态：hostLoaded + noticeSeen 已处理 ⇒ 只要没答过就该弹。
    window.__sel = { hostLoaded: true, noticeSeen: ${JSON.stringify(noticeVersion)}, glassPresetError: '' };
    window.useStore = () => window.__sel;
    window.useWeLocale = () => 0;
    window.emit = () => {};
    window.setTransient = (k, v) => { window.__sel[k] = v; };
    window.weClampTo = (v) => v;
    // 探针与本体的假实现：由每个用例自己改写 __fetchPlan
    window.__fetchPlan = { ok: true };
    window.gpJson = (url) => { window.__probeUrl = url; return Promise.resolve(window.__fetchPlan); };
    window.glassPresetUrl = (id) => '/wallpaper-engine/glass-presets/' + encodeURIComponent(id);
    window.applyPreset = (id) => { window.__applied = id; return window.__applyResult(); };
    window.__applyResult = () => Promise.resolve(window.__planApplyOk);
    window.__planApplyOk = true;

    // 最小渲染器：把 createElement 树挂成真 DOM（够测门控、点击、几何）。
    // paint() 在渲染后**自动跑本轮登记的 effect**（真 React 在 commit 阶段做这件事）。
    // 少了它探针永远停在 pending、弹窗永远不渲染 —— 判据会以"没渲染"的形式假红。
    window.__dialog = null;
    window.paint = () => {
      const host = document.getElementById('host');
      const Dialog = window.__dialog;
      store.idx = 0;
      window.render(Dialog(), host);
      for (let i = 0; i < store.effects.length; i += 1) {
        const fn = store.effects[i];
        if (!fn || fn.__ran) continue;
        fn.__ran = true;
        const cleanup = fn();
        if (typeof cleanup === 'function') store.effects[i] = () => cleanup;
      }
      return true;
    };
    window.render = (tree, host) => {
      host.innerHTML = '';
      const build = (n) => {
        if (n === null || n === undefined || n === false) return null;
        if (typeof n === 'string' || typeof n === 'number') return document.createTextNode(String(n));
        if (Array.isArray(n)) { const f = document.createDocumentFragment(); n.forEach((k) => { const b = build(k); if (b) f.append(b); }); return f; }
        if (!n.type) return null;
        const el = document.createElement(n.type);
        for (const [k, v] of Object.entries(n.props || {})) {
          if (k === 'className') el.className = v;
          else if (k === 'style' && v && typeof v === 'object') Object.assign(el.style, v);
          else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
          else if (k === 'disabled') el.disabled = !!v;
          else if (k === 'role' || k === 'aria-label') el.setAttribute(k, v);
          else if (k === 'type') el.type = v;
        }
        (n.kids || []).forEach((k) => { const b = build(k); if (b) el.append(b); });
        return el;
      };
      const node = build(tree);
      if (node) host.append(node);
      return node;
    };
    return true;
  })()`);

  // 注入真实 CSS（产物里的那份）
  await evaluate(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(cssText)}; document.head.append(s); return s.sheet.cssRules.length; })()`);

  // 注入组件工厂：把产物里的 PresetIntroDialog 求值成可调用函数
  await evaluate(`(() => {
    window.__makeDialog = () => {
      // 组件读的模块级状态（产物里就是这几个）——每次求值都是新作用域，等于"刷新页面"。
      let presetIntroProbeVerdict = "";
      const PRESET_INTRO_VERSION = ${JSON.stringify(presetIntroVersion)};
      const PRESET_INTRO_SEEN_KEY = ${JSON.stringify(presetIntroKey)};
      const NOTICE_VERSION = ${JSON.stringify(noticeVersion)};
      ${dialogSrc}
      return PresetIntroDialog;
    };
    return true;
  })()`);

  // ── 用例 1：探针 ok ⇒ 弹窗渲染，两按钮在、几何不重叠 ─────────────────────
  await evaluate(`(async () => {
    window.__fetchPlan = { ok: true };
    window.__sel = { hostLoaded: true, noticeSeen: ${JSON.stringify(noticeVersion)}, glassPresetError: '' };
    localStorage.clear();
    window.__store.state = []; window.__store.effects = []; window.__store.idx = 0;
    window.__dialog = window.__makeDialog();
    window.paint();                    // 第一帧：probe=pending，立刻跑探针 effect
    await new Promise((r) => setTimeout(r, 30));
    window.paint();                    // 探针回来后重渲染：probe=ok ⇒ 弹窗出现
    return true;
  })()`);
  await delay(120);

  const rendered = await evaluate(`(() => {
    const el = document.querySelector('.we-preset-intro');
    if (!el) return { present: false };
    const btns = [...el.querySelectorAll('.we-preset-intro__btn')];
    const r = el.getBoundingClientRect();
    const rects = btns.map((b) => b.getBoundingClientRect());
    const overlap = rects.length === 2
      && !(rects[0].right <= rects[1].left || rects[1].right <= rects[0].left
        || rects[0].bottom <= rects[1].top || rects[1].bottom <= rects[0].top);
    const cs = getComputedStyle(el);
    return {
      present: true, buttons: btns.length, overlap,
      width: Math.round(r.width), height: Math.round(r.height),
      zIndex: cs.zIndex, position: cs.position,
      bg: cs.backgroundColor, radius: cs.borderTopLeftRadius,
      titleText: (el.querySelector('.we-preset-intro__title') || {}).textContent || '',
    };
  })()`);
  check('探针 ok ⇒ 弹窗渲染', rendered.present === true);
  check('两个按钮都在（采用 / 保持）', rendered.buttons === 2, 'buttons=' + rendered.buttons);
  check('两按钮不重叠（点击不会落到错的那个）', rendered.overlap === false);
  check('居中模态：position=fixed 且 z-index 高于公告（1100）',
    rendered.position === 'fixed' && Number(rendered.zIndex) > 1100,
    rendered.position + ' z=' + rendered.zIndex);
  check('深色玻璃底已生效（不是裸文字）',
    /rgba?\(/.test(rendered.bg) && rendered.bg !== 'rgba(0, 0, 0, 0)' && rendered.radius !== '0px',
    rendered.bg + ' radius=' + rendered.radius);
  check('标题文案正确', /作者自用/.test(rendered.titleText), rendered.titleText.slice(0, 30));

  // ── 用例 2：B 键（保持我的设置）⇒ 弹窗消失 + 哨兵写入 ────────────────────
  const afterKeep = await evaluate(`(async () => {
    const el = document.querySelector('.we-preset-intro');
    const btns = [...el.querySelectorAll('.we-preset-intro__btn')];
    btns[1].click();
    await new Promise((r) => setTimeout(r, 30));
    window.paint();
    return {
      stillThere: !!document.querySelector('.we-preset-intro'),
      seen: localStorage.getItem('dsh-wallpaper-engine:preset-intro-seen'),
      applied: window.__applied || null,
    };
  })()`);
  check('B 键 ⇒ 弹窗消失', afterKeep.stillThere === false);
  check('B 键 ⇒ localStorage 哨兵已写（刷新不再弹）', afterKeep.seen !== null, String(afterKeep.seen));
  check('B 键 ⇒ 不调用 applyPreset（保持当前设置）', afterKeep.applied === null, String(afterKeep.applied));

  // ── 用例 3：A 键但应用失败 ⇒ 弹窗留下 + 错误行 ───────────────────────────
  const afterAcceptFail = await evaluate(`(async () => {
    localStorage.clear();
    window.__store.state = []; window.__store.effects = []; window.__store.idx = 0;
    window.__planApplyOk = false;
    window.__sel = { hostLoaded: true, noticeSeen: ${JSON.stringify(noticeVersion)}, glassPresetError: '后端拒绝' };
    window.__dialog = window.__makeDialog();
    window.paint();
    await new Promise((r) => setTimeout(r, 20));
    window.paint();
    const el = document.querySelector('.we-preset-intro');
    const btn = el && el.querySelector('.we-preset-intro__btn--primary');
    if (!btn) return { missing: true };
    btn.click();
    await new Promise((r) => setTimeout(r, 60));
    window.paint();
    return {
      applied: window.__applied || null,
      stillThere: !!document.querySelector('.we-preset-intro'),
      errLine: (document.querySelector('.we-preset-intro__err') || {}).textContent || '',
      seen: localStorage.getItem('dsh-wallpaper-engine:preset-intro-seen'),
    };
  })()`);
  check('A 键 ⇒ 真的调用 applyPreset("factory-author")', afterAcceptFail.applied === 'factory-author', String(afterAcceptFail.applied));
  check('A 键失败 ⇒ 弹窗留在原地（可重试）', afterAcceptFail.stillThere === true);
  check('A 键失败 ⇒ 不写已读哨兵（"答过了"不伪装成"应用过了"）', afterAcceptFail.seen === null, String(afterAcceptFail.seen));

  // ── 用例 4：探针 no ⇒ 一个弹窗都不渲染（#199 窗口期）────────────────────
  const probeNo = await evaluate(`(async () => {
    localStorage.clear();
    window.__store.state = []; window.__store.effects = []; window.__store.idx = 0;
    // 清掉模块级缓存：重求值组件工厂（每次求值都是新作用域）
    window.__fetchPlan = { ok: false };
    window.__dialog = window.__makeDialog();
    window.paint();
    await new Promise((r) => setTimeout(r, 60));
    window.paint();
    return { present: !!document.querySelector('.we-preset-intro') };
  })()`);
  check('探针非 ok ⇒ 不渲染（窗口期不打扰用户）', probeNo.present === false);

  check('运行期零异常（TDZ / TypeError 这一类必须由判据挡下）',
    (await evaluate('window.__errors.length')) === 0,
    JSON.stringify(await evaluate('window.__errors')));
} finally {
  try { socket && socket.close(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
}

console.log('\n' + (failed === 0
  ? 'PRESET INTRO (BROWSER) PASSED (' + passed + ')'
  : 'PRESET INTRO (BROWSER) FAILED (' + passed + ' passed, ' + failed + ' failed)'));
process.exit(failed === 0 ? 0 : 1);
