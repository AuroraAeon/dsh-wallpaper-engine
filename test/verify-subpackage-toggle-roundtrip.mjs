#!/usr/bin/env node
/**
 * verify-subpackage-toggle-roundtrip.mjs -- BUNDLE-SPLIT 7.6(4) 开关往返（对 patch 里的每一行）
 *
 * 7.6(4) 要求对**每一行**做 关 -> 开 -> 再关，每步满足：
 *   1. 该行路由整族在场/缺席与声明一致（声明面 = tools/host-route-index.mjs 的 buildIndex().routes.length）；
 *   2. 可见面按状态面渲染 -- 浏览器面按**包声明**数据驱动：只有声明了 dsh.client 的包才有浏览器半边
 *      （P-A 里 fonts 是宿主半边行、fx/parallax 才是浏览器包），渲染面的双向对账由既有守卫
 *      test/verify-component-visibility.mjs 承担，本文件只查"声明了浏览器面的包其产物在不在"；
 *   3. 停用后零残留（本文件用 mock webServer 表 + 定时器/进程监听/活动句柄探针量出来）；
 *   4. 这一关**只**动它自己那一行（其余行的路由账逐条不变）。
 * 关键量法：每行的"自己那份贡献" = 在**独立** table 里单独装载该行得到的键集合（不是累计快照）。
 * 行来源数据驱动：根 cordis.patch.yml 的 (id, name)；name 解析：
 *   裸包名 -> lib/index.js；<裸包>/<子> -> lib/components/<子>/index.js；子包真实包名 -> packages/<dir>/<main>。
 * 负对照（必须有牙）：
 *   a. 合成"只 return dispose 不交给 fiber"的插件 -> 本判据检测函数判红；
 *   b. 真源码变异体：把行入口里的 handOffTeardown( 换成恒等函数（= lead 口径的 return dispose），
 *      用 data: URL 装载 -> 检测函数判红。空壳行没有 handOffTeardown 则显式列出并计数。
 * 挂链：test/run-guards.mjs 的 VERIFY_STEPS（hard）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments, functionBodyOf } from './tools/js-text.mjs';
import { buildIndex } from './tools/host-route-index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MUT_HELPER = '__weMutNoHandoff';
let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log('  ok  ' + name);
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n      ' + detail : '')); }
}
const isFile = (abs) => { try { return statSync(abs).isFile(); } catch { return false; } };
const isDir = (abs) => { try { return statSync(abs).isDirectory(); } catch { return false; } };
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

function parsePatchRows(text) {
  const rows = [];
  let cur = null;
  for (const raw of String(text).split('\n')) {
    if (/^\s*#/.test(raw)) continue;
    const line = raw.replace(/\s+#.*$/, '');
    const idm = /^\s*-\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (idm) { cur = { id: idm[1], name: null }; rows.push(cur); continue; }
    const nm = /^\s*name:\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(line);
    if (nm && cur && !cur.name) cur.name = nm[1];
  }
  return rows.filter((r) => r.name);
}

function discoverSubpackages() {
  const dir = join(ROOT, 'packages');
  if (!isDir(dir)) return [];
  const out = [];
  for (const n of readdirSync(dir).sort()) {
    const pj = join(dir, n, 'package.json');
    if (!isFile(pj)) continue;
    let manifest;
    try { manifest = JSON.parse(readFileSync(pj, 'utf8')); } catch { manifest = null; }
    out.push({ dir: 'packages/' + n, manifest });
  }
  return out;
}

function resolveRows(rootPkg, pkgs) {
  const rows = parsePatchRows(read('cordis.patch.yml'));
  const rootBrowser = !!(rootPkg.dsh && rootPkg.dsh.client);
  return rows.map((r) => {
    const name = r.name;
    if (name === rootPkg.name) return { id: r.id, name, kind: 'root', rel: 'lib/index.js', browser: rootBrowser };
    if (name.indexOf(rootPkg.name + '/') === 0) {
      const sub = name.slice(rootPkg.name.length + 1);
      return { id: r.id, name, kind: 'component', rel: 'lib/components/' + sub + '/index.js', browser: rootBrowser };
    }
    const s = pkgs.filter((p) => p.manifest && p.manifest.name === name)[0];
    if (!s) return { id: r.id, name, kind: 'unknown', rel: null, browser: false };
    const main = (s.manifest.main || './lib/index.js').replace(/^\.\//, '');
    return { id: r.id, name, kind: 'subpackage', rel: s.dir + '/' + main, browser: !!(s.manifest.dsh && s.manifest.dsh.client), manifest: s.manifest };
  });
}

const makeTable = () => {
  const table = new Map();
  return {
    table,
    webServer: {
      register(route) {
        const key = route.kind + ' ' + route.path;
        if (table.has(key)) throw new Error('webserver: duplicate ' + route.kind + ' route "' + route.path + '"');
        table.set(key, route);
        return () => { table.delete(key); };
      },
      tapIndex() { return () => {}; },
    },
  };
};
const makeFiber = (webServer) => {
  const collected = [];
  let handoffs = 0;
  return {
    // handoffs = 该行**交给 fiber 的 teardown 数目**（§7.6④ 的第二个观测面：路由之外唯一能看出
    // "拆卸有没有真交接"的量；纯浏览器空壳行宿主侧零路由，只有这一面能分辨真源码与变异体）。
    ctx: { webServer, effect(cb) { handoffs++; const d = cb(); if (typeof d === 'function') collected.push(d); return d; } },
    unload() { while (collected.length) collected.pop()(); },
    handoffs: () => handoffs,
  };
};
/** 模拟 cordis 对函数声明 apply 的构造分支：返回值被丢弃，只有 ctx.effect 能救回 teardown。 */
const loadDroppingReturn = (applyFn, ctx) => { applyFn(ctx); };

