#!/usr/bin/env node
/**
 * verify-subpackage-client-half.mjs -- BUNDLE-SPLIT 7.6(2) 浏览器半边在场（P-A 子包族）
 *
 * 故障形态（2.2 + C2）：浏览器半边只能被"活动的 Loader 行"发现 -- 行不在某个已选中 bundle 的
 * patch 里、或包没有 dsh.client / exports["./client"] 时，客户端拿不到那份代码，宿主不报任何错。
 *
 * 范围（lead 裁定，数据驱动、可小可空）：只对**声明了 dsh.client** 的子包逐项检查；P-A 只有
 * fx/parallax 声明（fonts 的浏览器半边留在主 bundle，属 P-B/P-C）。集合为空时打印计数并通过。
 * 有浏览器半边但没声明 dsh.client 的包只做**信息行**（"停在主 bundle"），不算违反。
 *
 * 每个声明 dsh.client 的包要求三面对齐：
 *   1. dsh.client 形状与根 package.json 的 dsh.client 一致（web / immediately / 同键集）。
 *   2. exports["./client"] 必须指向 packages/<pkg>/lib/client.<short>.js
 *      （<short> = 包名去掉 dsh-plugin-wallpaper-engine- 前缀）。
 *   3. 该产物存在、非空，且文件头里注册 window.__ModuleLoader__.load({ id: "<子包真实包名>" })。
 *   4. 该 id 只出现在恰好一个产物里，且根产物 lib/client.js 里不出现（③④）。
 *   5. 该包的行（name = 真实包名）必须被根 cordis.patch.yml 插入。
 * 产物缺失时的报错必须提示"先跑 npm run build"（verify 组单独跑时没有产物），不许静默通过。
 * 负对照全部在内存里喂纯函数 clientHalfViolations()。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './tools/js-text.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHORT_PREFIX = 'dsh-plugin-wallpaper-engine-';
let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log('  ok  ' + name);
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n      ' + detail : '')); }
}
const isFile = (abs) => { try { return statSync(abs).isFile(); } catch { return false; } };
const isDir = (abs) => { try { return statSync(abs).isDirectory(); } catch { return false; } };
const readAbs = (abs) => (isFile(abs) ? readFileSync(abs, 'utf8') : null);
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const shortOf = (name) => (name.indexOf(SHORT_PREFIX) === 0 ? name.slice(SHORT_PREFIX.length) : null);

function walkFiles(dir, out) {
  out = out || [];
  if (!isDir(dir)) return out;
  for (const n of readdirSync(dir).sort()) {
    const abs = join(dir, n);
    if (isDir(abs)) { if (n !== 'node_modules' && n !== '.test-cache') walkFiles(abs, out); }
    else if (/\.(?:js|mjs)$/.test(n)) out.push(abs);
  }
  return out;
}

function discoverSubpackages() {
  const dir = join(ROOT, 'packages');
  if (!isDir(dir)) return [];
  const out = [];
  for (const n of readdirSync(dir).sort()) {
    const pj = join(dir, n, 'package.json');
    if (!isFile(pj)) continue;
    let manifest = null, error = null;
    try { manifest = JSON.parse(readFileSync(pj, 'utf8')); } catch (e) { error = e.message; }
    out.push({ dir: 'packages/' + n, abs: join(dir, n), manifest, error });
  }
  return out;
}

function patchRowNames() {
  const out = [];
  for (const line of read('cordis.patch.yml').split('\n')) {
    const m = /^\s*(?:-\s*)?name:\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** 全部客户端产物（根 lib/ 与各包 lib/ 下的 client*.js）。 */
function listClientArtifacts(pkgs) {
  const out = {};
  const roots = [join(ROOT, 'lib')];
  for (const p of pkgs) roots.push(join(p.abs, 'lib'));
  for (const abs of roots) {
    if (!isDir(abs)) continue;
    for (const n of readdirSync(abs).sort()) {
      if (!/^client.*\.js$/.test(n)) continue;
      const file = join(abs, n);
      out[relative(ROOT, file).split('\\').join('/')] = readAbs(file) || '';
    }
  }
  return out;
}

/** 产物 text 里是否注册了包 name（注册在文件头，只看前 400 字符）。 */
function registers(text, name) {
  if (typeof text !== 'string') return false;
  const i = text.indexOf('__ModuleLoader__');
  if (i < 0) return false;
  const head = text.slice(i, i + 400);
  for (const q of ['"', "'"]) if (head.indexOf('id: ' + q + name + q) >= 0) return true;
  return new RegExp('id\\s*:\\s*["' + "'" + ']' + name + '["' + "'" + ']').test(head);
}

