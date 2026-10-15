#!/usr/bin/env node
/**
 * verify-subpackage-boot.mjs —— §7.6① 启动自检（P-A 子包族）
 *
 * 故障形态（§2.2 / §10.1-I5）：子包行只写进 npm 依赖、**没被主 patch 插入**时，宿主的 Loader
 * 不会报错 —— 浏览器半边只是"不存在"，功能静默缺失。所以主包必须**自己**在 apply 里 resolve
 * 每个净新增子包行；解析失败要**大声报错**（不许静默 return）。
 *
 * 判据口径（数据驱动，不写死包名）：
 *   ① `packages/<dir>/package.json` 的集合 ⇄ 主 patch 里"净新增子包行"（name 以 `<root>-` 开头）的集合
 *      必须**互为双射**：有包没行 = 没插行；有行没包 = 死行。
 *   ② `lib/subpackage-boot.js`（叶子模块，零裸包 import）必须导出
 *        · `subpackageSpecifiers(patchText, selfName)` → string[]（裸行名）
 *        · `assertSubpackagesResolvable(rows, resolve)` → 全部可解析时正常返回；**任一失败必须抛 Error**，
 *          消息里逐条带上失败的 `name` 与行 `id`
 *      且 `lib/index.js` 的 `apply` 体里必须**调用**它（文本兜底）。
 *   ③ 负对照：a) `subpackageSpecifiers` 的合成 patch 文本（注释行 / 裸行自身 / 子路径行 / 净新增行）；
 *      b) `assertSubpackagesResolvable` 的"静默版"实现（把 throw 去掉）必须被本判据判红；
 *      c) `lib/index.js` 的合成源码（apply 体里没有调用）必须被判红。
 *
 * 挂链：`test/run-guards.mjs` 的 VERIFY_STEPS（hard）。缺 packages/ 或缺契约模块时**判红**，
 * 不放宽 —— 这正是"未落判据/未挂契约"要被看见的地方。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { functionBodyOf, stripComments } from './tools/js-text.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_REL = 'lib/subpackage-boot.js';
const APPLY_HEADER = 'export function apply(';

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log('  ✓ ' + name);
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const isFile = (abs) => { try { return statSync(abs).isFile(); } catch { return false; } };

/** 本仓子包发现（最小实现；不依赖 scripts/ 里的开发脚本存在）。 */
function discoverSubpackages() {
  const dir = join(ROOT, 'packages');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const n of readdirSync(dir).sort()) {
    const pj = join(dir, n, 'package.json');
    if (!isFile(pj)) continue;
    try {
      const manifest = JSON.parse(readFileSync(pj, 'utf8'));
      out.push({ dir: 'packages/' + n, name: typeof manifest.name === 'string' ? manifest.name : null, manifest, error: null });
    } catch (e) { out.push({ dir: 'packages/' + n, name: null, manifest: null, error: e.message }); }
  }
  return out;
}

/** 主 patch 的行（id/name；只认行内首个 id/name，口径同 verify-subpackage-manifests）。 */
function patchRows(text) {
  const rows = []; let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    const id = /^\s*(?:-\s*)?id:\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(line);
    if (id) { cur = { id: id[1], name: null }; rows.push(cur); continue; }
    const name = /^\s*(?:-\s*)?name:\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(line);
    if (name) { if (cur && cur.name === null) cur.name = name[1]; else { cur = { id: null, name: name[1] }; rows.push(cur); } }
  }
  return rows;
}