const keySet = (table) => new Set(table.keys());
const sameSet = (a, b) => a.size === b.size && [...a].every((k) => b.has(k));
const minus = (a, b) => new Set([...a].filter((k) => !b.has(k)));
const inter = (a, b) => [...a].filter((k) => b.has(k));

/** 每行自己那份贡献：在本行独占的 table 里量。 */
function measureOwn(plugins) {
  const own = new Map();
  for (const p of plugins) {
    const t = makeTable();
    const f = makeFiber(t.webServer);
    loadDroppingReturn(p.apply, f.ctx);
    own.set(p.label, keySet(t.table));
    f.unload();
  }
  return own;
}

/** 每行自己那份**交接量**：在本行独占的 table 里量"交给 fiber 的 teardown 数目"。
 *  零宿主贡献行（纯浏览器空壳）路由面为空，变异体与真源码在路由面上完全同构 ⇒ 必须靠这个面给牙。 */
function measureHandoffs(plugins) {
  const out = new Map();
  for (const p of plugins) {
    const t = makeTable();
    const f = makeFiber(t.webServer);
    try { loadDroppingReturn(p.apply, f.ctx); } catch { out.set(p.label, -1); continue; }
    out.set(p.label, f.handoffs());
    f.unload();
  }
  return out;
}