/** 判据核心（纯函数）。 */
function clientHalfViolations(inp) {
  const bad = [];
  const name = inp.name, dir = inp.dir, manifest = inp.manifest || {};
  const exp = manifest.exports || {};
  const dc = manifest.dsh && manifest.dsh.client;
  if (!dc) return bad;                       // 未声明 dsh.client 的包不在本判据范围内
  const short = shortOf(name);
  // 1) dsh.client 形状与根一致
  if (!inp.rootDshClient) bad.push('根 package.json 没有 dsh.client（基准缺失）');
  else {
    for (const k of Object.keys(inp.rootDshClient)) if (!(k in dc)) bad.push(dir + ' 的 dsh.client 缺键 ' + k);
    if (dc.platform !== 'web') bad.push(dir + ' 的 dsh.client.platform=' + JSON.stringify(dc.platform) + ' 不等于 "web"');
    if (dc.immediately !== true) bad.push(dir + ' 的 dsh.client.immediately=' + JSON.stringify(dc.immediately) + ' 不等于 true');
  }
  // 2) exports["./client"] 落点规则
  const target = typeof exp['./client'] === 'string' ? exp['./client'].replace(/^\.\//, '') : null;
  if (!short) bad.push(name + ' 不是 ' + SHORT_PREFIX + '<short> 形态的包名，无法推导产物名');
  const want = short ? dir + '/lib/client.' + short + '.js' : null;
  if (!target) bad.push(dir + ' 声明了 dsh.client 却没有 exports["./client"]');
  else if (want && dir + '/' + target !== want) bad.push(dir + ' 的 exports["./client"]=' + JSON.stringify(exp['./client']) + '，必须指向 ' + want);
  // 3/4) 产物与注册唯一性
  if (target) {
    const rel = dir + '/' + target;
    const text = Object.prototype.hasOwnProperty.call(inp.artifacts, rel) ? inp.artifacts[rel] : null;
    if (text === null) bad.push(rel + ' 不存在（先跑 npm run build：verify 组单独跑时还没有客户端产物）');
    else if (text.length < 1000) bad.push(rel + ' 只有 ' + text.length + ' 字符（产物像空壳）');
    else if (!registers(text, name)) bad.push(rel + ' 里没有 window.__ModuleLoader__.load({ id: "' + name + '" ... }) 注册（id 必须是子包真实包名）');
    const owners = Object.keys(inp.artifacts).filter((k) => registers(inp.artifacts[k], name));
    if (owners.length > 1) bad.push('包 ' + name + ' 的客户端注册出现在多份产物里：' + owners.join(' / ') + '（只许一份）');
    if (owners.length === 1 && owners[0] !== rel) bad.push('包 ' + name + ' 的客户端注册在 ' + owners[0] + '，而 exports["./client"] 指向 ' + rel);
    if (inp.rootClientRel && rel === inp.rootClientRel) bad.push(dir + ' 的 exports["./client"] 指向根产物 ' + inp.rootClientRel);
    if (inp.rootClientRel && Object.prototype.hasOwnProperty.call(inp.artifacts, inp.rootClientRel)
      && registers(inp.artifacts[inp.rootClientRel], name)) bad.push('根产物 ' + inp.rootClientRel + ' 里也注册了 ' + name + '（同一份浏览器半边不许内联两处）');
  }
  // 5) 行必须被根 patch 插入
  if (!inp.rowNames.includes(name)) bad.push('主 patch（' + inp.rootName + ' 的 cordis.patch.yml）里没有 name: "' + name + '" 的行 => 2.2 静默失效');
  return bad;
}

// ---------------------------------------------------------------------------
const rootPkg = JSON.parse(read('package.json'));
const rootName = rootPkg.name;
const rootDshClient = (rootPkg.dsh && rootPkg.dsh.client) || null;
const rootClientRel = rootPkg.exports && typeof rootPkg.exports['./client'] === 'string'
  ? rootPkg.exports['./client'].replace(/^\.\//, '') : null;
const pkgs = discoverSubpackages();
const rowNames = patchRowNames();
const artifacts = listClientArtifacts(pkgs);
const usable = pkgs.filter((p) => p.manifest && !p.error);
check('packages/ 下至少有一个子包（P-A 未落判红）', pkgs.length > 0, pkgs.map((p) => p.dir).join(' / '));
check('每个子包 manifest 可解析', usable.length === pkgs.length, pkgs.filter((p) => p.error).map((p) => p.dir + '：' + p.error).join('；'));

const declared = [], browserHalfNoDecl = [];
for (const p of usable) {
  const half = [];
  for (const abs of walkFiles(join(p.abs, 'src')).concat(walkFiles(join(p.abs, 'lib')))) {
    const t = readAbs(abs);
    if (t && /\b(?:window|document)\b/.test(stripComments(t))) half.push(relative(ROOT, abs).split('\\').join('/'));
  }
  const has = !!(p.manifest.dsh && p.manifest.dsh.client);
  if (has) declared.push({ name: p.manifest.name, dir: p.dir, manifest: p.manifest, browserHalf: half, artifacts, rowNames, rootName, rootClientRel, rootDshClient });
  else if (half.length > 0) browserHalfNoDecl.push(p.manifest.name + '（' + half.length + ' 个文件，留在主 bundle）');
}
if (declared.length === 0) {
  console.log('    · 声明 dsh.client 的子包 0 个（P-A 范围）-> 本判据无对象，通过');
} else {
  const real = [];
  for (const i of declared) for (const v of clientHalfViolations(i)) real.push(v);
  check('声明 dsh.client 的 ' + declared.length + ' 个子包：声明面 <-> 产物 <-> 主 patch 行 三面对齐', real.length === 0, real.join('\n      '));
}
if (browserHalfNoDecl.length > 0) console.log('    · 有浏览器半边但未声明 dsh.client（不算违反，P-B/P-C 再迁）：' + browserHalfNoDecl.join(' / '));

// -- 负对照 ------------------------------------------------------------------
const okDshClient = rootDshClient || { platform: 'web', immediately: true, inject: [] };
const PAD = '/* pad */'.repeat(200);
const mkIn = (over) => {
  const o = {
    name: 'dsh-plugin-wallpaper-engine-fx', dir: 'packages/fx',
    manifest: { name: 'dsh-plugin-wallpaper-engine-fx', dsh: { client: JSON.parse(JSON.stringify(okDshClient)) }, exports: { './client': './lib/client.fx.js' } },
    rowNames: [rootName, 'dsh-plugin-wallpaper-engine-fx'],
    artifacts: {
      'packages/fx/lib/client.fx.js': 'window.__ModuleLoader__.load({ id: "dsh-plugin-wallpaper-engine-fx", factory: (require) => { return {}; } });' + PAD,
      'lib/client.js': 'window.__ModuleLoader__.load({ id: "' + rootName + '", factory: () => {} });',
    },
    rootClientRel: 'lib/client.js', rootDshClient,
  };
  if (over) over(o);
  return o;
};
const baseline = clientHalfViolations(mkIn());
check('负对照基准：正确形态（声明/落点/产物/行）0 违反项', baseline.length === 0, JSON.stringify(baseline));
const neg = (label, mutate, expectRe) => {
  const v = clientHalfViolations(mkIn(mutate));
  check('负对照：' + label, v.some((s) => expectRe.test(s)), '违反项=' + JSON.stringify(v));
};
neg('声明了 dsh.client 但产物没构建（缺产物文案要提示先跑 build）', (o) => { o.artifacts = { 'lib/client.js': mkIn().artifacts['lib/client.js'] }; }, /先跑 npm run build/);
neg('exports["./client"] 落点不对判红', (o) => { o.manifest.exports['./client'] = './lib/client.js'; delete o.artifacts['packages/fx/lib/client.fx.js']; }, /必须指向|不存在/);
neg('产物里没有该包 id 的注册判红', (o) => { o.artifacts['packages/fx/lib/client.fx.js'] = 'window.__ModuleLoader__.load({ id: "somebody-else" });' + PAD; }, /注册/);
neg('产物像空壳判红', (o) => { o.artifacts['packages/fx/lib/client.fx.js'] = 'window.__ModuleLoader__.load({ id: "dsh-plugin-wallpaper-engine-fx" });'; }, /产物像空壳/);
neg('同一注册出现两份判红', (o) => { o.artifacts['lib/client.fx.bis.js'] = mkIn().artifacts['packages/fx/lib/client.fx.js']; }, /多份产物/);
neg('根产物里也注册了同一个包判红', (o) => { o.artifacts['lib/client.js'] = mkIn().artifacts['packages/fx/lib/client.fx.js']; }, /内联两处|多份产物/);
neg('主 patch 里没有该行判红', (o) => { o.rowNames = [rootName]; }, /没有 name/);
neg('dsh.client 缺根里的键判红', (o) => { delete o.manifest.dsh.client.inject; }, /缺键/);
check('负对照：未声明 dsh.client 的包不产生任何违反项（范围外）', clientHalfViolations(mkIn((o) => { delete o.manifest.dsh.client; })).length === 0);

if (failed) { console.log('SUBPACKAGE CLIENT-HALF CHECKS FAILED -- ' + failed + ' failed'); process.exit(1); }
console.log('ALL SUBPACKAGE CLIENT-HALF CHECKS PASSED');
process.exit(0);