/** 判据核心（纯函数：喂真模块、合成静默模块、变异模块都用它）。 */
function bootViolations(mod, ctx) {
  const bad = [];
  if (typeof mod.subpackageSpecifiers !== 'function') bad.push('subpackageSpecifiers 不是函数');
  if (typeof mod.assertSubpackagesResolvable !== 'function') bad.push('assertSubpackagesResolvable 不是函数');
  if (bad.length) return bad;
  // ① 文本口径：真实 patch 文本 → 净新增子包行
  let specs;
  try { specs = mod.subpackageSpecifiers(ctx.patchText, ctx.rootName); }
  catch (e) { return ['subpackageSpecifiers 抛错：' + e.message]; }
  if (!Array.isArray(specs) || specs.some((s) => typeof s !== 'string')) {
    bad.push('subpackageSpecifiers 返回值不是 string[]：' + JSON.stringify(specs));
  } else {
    const got = [...specs].sort(), want = [...ctx.rowSpecs].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) bad.push('净新增子包行集合 ' + JSON.stringify(got) + ' ≠ 主 patch 行集合 ' + JSON.stringify(want));
  }
  // ② 行为口径：正腿（全可解析，不由 ctx.resolvable 决定）⇒ 不抛；负腿（ctx.badName 解析不到）⇒ 抛 Error 且消息带 name 与 id
  const shapes = [
    { label: '{id,name}[]', rows: ctx.rows },
    { label: 'string[]', rows: ctx.rows.map((r) => r.name) },
  ];
  const canResolve = (n) => ctx.resolvable[n] || ('/node_modules/' + n);
  let chosen = null, lastErr = null;
  for (const s of shapes) {
    try { mod.assertSubpackagesResolvable(s.rows, canResolve); chosen = s; break; }
    catch (e) { lastErr = e; }
  }
  if (!chosen) return bad.concat(['全可解析时 assertSubpackagesResolvable 抛错（两种入参形状都试了）：' + (lastErr && lastErr.message)]);
  try {
    mod.assertSubpackagesResolvable(chosen.rows, (n) => (n === ctx.badName ? null : canResolve(n)));
    bad.push('有子包解析不到时**没有抛错**（静默通过 = §7.6① 失效）');
  } catch (e) {
    if (!(e instanceof Error)) bad.push('解析失败时抛的不是 Error：' + String(e));
    else if (!e.message.includes(ctx.badName)) bad.push('抛错消息里没有失败的包名 ' + ctx.badName + '：' + e.message);
    else if (ctx.badId && !e.message.includes(ctx.badId)) bad.push('抛错消息里没有失败的行 id ' + ctx.badId + '：' + e.message);
  }
  return bad;
}