/** 单行往返检测。own = label -> 该行自己那份路由集合。返回问题清单。 */
function rowRoundtripProblems(target, plugins, own) {
  const bad = [];
  const ownSets = own || measureOwn(plugins);
  const t = makeTable();
  const fibers = new Map();
  for (const p of plugins) {
    try { const f = makeFiber(t.webServer); loadDroppingReturn(p.apply, f.ctx); fibers.set(p.label, f); }
    catch (e) { bad.push(p.label + ' 首次装载抛错：' + String(e.message || e).split('\n')[0]); }
  }
  // 有行装载抛错时也要把已经建起来的 fiber 拆掉，否则会污染外层「零残留」探针（假红）。
  if (bad.length) { for (const f of fibers.values()) f.unload(); return bad; }
  const full = keySet(t.table);
  const mine = ownSets.get(target);
  if (!mine) return ['内部错误：own 里没有 ' + target];
  // 不相交性（每行自己那份贡献互不相交）
  const labels = plugins.map((p) => p.label);
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    const ov = inter(ownSets.get(labels[i]), ownSets.get(labels[j]));
    if (ov.length) bad.push('行 ' + labels[i] + ' 与 ' + labels[j] + ' 的路由不相交性不成立，重合 ' + ov.length + ' 条：' + ov.slice(0, 3).join(', '));
  }
  // 关
  fibers.get(target).unload();
  const afterOff = keySet(t.table);
  const expectOff = minus(full, mine);
  if (!sameSet(afterOff, expectOff)) {
    bad.push('关掉 ' + target + ' 后剩 ' + afterOff.size + ' 条，应为 ' + expectOff.size + ' 条'
      + '；本行残留 ' + inter(afterOff, mine).length + ' 条'
      + '；误伤他行 ' + inter(afterOff, expectOff).length + ' 条之外的差异 ' + inter(expectOff, afterOff).length + ' 条');
  }
  // 开（reload 撞 duplicate 就是 teardown 没撤干净）
  let f2 = null, reloadErr = null;
  try { f2 = makeFiber(t.webServer); loadDroppingReturn(plugins.filter((p) => p.label === target)[0].apply, f2.ctx); } catch (e) { reloadErr = e; }
  if (reloadErr) bad.push('再打开 ' + target + ' 撞错：' + String(reloadErr.message || reloadErr).split('\n')[0] + '（teardown 没撤干净）');
  else {
    const afterOn = keySet(t.table);
    if (!sameSet(afterOn, full)) bad.push('再打开 ' + target + ' 后路由账与首次不同（首次 ' + full.size + ' 条 / 现在 ' + afterOn.size + ' 条）');
    const reloaded = minus(afterOn, afterOff);
    if (!sameSet(reloaded, mine)) bad.push('再打开 ' + target + ' 注册的路由集合与首次不同（多/少 ' + (reloaded.size - mine.size) + ' 条）');
    // 再关
    f2.unload();
    const afterOff2 = keySet(t.table);
    if (!sameSet(afterOff2, expectOff)) bad.push('第二次关掉 ' + target + ' 后剩 ' + afterOff2.size + ' 条，应为 ' + expectOff.size + ' 条（残留 ' + inter(afterOff2, mine).length + ' 条）');
  }
  // 收尾：拆掉本 harness 里所有行，避免污染外层「零残留」探针
  for (const p of plugins) { const f = fibers.get(p.label); if (f) f.unload(); }
  if (f2) f2.unload();
  return bad;
}

