#!/usr/bin/env node
/**
 * verify-subpackage-purity.mjs -- BUNDLE-SPLIT 7.6(3) 跨包纯度（P-A 子包族）
 *
 * 2.1/2.2：包边界就是卸载边界。子包之间的任何 import（裸名或相对跨到 packages/<other>）都会把
 * 两个包在模块图上粘死：关掉其中一个，另一个还握着它的模块实例。
 *
 * 允许的跨包面（lead 裁定，Service 口径 = 收窄后的**唯一**面）：
 *   · node: 内置（包内相对 import 照常）；
 *   · 子包宿主半边**零主包说明符**：既不 import 主包裸名，也不 import 主包任何子路径
 *     （旧叶子 specifier 'dsh-plugin-wallpaper-engine/subpackage-boot.js' 同样判红）；
 *     唯一的跨包通道是 **Cordis Service**：`export const inject = ['<HOST_SERVICE_NAME>']`
 *     + 在 apply 里从 `ctx[HOST_SERVICE_NAME]` 取用（§5.1 ① / §5.2 允许清单 1）。
 *     服务名**不硬编码在判据里**：本文件动态 import lib/subpackage-boot.js 读它的
 *     `HOST_SERVICE_NAME` 导出，逐包逐字对账 —— 名字漂移即判红。
 *   · require('dsh-plugin-wallpaper-engine') 这条**浏览器侧**通道只允许出现在子包客户端产物
 *     （packages/<pkg>/lib/client*.js）里，宿主半边里出现即违规；例外面不扩大。
 * 其余裸包必须在自己 dependencies/peerDependencies/optionalDependencies（客户端产物可放宽到
 * dsh.client.inject 声明面）里声明；相对 import 一律不许逃出本包；也不许自引用。
 * 宿主半边 inject 与使用面一致：用了 ctx.<key> 就必须在该文件 export const inject = [...] 里声明；
 * 声明了 inject 的半边必须含 HOST_SERVICE_NAME，子包宿主入口还必须真的从 ctx 取用它。
 * 负对照全部在内存里喂纯函数 purityViolations()。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './tools/js-text.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log('  ok  ' + name);
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n      ' + detail : '')); }
}
const isFile = (abs) => { try { return statSync(abs).isFile(); } catch { return false; } };
const isDir = (abs) => { try { return statSync(abs).isDirectory(); } catch { return false; } };
const readAbs = (abs) => (isFile(abs) ? readFileSync(abs, 'utf8') : null);
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const relOf = (abs) => relative(ROOT, abs).split(sep).join('/');

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

/** 抽取 3 种形态的 import 说明符（已去注释）。 */
function specifiersOf(text) {
  const src = stripComments(text);
  const out = [], seen = new Set();
  const push = (s, i, kind) => { const k = kind + '|' + s; if (!seen.has(k)) { seen.add(k); out.push({ spec: s, index: i, kind }); } };
  const res = [
    [/(?:^|[\s;{(])(?:import|export)\s[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g, 'from'],
    [/(?:^|[\s;{(])import\s*['"]([^'"]+)['"]/g, 'side'],
    [/(?:^|[^.\w$])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g, 'dynamic'],
  ];
  for (const pair of res) {
    const re = pair[0], kind = pair[1];
    let m;
    while ((m = re.exec(src)) !== null) push(m[1], m.index, kind);
  }
  return out;
}

const norm = (abs) => resolve(abs).split(sep).join('/');
const inside = (child, parent) => norm(child).indexOf(norm(parent) + '/') === 0;
const isClientArtifact = (abs) => /\/lib\/client[^/]*\.js$/.test(norm(abs));

const rootNameOf = (spec) => {
  const p = spec.split('/');
  return spec.charAt(0) === '@' ? p.slice(0, 2).join('/') : p[0];
};
function declaredFace(manifest, spec) {
  const rootName = rootNameOf(spec);
  const fam = [manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies, manifest.devDependencies];
  for (const d of fam) if (d && Object.prototype.hasOwnProperty.call(d, rootName)) return true;
  return false;
}
function clientInjectedFace(manifest, spec) {
  const rootName = rootNameOf(spec);
  const inj = (manifest.dsh && manifest.dsh.client && manifest.dsh.client.inject) || [];
  return inj.indexOf(rootName) >= 0;
}
/** 子包宿主入口（manifest.main，缺省 ./lib/index.js）在仓内的相对路径；null = 入口跑出本包。 */
function hostEntryRel(pkg) {
  if (!pkg || !pkg.manifest) return null;
  const main = (typeof pkg.manifest.main === 'string' && pkg.manifest.main.trim()) ? pkg.manifest.main.trim() : './lib/index.js';
  const abs = resolve(pkg.abs, main);
  return inside(abs, pkg.abs) ? relOf(abs) : null;
}

/**
 * 判据核心（纯函数）。
 *
 * @param {{pkg:object, siblings:object[], rootPkg:object, files:{abs:string,text:string}[],
 *          hostServiceName?:string|null}} inp hostServiceName = 从主包动态读来的服务名；null/缺省 = 不做服务名对账
 */
function purityViolations(inp) {
  const bad = [];
  const pkg = inp.pkg, name = pkg.manifest.name;
  const hostService = (typeof inp.hostServiceName === 'string' && inp.hostServiceName) ? inp.hostServiceName : null;
  const hostLabel = hostService || 'HOST_SERVICE_NAME';
  const entryRel = hostEntryRel(pkg);
  const siblings = inp.siblings.map((s) => ({ name: s.manifest.name, abs: s.abs, dir: s.dir }));
  for (const file of inp.files) {
    const rel = relOf(file.abs), base = dirname(file.abs), clientSide = isClientArtifact(file.abs);
    for (const sp of specifiersOf(file.text)) {
      const spec = sp.spec;
      if (spec.indexOf('node:') === 0) continue;
      if (builtinModules.indexOf(spec) >= 0) continue;
      if (spec.charAt(0) === '.' || spec.charAt(0) === '/') {
        const target = resolve(base, spec);
        if (inside(target, pkg.abs)) {
          const cands = [target, target + '.js', target + '.mjs', join(target, 'index.js')];
          if (!cands.some(isFile)) bad.push(rel + ' 相对 import ' + spec + ' 的目标不存在（' + relOf(target) + '）');
          continue;
        }
        const sib = siblings.filter((s) => inside(target, s.abs))[0];
        if (sib) { bad.push(rel + ' 跨子包相对 import ' + spec + ' -> 子包 ' + sib.name + '（2.1 包边界=卸载边界，禁止）'); continue; }
        bad.push(rel + ' 相对 import ' + spec + ' 逃出本包到 ' + relOf(target) + '（子包不许相对 import 主包文件；跨包面只许 Cordis Service ctx.' + hostLabel + '）');
        continue;
      }
      if (spec === name) { bad.push(rel + ' 自引用裸包名 ' + spec); continue; }
      if (siblings.some((s) => s.name === spec || spec.indexOf(s.name + '/') === 0)) {
        bad.push(rel + ' 跨子包 value import ' + spec + '（子包之间不许直接 import）'); continue;
      }
      if (spec === inp.rootPkg.name || spec.indexOf(inp.rootPkg.name + '/') === 0) {
        if (spec === inp.rootPkg.name && clientSide) continue;   // 浏览器侧唯一允许的主包通道（产物 face）
        bad.push(rel + ' 宿主半边 import 主包说明符 ' + spec + '（§5.2：子包半边零主包说明符，只许 Cordis Service ctx.' + hostLabel + '）');
        continue;
      }
      if (clientSide && clientInjectedFace(pkg.manifest, spec)) continue;
      if (!declaredFace(pkg.manifest, spec)) bad.push(rel + ' 裸包 import ' + spec + ' 未在 ' + name + ' 的 dependencies/peerDependencies/optionalDependencies 里声明');
    }
    const inj = /export\s+const\s+inject\s*=\s*\[([^\]]*)\]/.exec(stripComments(file.text));
    if (inj) {
      const listed = inj[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      const body = stripComments(file.text), used = new Set();
      const cre = /\bctx\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([A-Za-z_$][\w$]*)['"]\s*\])/g;
      let m;
      while ((m = cre.exec(body)) !== null) used.add(m[1] || m[2]);
      for (const k of used) if (listed.indexOf(k) < 0) bad.push(rel + ' 用了 ctx.' + k + ' 但 inject=[' + listed.join(', ') + '] 里没有声明它（inject 使用面与声明面必须一致）');
      if (hostService && !clientSide && listed.indexOf(hostService) < 0) {
        bad.push(rel + ' 宿主半边 export const inject=[' + listed.join(', ') + "] 里没有 '" + hostService + "'（§5.1 ①：子包半边唯一跨包面 = 主包服务名，逐字对账 lib/subpackage-boot.js 的 HOST_SERVICE_NAME）");
      }
    }
    if (hostService && !clientSide && entryRel && rel === entryRel) {
      if (!inj) bad.push(rel + " 宿主入口没有 export const inject = [...]（§5.1 ①：必须 inject '" + hostService + "'）");
      else {
        const body = stripComments(file.text);
        const useRe = new RegExp('\\bctx\\s*(?:\\.\\s*' + hostService + '\\b|\\[\\s*[\'"]' + hostService + '[\'"]\\s*\\])');
        if (!useRe.test(body)) bad.push(rel + ' 宿主入口没有从 ctx 取用 ' + hostService + '（§5.1 ①：不许 import 主包说明符，只许 ctx.' + hostService + '）');
      }
    }
  }
  return bad;
}

// ---------------------------------------------------------------------------
// 服务名真源：动态读主包（§5.1 ①），判据里不硬编码。
const HOST_SERVICE_FALLBACK = 'wallpaperEngineHost';
let HOST_SERVICE_NAME = null, hostServiceError = null;
try {
  const boot = await import(pathToFileURL(join(ROOT, 'lib/subpackage-boot.js')).href);
  HOST_SERVICE_NAME = boot.HOST_SERVICE_NAME;
} catch (e) { hostServiceError = e.message; }
check('lib/subpackage-boot.js 的 HOST_SERVICE_NAME 可动态读入（判据真源）',
  typeof HOST_SERVICE_NAME === 'string' && HOST_SERVICE_NAME.length > 0,
  hostServiceError || ('HOST_SERVICE_NAME=' + String(HOST_SERVICE_NAME)));
const HOST = (typeof HOST_SERVICE_NAME === 'string' && HOST_SERVICE_NAME) ? HOST_SERVICE_NAME : HOST_SERVICE_FALLBACK;

const rootPkg = JSON.parse(read('package.json'));
const pkgs = discoverSubpackages();
check('packages/ 下至少有一个子包（P-A 未落判红）', pkgs.length > 0, pkgs.map((p) => p.dir).join(' / '));
const usable = pkgs.filter((p) => p.manifest && !p.error);
check('每个子包 manifest 可解析', usable.length === pkgs.length, pkgs.filter((p) => p.error).map((p) => p.dir + '：' + p.error).join('；'));

if (usable.length > 0) {
  const inputs = usable.map((p) => ({
    pkg: p, siblings: usable.filter((s) => s.dir !== p.dir), rootPkg, hostServiceName: HOST_SERVICE_NAME,
    files: walkFiles(p.abs).map((abs) => ({ abs, text: readAbs(abs) || '' })),
  }));
  const real = [];
  for (const i of inputs) for (const v of purityViolations(i)) real.push(v);
  check('子包 import 面纯度（零主包说明符 / 无跨子包 import / 依赖面已声明 / inject 一致）', real.length === 0, real.join('\n      '));
  const entryMiss = [];
  for (const i of inputs) {
    const e = hostEntryRel(i.pkg);
    if (!e || !i.files.some((f) => relOf(f.abs) === e)) entryMiss.push(i.pkg.dir + '（' + (e || '入口跑出本包') + '）');
  }
  check('每个子包宿主入口（manifest.main）都在扫描面内，服务名判据真的作用到它', entryMiss.length === 0, entryMiss.join('；'));
  const files = inputs.reduce((n, i) => n + i.files.length, 0);
  const specs = inputs.reduce((n, i) => n + i.files.reduce((m2, f) => m2 + specifiersOf(f.text).length, 0), 0);
  console.log('    · 扫描 ' + inputs.length + ' 个子包 / ' + files + ' 个文件 / ' + specs + ' 条 import / 服务名 ' + HOST);
}

// -- 负对照 ------------------------------------------------------------------
const MOD = 'dsh-plugin-wallpaper-engine-fx';
const mkPkg = (name, deps) => ({ dir: 'packages/fx', abs: join(ROOT, 'packages', 'fx'), manifest: { name, dependencies: deps || {} }, error: null });
const other = { dir: 'packages/parallax', abs: join(ROOT, 'packages', 'parallax'), manifest: { name: 'dsh-plugin-wallpaper-engine-parallax', dependencies: {} }, error: null };
const mk = (files, opts) => {
  const pkg = (opts && opts.pkg) || mkPkg(MOD, (opts && opts.deps) || {});
  return {
    pkg, siblings: (opts && opts.siblings) || [other], rootPkg,
    hostServiceName: (opts && 'hostServiceName' in opts) ? opts.hostServiceName : HOST,
    files: files.map((f) => ({ abs: join(pkg.abs, f.rel), text: f.text })),
  };
};
const baseline = purityViolations(mk([{ rel: 'src/fx-layer.js', text: "import { readFileSync } from 'node:fs';\nexport function apply() {}\n" }]));
check('负对照基准：node 内置 + 无跨包面 0 违反项', baseline.length === 0, JSON.stringify(baseline));
const PURITY_RE = /纯度|跨子包|自引用|未在|inject 使用面|逃出本包|只许|宿主半边|宿主入口|主包说明符|里没有 '|没有从 ctx 取用/;
const neg = (label, files, expectRe, opts) => {
  const v = purityViolations(mk(files, opts));
  check('负对照：' + label, v.some((s) => expectRe.test(s)), '违反项=' + JSON.stringify(v));
};
const negOk = (label, files, opts) => {
  const v = purityViolations(mk(files, opts));
  check('负对照：' + label, !v.some((s) => PURITY_RE.test(s)), JSON.stringify(v));
};
neg('跨子包相对 import 判红', [{ rel: 'src/a.js', text: "import { x } from '../../parallax/src/parallax-layer.js';\n" }], /跨子包相对 import/);
neg('跨子包裸包 import 判红', [{ rel: 'src/a.js', text: "import { x } from 'dsh-plugin-wallpaper-engine-parallax';\n" }], /跨子包 value import/);
neg('未声明裸包 import 判红', [{ rel: 'src/a.js', text: "import { x } from 'lodash';\n" }], /未在 .* 里声明/);
neg('自引用裸包名判红', [{ rel: 'src/a.js', text: "import { x } from 'dsh-plugin-wallpaper-engine-fx';\n" }], /自引用裸包名/);
neg('逃出本包到主包的相对 import 判红', [{ rel: 'src/a.js', text: "import { x } from '../../../lib/host-boot.js';\n" }], /逃出本包/);
neg('用了 ctx.webServer 但 inject 没声明判红', [{ rel: 'lib/index.js', text: "export const inject = [];\nexport function apply(ctx) { ctx.webServer.register({}); }\n" }], /inject 使用面/);
neg('宿主半边 import 主包裸名判红（零主包说明符）', [{ rel: 'lib/index.js', text: "import root from 'dsh-plugin-wallpaper-engine';\n" }], /宿主半边 import 主包说明符/);
neg('宿主半边 import 旧叶子 subpackage-boot.js 判红', [{ rel: 'lib/index.js', text: "import { subpackageKeys } from 'dsh-plugin-wallpaper-engine/subpackage-boot.js';\n" }], /宿主半边 import 主包说明符/);
neg('宿主半边 require 旧叶子 subpackage-boot.js 判红', [{ rel: 'lib/index.js', text: "const { subpackageKeys } = require('dsh-plugin-wallpaper-engine/subpackage-boot.js');\n" }], /宿主半边 import 主包说明符/);
neg('主包其它子路径判红', [{ rel: 'lib/a.js', text: "import { x } from 'dsh-plugin-wallpaper-engine/lib/host-boot.js';\n" }], /宿主半边 import 主包说明符/);
negOk('客户端产物里 require("dsh-plugin-wallpaper-engine") 不判红', [{ rel: 'lib/client.fx.js', text: "const root = require('dsh-plugin-wallpaper-engine');\n" }]);
negOk('dsh.client.inject 声明的裸包在客户端产物里不判红', [{ rel: 'lib/client.fx.js', text: "const r = require('@deepseek-ai/dsh-client-runtime');\n" }], { pkg: (() => { const p = mkPkg(MOD); p.manifest.dsh = { client: { inject: ['@deepseek-ai/dsh-client-runtime'] } }; return p; })() });
negOk('inject 声明齐全（含服务名 + 真取用）-> 不触发', [{ rel: 'lib/index.js', text: "export const inject = ['webServer', '" + HOST + "'];\nexport function apply(ctx) { const host = ctx." + HOST + "; ctx.webServer.register({}); host.keys('fx', ctx); }\n" }]);
negOk('服务名以 ctx["<名>"] 括号取用同样认账', [{ rel: 'lib/index.js', text: "export const inject = ['" + HOST + "'];\nexport function apply(ctx) { const host = ctx['" + HOST + "']; host.keys('fx'); }\n" }]);
neg('宿主半边 inject 里缺服务名判红', [{ rel: 'lib/index.js', text: "export const inject = ['webServer'];\nexport function apply(ctx) { const host = ctx." + HOST + "; ctx.webServer.register({}); host.keys('fx'); }\n" }], /里没有 '/);
neg('宿主入口 inject 了服务名但从不取用判红', [{ rel: 'lib/index.js', text: "export const inject = ['webServer', '" + HOST + "'];\nexport function apply(ctx) { ctx.webServer.register({}); }\n" }], /没有从 ctx 取用/);
neg('宿主入口完全没有 inject 判红', [{ rel: 'lib/index.js', text: "export function apply(ctx) { const host = ctx." + HOST + "; host.keys('fx'); }\n" }], /宿主入口没有 export const inject/);
negOk('已声明 peer 的裸包 import 不判红', [{ rel: 'lib/a.js', text: "import { x } from 'some-peer';\n" }], { deps: {}, pkg: (() => { const p = mkPkg(MOD); p.manifest.peerDependencies = { 'some-peer': '^1.0.0' }; return p; })() });
negOk('客户端产物不背宿主 inject 义务（服务名对账不越界）', [{ rel: 'lib/client.fx.js', text: "const root = require('dsh-plugin-wallpaper-engine');\nexport const inject = ['webServer'];\n" }]);
check('负对照：服务名对账在 hostServiceName=null 时整体关闸（不误报旧口径输入）',
  purityViolations(mk([{ rel: 'lib/index.js', text: "export function apply() {}\n" }], { hostServiceName: null })).length === 0);

if (failed) { console.log('SUBPACKAGE PURITY CHECKS FAILED -- ' + failed + ' failed'); process.exit(1); }
console.log('ALL SUBPACKAGE PURITY CHECKS PASSED');
process.exit(0);