/** 把相对 import 改写成绝对 file:// URL（供 data: URL 加载变异体/合成体）。 */
function absolutize(src, relDir) {
  // data: URL 模块里的 import.meta.url 是 data: URL ⇒ 钉成**真文件 URL**（同一目录下的 index.js），
  // 这样被测/合成源码里 `new URL('../x', import.meta.url)` 这类按文件位置解析的写法在 data: 体里也成立。
  const fileUrl = pathToFileURL(resolve(ROOT, relDir, 'index.js')).href;
  return String(src)
    .replace(/import\.meta\.url/g, JSON.stringify(fileUrl))
    .replace(/(from\s*|import\s*\(\s*)(['"])(\.[^'"]*)\2/g,
      (_m, pre, q, spec) => pre + q + pathToFileURL(resolve(ROOT, relDir, spec)).href + q);
}
async function importSource(src, relDir, tag) {
  const code = absolutize(src, relDir);
  return import('data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64') + '#' + tag);
}

// ─────────────────────────────────────────────────────────────────────────────
const rootPkg = JSON.parse(read('package.json'));
const rootName = rootPkg.name;
const patchText = read('cordis.patch.yml');
const rows = patchRows(patchText);
const discovered = discoverSubpackages();
const badManifests = discovered.filter((d) => d.error || !d.name);
const rowNames = rows.map((r) => r.name).filter(Boolean);
const rowSpecs = rowNames.filter((n) => n !== rootName && !n.startsWith(rootName + '/') && n.startsWith(rootName + '-'));

check('packages/ 下至少有一个子包（P-A 未落 ⇒ 判红，不放宽）', discovered.length > 0,
  discovered.length ? discovered.map((d) => d.dir + '=' + d.name).join(' / ') : 'packages/ 下没有带 package.json 的目录');
check('每个 packages/<dir>/package.json 都能解析且 name 非空', badManifests.length === 0,
  badManifests.map((d) => d.dir + '：' + (d.error || 'name 缺失')).join('；'));
if (discovered.length > 0) {
  const missingRows = discovered.filter((d) => d.name && !rowNames.includes(d.name)).map((d) => d.name);
  const deadRows = rowSpecs.filter((n) => !discovered.some((d) => d.name === n));
  check('子包 ⇄ 主 patch 净新增子包行 互为双射（无包的行 / 无行的包都要红）',
    missingRows.length === 0 && deadRows.length === 0,
    [missingRows.length ? '没被主 patch 插入行的子包（§2.2：行不在 patch 里 = 浏览器半边静默不存在）：' + missingRows.join(' / ') : '',
     deadRows.length ? '主 patch 里没有对应 packages/<dir> 的净新增行：' + deadRows.join(' / ') : ''].filter(Boolean).join('；'));
}
// 与 task-1 的包发现层（scripts/dev-link-subpackages.mjs）交叉对账：存在就必须一致。
const discoverMod = join(ROOT, 'scripts', 'dev-link-subpackages.mjs');
if (isFile(discoverMod)) {
  try {
    const m = await import(pathToFileURL(discoverMod).href);
    const theirs = typeof m.collectSubpackages === 'function' ? m.collectSubpackages(ROOT).map((p) => p.name).sort() : null;
    check('包发现层（scripts/dev-link-subpackages.mjs）与本判据的发现一致', theirs !== null && JSON.stringify(theirs) === JSON.stringify(discovered.map((d) => d.name).sort()),
      theirs === null ? '没有导出 collectSubpackages' : '它们=' + JSON.stringify(theirs) + ' · 本判据=' + JSON.stringify(discovered.map((d) => d.name).sort()));
  } catch (e) { check('包发现层可 import', false, e.message); }
} else {
  check('包发现层 scripts/dev-link-subpackages.mjs 存在（§8.1 开发期 junction 的真源）', false, '文件不存在');
}

// ② 契约模块 + 接线
const contractAbs = join(ROOT, CONTRACT_REL);
let mod = null, loadErr = null;
if (!isFile(contractAbs)) {
  check(CONTRACT_REL + ' 存在（§7.6① 的宿主自检落点）', false, '文件不存在');
} else {
  try { mod = await import(pathToFileURL(contractAbs).href); } catch (e) { loadErr = e; }
  check(CONTRACT_REL + ' 可 import 且导出两个契约函数', !loadErr && mod
    && typeof mod.subpackageSpecifiers === 'function' && typeof mod.assertSubpackagesResolvable === 'function',
    loadErr ? loadErr.message : '导出=' + JSON.stringify(Object.keys(mod || {})));
}
const facadeSrc = read('lib/index.js');
const facadeBody = functionBodyOf(stripComments(facadeSrc), APPLY_HEADER);
check('lib/index.js 的 apply 体里调用了 assertSubpackagesResolvable(...)（启动自检真接线）',
  facadeBody !== null && /assertSubpackagesResolvable\s*\(/.test(facadeBody)
  && /from\s*['"]\.\/subpackage-boot\.js['"]/.test(stripComments(facadeSrc)),
  facadeBody === null ? '定位不到 ' + APPLY_HEADER + ' 的函数体' : 'apply 体里没有调用 / 没有从 ./subpackage-boot.js 引入');
// 负对照 c：合成源码里没有接线 ⇒ 文本判据必须判红
const synthFacade = 'export function apply(ctx) { return () => {}; }\n';
const synthBody = functionBodyOf(stripComments(synthFacade), APPLY_HEADER);
check('负对照：合成 apply 体（无自检调用）⇒ 接线判据判红',
  !(synthBody !== null && /assertSubpackagesResolvable\s*\(/.test(synthBody)),
  '合成体=' + JSON.stringify(synthBody));

// ── ④ 服务面真接线（§5.1 ①）：apply() 的**第一件事**必须是 provide ────────────────
// 只查"调了没有"不够：顺序错（自检在前、服务在后）时子包 fiber 已经因缺服务 park，
// 服务的撤销语义也就没人验。所以同时钉住"先 provide，再启动自检"。
const facadeProvideRe = /provideSubpackageHost\s*\(\s*ctx\s*\)/;
const facadeAssertRe = /assertSubpackagesResolvable\s*\(/;
const facadeProvideImported = /import\s*\{[^}]*\bprovideSubpackageHost\b[^}]*\}\s*from\s*['"]\.\/subpackage-boot\.js['"]/.test(stripComments(facadeSrc));
check('lib/index.js 的 apply 体里调用了 provideSubpackageHost(ctx)（服务面真接线，import 自 ./subpackage-boot.js）',
  facadeBody !== null && facadeProvideRe.test(facadeBody) && facadeProvideImported,
  facadeBody === null ? '定位不到 apply 体' : ('apply 体里没有 provideSubpackageHost(ctx)=' + !facadeProvideRe.test(facadeBody) + ' / 没有从 ./subpackage-boot.js 具名引入=' + !facadeProvideImported));
const provideAt = facadeBody === null ? -1 : facadeBody.search(facadeProvideRe);
const assertAt = facadeBody === null ? -1 : facadeBody.search(facadeAssertRe);
check('服务面是主包 apply() 的**第一步**（provide 在子包启动自检之前）',
  provideAt >= 0 && assertAt >= 0 && provideAt < assertAt,
  'provide@' + provideAt + ' · assertSubpackagesResolvable@' + assertAt);
const synthFacade2 = 'export function apply(ctx) { assertSubpackagesResolvable([], () => null); return () => {}; }\n';
const synthBody2 = functionBodyOf(stripComments(synthFacade2), APPLY_HEADER);
check('负对照：合成 apply 体（没有 provideSubpackageHost(ctx)）⇒ 服务面接线判据判红',
  !(synthBody2 !== null && facadeProvideRe.test(synthBody2)), '合成体=' + JSON.stringify(synthBody2));
const synthBody3 = functionBodyOf(stripComments('export function apply(ctx) { assertSubpackagesResolvable([], () => null); provideSubpackageHost(ctx); }\n'), APPLY_HEADER);
check('负对照：合成 apply 体（自检在前、provide 在后 = 顺序错）⇒ 第一步判据判红',
  synthBody3 !== null && !(synthBody3.search(facadeProvideRe) < synthBody3.search(facadeAssertRe)),
  '合成体=' + JSON.stringify(synthBody3));


// ── ④b 跨包服务面契约（§5.1 ①；纯函数，真模块 / 合成体 / 真源码变异体同一判据）─────────
// 子包半边"零主包说明符"能成立，全押在这一份服务面上：名字、键集、冻结、以及
// provide 的**两条腿**（真宿主走 ctx.provide ⇒ 服务随主包 fiber 撤销、子包 inject 级联；
// 直调夹具没有 provide ⇒ 退回挂同名属性）。少哪条都是静默失效，必须逐条判红。
const HOST_SERVICE_LITERAL = 'wallpaperEngineHost';
const HOST_KEYS = ['ids', 'keyNames', 'keys', 'handOff', 'schema', 'http'];
const SCHEMA_KEYS = ['isFontSetId', 'sanitizeFontset', 'FONTSET_MIGRATED_ID', 'FONTSET_SCHEMA_TAG', 'systemFontKeyOf'];
const HTTP_KEYS = ['sendJson', 'bodyReader'];
const notSameSet = (a, b) => JSON.stringify([...a].sort()) !== JSON.stringify([...b].sort());

function serviceViolations(mod2, expectName) {
  const bad = [];
  if (typeof mod2.HOST_SERVICE_NAME !== 'string') { bad.push('HOST_SERVICE_NAME 不是字符串（导出=' + typeof mod2.HOST_SERVICE_NAME + '）'); return bad; }
  if (mod2.HOST_SERVICE_NAME !== expectName) bad.push('HOST_SERVICE_NAME=' + JSON.stringify(mod2.HOST_SERVICE_NAME) + ' ≠ 契约字面量 ' + JSON.stringify(expectName) + '（名字漂移 = 子包 inject 找不到服务）');
  if (typeof mod2.createSubpackageHost !== 'function') { bad.push('createSubpackageHost 不是函数'); return bad; }
  let host;
  try { host = mod2.createSubpackageHost(); } catch (e) { bad.push('createSubpackageHost() 抛错：' + e.message); return bad; }
  if (host === null || typeof host !== 'object') { bad.push('createSubpackageHost() 没返回对象：' + String(host)); return bad; }
  if (!Object.isFrozen(host)) bad.push('服务值没有 Object.freeze（子包能改写服务面）');
  const keys = Object.keys(host);
  if (keys.length !== HOST_KEYS.length || notSameSet(keys, HOST_KEYS)) bad.push('服务面键集 ' + JSON.stringify([...keys].sort()) + ' ≠ ' + JSON.stringify([...HOST_KEYS].sort()));
  for (const k of HOST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(host, k)) continue;
    if (k === 'schema' || k === 'http') { if (host[k] === null || typeof host[k] !== 'object') bad.push('host.' + k + ' 不是对象：' + typeof host[k]); continue; }
    if (typeof host[k] !== 'function') bad.push('host.' + k + ' 不是函数：' + typeof host[k]);
  }
  const schemaKeys = (host.schema && typeof host.schema === 'object') ? Object.keys(host.schema) : [];
  if (notSameSet(schemaKeys, SCHEMA_KEYS)) bad.push('schema 键集 ' + JSON.stringify([...schemaKeys].sort()) + ' ≠ ' + JSON.stringify([...SCHEMA_KEYS].sort()));
  else if (!Object.isFrozen(host.schema)) bad.push('schema 视图没有冻结（子包能改纯符号面）');
  const httpKeys = (host.http && typeof host.http === 'object') ? Object.keys(host.http) : [];
  if (notSameSet(httpKeys, HTTP_KEYS)) bad.push('http 键集 ' + JSON.stringify([...httpKeys].sort()) + ' ≠ ' + JSON.stringify([...HTTP_KEYS].sort()));
  else if (!Object.isFrozen(host.http)) bad.push('http 视图没有冻结（子包能改应答面）');
  if (typeof mod2.provideSubpackageHost !== 'function') { bad.push('provideSubpackageHost 不是函数'); return bad; }
  // 腿 1：真宿主（有 provide）—— 必须走 provide（fiber 级撤销是子包 inject 级联的物理基础）
  const provided = [];
  const realCtx = { provide(name, value) { provided.push([name, value]); } };
  let ret = null;
  try { ret = mod2.provideSubpackageHost(realCtx); } catch (e) { bad.push('provideSubpackageHost(真宿主) 抛错：' + e.message); }
  if (provided.length !== 1) bad.push('真宿主腿：ctx.provide 调用 ' + provided.length + ' 次（应恰好 1 次；0 次 = 服务不随主包 fiber 撤销，子包 inject 级联失效）');
  else {
    if (provided[0][0] !== mod2.HOST_SERVICE_NAME) bad.push('真宿主腿：ctx.provide 的服务名 ' + JSON.stringify(provided[0][0]) + ' ≠ HOST_SERVICE_NAME');
    if (provided[0][1] !== ret) bad.push('真宿主腿：ctx.provide 挂的值 ≠ 返回值');
  }
  if (Object.prototype.hasOwnProperty.call(realCtx, mod2.HOST_SERVICE_NAME)) bad.push('真宿主腿：既 provide 又挂同名属性（真宿主只许走 provide）');
  // 腿 2：直调夹具（无 provide）—— 退回挂同一份值；取不到就红
  const fixtureCtx = {};
  let ret2 = null;
  try { ret2 = mod2.provideSubpackageHost(fixtureCtx); } catch (e) { bad.push('provideSubpackageHost(直调夹具) 抛错：' + e.message); }
  if (ret2 === null || typeof ret2 !== 'object') bad.push('直调夹具腿：返回值不是对象');
  else if (fixtureCtx[mod2.HOST_SERVICE_NAME] !== ret2) bad.push('直调夹具腿：没有把服务挂到 ctx[' + mod2.HOST_SERVICE_NAME + ']（mock ctx 下子包取不到服务）');
  else if (!Object.isFrozen(ret2)) bad.push('直调夹具腿：服务值没冻结');
  return bad;
}

/** 合成服务面（负对照基准 + 各变异腿）。 */
const synthHost = (over) => {
  const base = {
    HOST_SERVICE_NAME: HOST_SERVICE_LITERAL,
    createSubpackageHost: () => Object.freeze({
      ids: () => [], keyNames: () => [], keys: () => ({}),
      handOff: (_c, dispose) => dispose,
      schema: Object.freeze({
        isFontSetId: () => false, sanitizeFontset: (v) => v,
        FONTSET_MIGRATED_ID: 'migrated', FONTSET_SCHEMA_TAG: 'tag', systemFontKeyOf: () => 'k',
      }),
      http: Object.freeze({ sendJson: () => true, bodyReader: () => ({}) }),
    }),
    provideSubpackageHost: (ctx) => {
      const value = base.createSubpackageHost();
      if (ctx && typeof ctx.provide === 'function') { ctx.provide(base.HOST_SERVICE_NAME, value); return value; }
      if (ctx && (typeof ctx === 'object' || typeof ctx === 'function')) {
        try { ctx[base.HOST_SERVICE_NAME] = value; } catch { /* 只读 ctx */ }
      }
      return value;
    },
  };
  return Object.assign(base, over || {});
};
const baseHostMod = synthHost();
const baseHostValue = baseHostMod.createSubpackageHost();

check('跨包服务面契约（HOST_SERVICE_NAME 字面量 / 6 键冻结 / schema 5 键 / http 2 键 / provide 真宿主+夹具两腿）',
  mod ? serviceViolations(mod, HOST_SERVICE_LITERAL).length === 0 : false,
  mod ? JSON.stringify(serviceViolations(mod, HOST_SERVICE_LITERAL)) : '契约模块没有加载成功');
check('负对照：合成服务面缺 handOff 键 ⇒ 判红（键集不许少）',
  serviceViolations(synthHost({ createSubpackageHost: () => Object.freeze({ ids: () => [], keyNames: () => [], keys: () => ({}), schema: baseHostValue.schema, http: baseHostValue.http }) }), HOST_SERVICE_LITERAL).length > 0);
check('负对照：合成服务面没冻结 ⇒ 判红',
  serviceViolations(synthHost({ createSubpackageHost: () => ({ ...baseHostValue }) }), HOST_SERVICE_LITERAL).length > 0);
check('负对照：服务名漂移 ⇒ 判红',
  serviceViolations(synthHost({ HOST_SERVICE_NAME: 'wallpaperFoo' }), HOST_SERVICE_LITERAL).length > 0);
check('负对照：schema 键漂移 ⇒ 判红',
  serviceViolations(synthHost({ createSubpackageHost: () => Object.freeze({ ...baseHostValue, schema: Object.freeze({ isFontSetId: () => false, sanitizeFontset: (v) => v, FONTSET_MIGRATED_ID: 'm', FONTSET_SCHEMA_TAG: 't' }) }) }), HOST_SERVICE_LITERAL).length > 0);
check('负对照：provide 腿被抹掉（真宿主只挂属性）⇒ 判红',
  serviceViolations(synthHost({ provideSubpackageHost: (ctx) => { const value = baseHostMod.createSubpackageHost(); try { ctx[baseHostMod.HOST_SERVICE_NAME] = value; } catch { /* 只读 */ } return value; } }), HOST_SERVICE_LITERAL).length > 0);
check('负对照：直调夹具腿不挂 ctx 属性（mock ctx 下子包取不到）⇒ 判红',
  serviceViolations(synthHost({ provideSubpackageHost: (ctx) => { const value = baseHostMod.createSubpackageHost(); if (ctx && typeof ctx.provide === 'function') ctx.provide(baseHostMod.HOST_SERVICE_NAME, value); return value; } }), HOST_SERVICE_LITERAL).length > 0);
const hostMutSrc = absolutize(read(CONTRACT_REL), 'lib').replace('ctx.provide(HOST_SERVICE_NAME, value)', 'void 0');
let hostMutant = null, hostMutErr = null;
try { hostMutant = await importSource(hostMutSrc, 'lib', 'host-mutant'); } catch (e) { hostMutErr = e; }
const hostMutBad = hostMutant ? serviceViolations(hostMutant, HOST_SERVICE_LITERAL) : ['变异体加载失败：' + (hostMutErr && hostMutErr.message)];
check('负对照：真源码变异（provide 调用被抹掉 = 服务不随主包 fiber 撤销）⇒ 服务面判据判红（证明判据有牙）',
  hostMutBad.length > 0, JSON.stringify(hostMutBad));

// ③ 行为判据（真模块）+ 合成静默模块负对照
const ctxData = {
  rootName, patchText, rowSpecs,
  rows, badName: null, badId: null, resolvable: {},
};
const silentSrc = 'export function subpackageSpecifiers() { return []; }\nexport function assertSubpackagesResolvable() { return true; }\n';
const silentMod = await importSource(silentSrc, 'lib', 'silent');
const synthRows = [
  { id: 'wallpaper-engine-fx', name: rootName + '-fx' },
  { id: 'wallpaper-engine-fonts', name: rootName + '-fonts' },
];
const synthPatch = "plugins:\n  - id: '" + rootName + "'\n    name: '" + rootName + "'\n  - id: 'wallpaper-engine-fx'\n    name: '" + rootName + "-fx'\n  # - name: '" + rootName + "-commented'\n  - id: 'wallpaper-engine-about-notice'\n    name: '" + rootName + "/about-notice'\n";
check('负对照：合成静默实现（把 throw 去掉的函数）必须被本判据判红',
  bootViolations(silentMod, { ...ctxData, rowSpecs: [rootName + '-fx'], resolvable: { [rootName + '-fx']: '/x' }, badName: rootName + '-fx', badId: 'wallpaper-engine-fx' }).length > 0,
  '静默实现违反项=' + JSON.stringify(bootViolations(silentMod, { ...ctxData, rowSpecs: [rootName + '-fx'], resolvable: {}, badName: rootName + '-fx', badId: 'wallpaper-engine-fx' })));

if (mod && typeof mod.subpackageSpecifiers === 'function') {
  // 负对照 a：合成 patch 文本的文本口径（注释行/裸行自身/子路径行都不许被收；净新增行必须收）
  let got;
  try { got = mod.subpackageSpecifiers(synthPatch, rootName); } catch (e) { got = 'THREW:' + e.message; }
  check('负对照：subpackageSpecifiers 合成 patch —— 注释行/裸行/子路径行都不收，只收 <root>-* 净新增行',
    Array.isArray(got) && JSON.stringify([...got].sort()) === JSON.stringify([rootName + '-fx']),
    '得到 ' + JSON.stringify(got));
}
if (mod && typeof mod.subpackageSpecifiers === 'function' && typeof mod.assertSubpackagesResolvable === 'function') {
  const resolvable = {};
  for (const r of synthRows) resolvable[r.name] = '/node_modules/' + r.name;
  check('启动自检的**正例**：全部子包可解析 ⇒ 不抛错', bootViolations(mod, {
    rootName, patchText: synthPatch, rowSpecs: [synthRows[0].name], rows: [synthRows[0]],
    resolvable: { [synthRows[0].name]: '/node_modules/' + synthRows[0].name }, badName: synthRows[0].name, badId: synthRows[0].id,
  }).length === 0, JSON.stringify(bootViolations(mod, {
    rootName, patchText: synthPatch, rowSpecs: [synthRows[0].name], rows: [synthRows[0]],
    resolvable: { [synthRows[0].name]: '/node_modules/' + synthRows[0].name }, badName: synthRows[0].name, badId: synthRows[0].id,
  })));
  // 真叶子 × 真 patch 文本：文本口径对账 + 负腿必须带 name/id
  const realBehav = bootViolations(mod, {
    rootName, patchText, rowSpecs, rows: synthRows,
    resolvable: { [synthRows[0].name]: '/node_modules/' + synthRows[0].name },
    badName: synthRows[1].name, badId: synthRows[1].id,
  });
  check('真叶子 × 真 patch 文本：文本口径与主 patch 行集合一致，且解析失败时抛 Error（消息带 name+id）', realBehav.length === 0, JSON.stringify(realBehav));
  // 负对照 b：真源码变异 —— 把 assertSubpackagesResolvable 里的 throw 抹掉，判据必须变红
  const src = read(CONTRACT_REL);
  const mutated = absolutize(src, 'lib').replace(/throw\s+new\s+/g, '/*mut*/ void 0; // ');
  let mutant = null, mutErr = null;
  try { mutant = await importSource(mutated, 'lib', 'boot-mutant'); } catch (e) { mutErr = e; }
  const mutBad = mutant ? bootViolations(mutant, {
    rootName, patchText: synthPatch, rowSpecs: [synthRows[0].name], rows: [synthRows[0]],
    resolvable: {}, badName: synthRows[0].name, badId: synthRows[0].id,
  }) : ['变异体加载失败：' + (mutErr && mutErr.message)];
  check('负对照：真源码变异（\`throw new\` 被抹掉 = 自检静默）⇒ 本判据判红（证明判据有牙）',
    mutBad.length > 0, JSON.stringify(mutBad));
}

if (failed) { console.log('SUBPACKAGE BOOT CHECKS FAILED — ' + failed + ' failed'); process.exit(1); }
console.log('ALL SUBPACKAGE BOOT CHECKS PASSED');
process.exit(0);