function mutateNoHandoff(src) {
  return 'const ' + MUT_HELPER + ' = (_c, d) => d;\n' + src.split('handOffTeardown(').join(MUT_HELPER + '(') + '\n';
}
function absolutize(src, fileAbs) {
  const fileUrl = pathToFileURL(fileAbs).href;
  const dirUrl = pathToFileURL(dirname(fileAbs) + sep).href;
  // data: URL 模块里的 import.meta.url 是 data: URL ⇒ 先钉成**真文件 URL**：被测源码里
  // `new URL('../cordis.patch.yml', import.meta.url)` 这类"按本文件位置读本包文件"的写法
  // （lib/index.js 的启动自检就是这么读 patch / package.json 的）在 data: 变异体里才成立。
  return String(src)
    .replace(/import\.meta\.url/g, JSON.stringify(fileUrl))
    .replace(/(from\s*|import\s*\(\s*)(['"])(\.[^'"]*)\2/g, (m, a, q, p) => a + q + new URL(p, dirUrl).href + q);
}
/** `<主包名>` / `<主包名>/<子路径>` -> 主包 exports 指的文件（映射不到返回 null）。 */
function rootExportsTarget(spec) {
  const ex = rootPkg.exports || {};
  if (spec === rootPkg.name) return exportTarget(ex['.']) || rootPkg.main || null;
  if (spec.startsWith(rootPkg.name + '/')) return exportTarget(ex['./' + spec.slice(rootPkg.name.length + 1)]) || null;
  return null;
}
/**
 * 子包宿主入口按**裸名** import 主包（'dsh-plugin-wallpaper-engine/subpackage-boot.js'）。
 * 真实 profile 里主包就装在 node_modules/<主包名>，本仓普通检出下 node_modules 里没有主包自己，
 * 于是裸名解析不到 —— 这里按主包 exports 把裸名映射成仓内 file:// URL。只改解析、不改被测代码；
 * 映射不到（exports 缺该子路径）就保持原样，让 import 大声失败（顺带钉住主包 exports 面）。
 */
function mapRootSpecifiers(src) {
  return String(src).replace(/(from\s*|import\s*\(\s*)(['"])([^'"]+)\2/g, (m, pre, q, spec) => {
    const t = rootExportsTarget(spec);
    return t ? pre + q + pathToFileURL(resolve(ROOT, t.replace(/^\.\//, ''))).href + q : m;
  });
}
/** 装载行入口：子包入口里的主包裸名先映射成 file:// URL（无裸名时直接按真文件装载，保住 import.meta.url）。 */
async function importEntry(abs) {
  const src = readFileSync(abs, 'utf8');
  if (src.indexOf(rootPkg.name) < 0) return import(pathToFileURL(abs).href);
  const code = absolutize(mapRootSpecifiers(src), abs);
  return import('data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64') + '#entry-' + encodeURIComponent(abs));
}
async function importMutant(src, fileAbs, tag) {
  // 子包入口也会 import 主包裸名 ⇒ data: 体里先映射成仓内 file:// URL（data: 模块解析不到裸名）。
  const code = absolutize(mapRootSpecifiers(mutateNoHandoff(src)), fileAbs);
  const url = 'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64') + '#' + tag;
  return import(url);
}

/** exports 值可能是字符串或 {import|default|require} 对象。 */
function exportTarget(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    for (const k of ['import', 'default', 'require', 'node']) if (typeof v[k] === 'string') return v[k];
    for (const k of Object.keys(v)) { const got = exportTarget(v[k]); if (got) return got; }
  }
  return null;
}

// ---------------------------------------------------------------------------
const rootPkg = JSON.parse(read('package.json'));
const pkgs = discoverSubpackages();
const rows = resolveRows(rootPkg, pkgs);
check('根 patch 至少有一行', rows.length > 0, rows.length ? '' : 'cordis.patch.yml 里解析不到 (id, name) 行');

const unknown = rows.filter((r) => r.kind === 'unknown');
check('每一行的 name 都能解析到宿主入口（子包必须能按包名找到 packages/<dir>）', unknown.length === 0,
  unknown.map((r) => 'id=' + r.id + ' name=' + r.name + ' 在 packages/ 下找不到对应包').join('；'));
const missingEntry = rows.filter((r) => r.rel && !isFile(join(ROOT, r.rel)));
check('每个行入口文件都存在', missingEntry.length === 0, missingEntry.map((r) => r.name + ' -> ' + r.rel).join('；'));
console.log('    · 行表：' + rows.map((r) => r.id + '[' + r.kind + (r.browser ? ',浏览器面' : ',宿主面') + ']').join(' / '));

const plugins = [];
for (const r of rows) {
  if (!r.rel || !isFile(join(ROOT, r.rel))) continue;
  try {
    const mod = await importEntry(join(ROOT, r.rel));
    const applyFn = mod.apply || (mod.default && mod.default.apply);
    if (typeof applyFn !== 'function') { check('行 ' + r.name + ' 的入口导出 apply', false, r.rel + ' 没有导出 apply'); continue; }
    plugins.push({ label: r.name, apply: applyFn, row: r });
  } catch (e) { check('行 ' + r.name + ' 的入口可装载', false, r.rel + '：' + String(e.message || e).split('\n')[0]); }
}
check('所有行入口都装载成功', plugins.length === rows.filter((r) => r.rel && isFile(join(ROOT, r.rel))).length,
  plugins.map((p) => p.label).join(' / '));

if (plugins.length > 0) {
  // 零残留探针（定时器：被 clear 或已触发就出账；只统计停用后仍挂着的）
  const timerIds = new Set();
  const oST = globalThis.setTimeout, oCT = globalThis.clearTimeout, oSI = globalThis.setInterval, oCI = globalThis.clearInterval;
  globalThis.setTimeout = (cb, ms, ...rest) => {
    let id = null;
    const wrapped = typeof cb === 'function' ? (...a) => { timerIds.delete(id); return cb(...a); } : cb;
    id = oST(wrapped, ms, ...rest);
    if (typeof cb === 'function') timerIds.add(id);
    return id;
  };
  globalThis.setInterval = (cb, ms, ...rest) => {
    let id = null;
    const wrapped = typeof cb === 'function' ? (...a) => { timerIds.delete(id); return cb(...a); } : cb;
    id = oSI(wrapped, ms, ...rest);
    if (typeof cb === 'function') timerIds.add(id);
    return id;
  };
  globalThis.clearTimeout = (id) => { timerIds.delete(id); return oCT(id); };
  globalThis.clearInterval = (id) => { timerIds.delete(id); return oCI(id); };
  const EVENTS = ['exit', 'beforeExit', 'SIGINT', 'SIGTERM', 'message', 'warning', 'uncaughtException', 'unhandledRejection'];
  const listenerBase = {};
  for (const ev of EVENTS) listenerBase[ev] = process.listenerCount(ev);
  const handlesBase = (typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : -1);

  // 每行独立量自己的贡献，并顺带量该行装载期间挂上的定时器 / 停用后是否清掉
  const ownSets = new Map(), timerRows = [], loadFailures = [];
  for (const p of plugins) {
    const before = new Set(timerIds);
    const t = makeTable();
    const f = makeFiber(t.webServer);
    try { loadDroppingReturn(p.apply, f.ctx); }
    catch (e) { loadFailures.push(p.label + '：' + String(e.message || e).split('\n')[0]); continue; }
    ownSets.set(p.label, keySet(t.table));
    const afterLoad = minus(timerIds, before);
    f.unload();
    const afterUnload = minus(timerIds, before);
    if (afterLoad.size || afterUnload.size) timerRows.push(p.label + ' 装载期挂 ' + afterLoad.size + ' 个定时器，停用后仍挂 ' + afterUnload.size + ' 个');
  }

  // 观测面 2：交接量（路由之外唯一的可观测差异）。零宿主贡献行（§2.2 纯浏览器空壳）宿主侧零路由，
  // 它的 apply 若把 handOffTeardown 退回成"只 return dispose"，路由面上**毫无差别** ⇒ 本条判据在这类
  // 行上会变成没有牙的恒真判据。源码里调用 handOffTeardown( 就是"必须交接"的声明，据此要求实测 ≥1。
  const ownHandoffs = measureHandoffs(plugins);
  const handoffIssues = [];
  for (const p of plugins) {
    const expected = read(p.row.rel).indexOf('handOffTeardown(') >= 0 ? 1 : 0;
    const got = ownHandoffs.get(p.label);
    if (got < expected) handoffIssues.push(p.label + '（' + p.row.rel + '）源码里' + (expected ? '有' : '没有')
      + ' handOffTeardown(，实测交给 fiber 的 teardown ' + got + ' 个');
  }
  check('交接面：源码里调用 handOffTeardown( 的行，实测至少向 ctx.effect 交 1 个 teardown（零路由行也吃这条）',
    handoffIssues.length === 0, handoffIssues.join('；'));
  console.log('    · 交接量：' + plugins.map((p) => p.label + '=' + ownHandoffs.get(p.label)).join(' / '));

  // 逐行的**真源码基线问题集**：变异体的"牙"= 比基线**多**出来的问题（否则搬迁期里任何他行的
  // 既存红都会让所有变异体看起来"已被判红"，牙是假的）。realByRow 供负对照 b 做差集用。
  const real = [], realByRow = new Map();
  for (const p of plugins) {
    const probs = rowRoundtripProblems(p.label, plugins, ownSets);
    realByRow.set(p.label, probs);
    for (const v of probs) real.push(v);
  }
  check('对每一行做 关 -> 开 -> 再关：整族在场/缺席、互不相交、只动自己那一行', real.length === 0, real.join('\n      '));

  const union = new Set();
  for (const s of ownSets.values()) for (const k of s) union.add(k);
  const runtimeTotal = union.size;
  // 逐行贡献必须互不相交：重叠 = 同一族被两行各注册一次（关掉一行不会让它真消失，且后装载的那行会
  // 直接撞 "duplicate ... route"）—— P-A 搬家期的典型半成品状态，必须出声。
  {
    const labels = plugins.map((p) => p.label);
    const overlaps = [];
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const ov = inter(ownSets.get(labels[i]), ownSets.get(labels[j]));
      if (ov.length) overlaps.push(labels[i] + ' ∩ ' + labels[j] + ' = ' + ov.slice(0, 3).join(', ') + (ov.length > 3 ? ' …（' + ov.length + ' 条）' : ''));
    }
    const sumOwn = [...ownSets.values()].reduce((n, s) => n + s.size, 0);
    check('逐行贡献互不相交（各行自己的路由集合 sum=' + sumOwn + ' 应等于并集 union=' + runtimeTotal + '）',
      overlaps.length === 0, overlaps.join('；'));
  }
  const declaredTotal = buildIndex().routes.length;
  check('运行面路由总数（' + runtimeTotal + '）与声明面 buildIndex().routes.length（' + declaredTotal + '）一致', runtimeTotal === declaredTotal,
    '不一致时：新包的宿主入口要纳入 tools/host-route-index.mjs 的包发现层（MAIN_MODULES）');
  console.log('    · 逐行条数：' + plugins.map((p) => p.label + '=' + ownSets.get(p.label).size).join(' / '));

  // 整族关掉：表清空 + 零残留
  const tAll = makeTable();
  const fAll = makeFiber(tAll.webServer);
  const allLoadFailures = [];
  for (const p of plugins) {
    try { loadDroppingReturn(p.apply, fAll.ctx); }
    catch (e) { allLoadFailures.push(p.label + '：' + String(e.message || e).split('\n')[0]); }
  }
  fAll.unload();
  if (allLoadFailures.length) loadFailures.push(...allLoadFailures);
  check('每一行的 apply 在本 harness 里可独立装载（主包裸名映射到仓内文件后不抛异常）',
    loadFailures.length === 0, loadFailures.join('；'));
  const leftover = tAll.table.size;
  const pendingTimers = [...timerIds].length;
  const listenerDelta = EVENTS.map((ev) => ev + ':' + (process.listenerCount(ev) - listenerBase[ev])).filter((s) => !/:0$/.test(s));
  const handlesNow = (typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : -1);
  check('整族关掉后路由表清空 + 零残留（无遗留定时器 / 进程监听 / 活动句柄）',
    leftover === 0 && pendingTimers === 0 && listenerDelta.length === 0 && (handlesBase < 0 || handlesNow <= handlesBase),
    '残留路由 ' + leftover + ' · 停用后仍挂的定时器 ' + pendingTimers + ' · 监听增量 ' + (listenerDelta.join(',') || '无')
      + ' · 活动句柄 ' + handlesBase + ' -> ' + handlesNow + (timerRows.length ? ' · 逐行：' + timerRows.join(' / ') : ''));
  globalThis.setTimeout = oST; globalThis.setInterval = oSI; globalThis.clearTimeout = oCT; globalThis.clearInterval = oCI;

  // 可见面按包声明数据驱动
  const browserRows = plugins.filter((p) => p.row.browser);
  if (browserRows.length === 0) console.log('    · 没有行声明浏览器半边（P-A 范围）-> 渲染面对账交给 verify-component-visibility.mjs');
  else {
    const rootClient = exportTarget(rootPkg.exports && rootPkg.exports['./client']) || './lib/client.js';
    const rootRel = rootClient.replace(/^\.\//, '');
    const text = isFile(join(ROOT, rootRel)) ? read(rootRel) : '';
    const registered = text.indexOf('id: "' + rootPkg.name + '"') >= 0 || text.indexOf("id: '" + rootPkg.name + "'") >= 0;
    check('声明浏览器面的行（' + browserRows.map((p) => p.row.id).join(', ') + '）其包客户端产物存在且注册了包 id', registered && text.length > 1000,
      rootRel + ' 里' + (registered ? '' : '没有') + '注册 id ' + rootPkg.name + '（' + text.length + ' 字符；构建产物缺失时先跑 npm run build）');
  }

  // 负对照 a：合成"只 return dispose"的插件必须被判红
  const synthGood = (prefix) => (ctx) => { const d = ctx.webServer.register({ kind: 'exact', path: '/' + prefix }); ctx.effect(() => d); return d; };
  const synthBad = (prefix) => (ctx) => { const d = ctx.webServer.register({ kind: 'exact', path: '/' + prefix }); return () => d(); };
  const synthRows = [
    { label: '/a', apply: synthGood('synth-a') },
    { label: '/bad', apply: synthBad('synth-bad') },
    { label: '/c', apply: synthGood('synth-c') },
  ];
  const synthOkProblems = rowRoundtripProblems('/a', synthRows);
  check('负对照基准：合成全交接插件集 0 问题（检测函数不恒真）', synthOkProblems.length === 0, JSON.stringify(synthOkProblems));
  const synthBadProblems = rowRoundtripProblems('/bad', synthRows);
  check('负对照：合成"只 return dispose 不交给 fiber"的行被检测函数判红', synthBadProblems.length > 0, JSON.stringify(synthBadProblems));

  // 负对照 b：真源码变异体
  let mutated = 0;
  const skipped = [];
  const mutProblems = [];
  // 每个变异体是靠哪个观测面被判红的 —— 零宿主贡献行只剩"交接面"这一个可观测差异（判据的牙在此处）。
  const mutFaces = [];
  for (const p of plugins) {
    const abs = join(ROOT, p.row.rel);
    const src = readFileSync(abs, 'utf8');
    if (src.indexOf('handOffTeardown(') < 0) { skipped.push(p.label + '（0 处 handOffTeardown，空壳行）'); continue; }
    const mod = await importMutant(src, abs, 'mut-' + encodeURIComponent(p.label));
    const applyFn = mod.apply || (mod.default && mod.default.apply);
    if (typeof applyFn !== 'function') { mutProblems.push(p.label + '：变异体没有导出 apply'); continue; }
    const mutPlugins = plugins.map((q) => (q.label === p.label ? { label: q.label, apply: applyFn, row: q.row } : q));
    let mutOwn, bad2, mutHandoff;
    const expectedHandoff = src.indexOf('handOffTeardown(') >= 0 ? 1 : 0;
    try {
      mutOwn = measureOwn(mutPlugins);
      bad2 = rowRoundtripProblems(p.label, mutPlugins, mutOwn);
      mutHandoff = measureHandoffs(mutPlugins).get(p.label);
    } catch (e) {
      mutProblems.push(p.label + ' 变异体在 harness 里抛错（说明 harness 需要修，不代表判据有牙）：' + String(e.message || e).split('\n')[0]);
      continue;
    }
    mutated++;
    // 判红 = 两个观测面任一抓到**真源码没有的**问题：
    //   · 路由面：变异体的往返问题集中出现基线里没有的条目（delta）；
    //   · 交接面：交给 fiber 的 teardown 数 < 真源码声明的下限（零宿主贡献行只有这一面能分辨）。
    const baseline = realByRow.get(p.label) || [];
    const delta = bad2.filter((v) => !baseline.includes(v));
    mutFaces.push(p.label + (delta.length ? '（路由面 +' + delta.length + '）' : '（交接面 ' + mutHandoff + ' < ' + expectedHandoff + '）'));
    if (delta.length === 0 && !(mutHandoff < expectedHandoff)) {
      mutProblems.push(p.label + '：变异体（handOffTeardown -> 恒等 = 只 return dispose）**没有被判红** —— 本条判据没有牙'
        + '（路由面相对真源码基线新增 0 条；交接面实测 ' + mutHandoff + ' 个，真源码声明下限 ' + expectedHandoff + ' 个）');
    }
  }
  check('负对照：每个有 teardown 交接的行，其真源码变异体都被判红（路由面或交接面，零路由行靠交接面）',
    mutated > 0 && mutProblems.length === 0,
    (mutProblems.length ? mutProblems.join('；') : mutated + ' 个变异体全部被判红') + (skipped.length ? ' · 跳过：' + skipped.join(' / ') : ''));
  console.log('    · 变异体判红口：' + mutFaces.join(' / '));

  // 文本兜底：注册了路由的行，apply 体里必须出现 handOffTeardown
  const textIssues = [];
  for (const p of plugins) {
    if (ownSets.get(p.label).size === 0) continue;
    const src = read(p.row.rel);
    const body = functionBodyOf(stripComments(src), 'export function apply(');
    if (body === null) textIssues.push(p.label + '（' + p.row.rel + '）定位不到 export function apply( 的函数体');
    else if (!/handOffTeardown\s*\(/.test(body)) textIssues.push(p.label + '（' + p.row.rel + '）apply 体里没有 handOffTeardown(');
  }
  check('注册了路由的行：apply 体里都有 handOffTeardown(', textIssues.length === 0, textIssues.join('；'));
}

console.log('');
if (failed) { console.log('SUBPACKAGE TOGGLE ROUNDTRIP CHECKS FAILED -- ' + failed + ' failed'); process.exit(1); }
console.log('ALL SUBPACKAGE TOGGLE ROUNDTRIP CHECKS PASSED');
process.exit(0);
