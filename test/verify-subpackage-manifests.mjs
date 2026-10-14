#!/usr/bin/env node
/**
 * verify-subpackage-manifests.mjs —— 子包「包面」判据（P2-5）。
 *
 * 回答的问题：`lib/components/<sub>/package.json`（三个组件子包的清单）会不会**漂回极简**？
 *
 * 为什么需要：本提交把 about-notice / mascot-avatar / media-bridge 拆成独立子包（各自的清单 /
 * icon / locale；主包 `exports` 里也给了 `./<sub>`、`./<sub>/package.json`、`./<sub>/locale/*.json`
 * 三连），而三份子包清单当时只有 `name` / `description` / `icon` / `type`。
 * `test/verify-bundle-rows.mjs` ④ 只对账「patch 子行 ⇄ 根 exports 三连 / 入口在盘上 / locale 名 /
 * `files` 覆盖 / 图标字节」—— **没有一处读子包清单本身**：把 `version` 删掉、把 `name` 改成根包名
 * （嵌套清单劫持最近清单解析）、把 `main` 指到不存在的文件，守卫链全绿，只有真机
 * `readPluginMeta()` 才会在插件列表里冒出错。本判据补这个洞。
 *
 * 口径（**数据驱动**，不写死任何组件名）：
 *   · 子包清单 = patch 行里 `name: '<根包名>/<sub>'` 的那些 `sub`（`cordis.patch.yml` 是唯一真源）；
 *   · 每一格的期望值都从**根清单**派生：`name` = `<根包名>-<sub>`、`version` = 根 `version`、
 *     入口落点 = 根 `exports['./<sub>']` 的目标、peer 范围 = 根 peer 的同名字符串（逐字）。
 *
 * 判据（正判据与全部负对照调**同一个** `manifestViolations()`）：
 *   ① 目录与「三处一致」：`lib/components/<sub>/` 在盘上；清单 `name` = `<根包名>-<sub>`（且 ≠ 根包名
 *      ⇒ 不让 Node 的最近清单解析把根包劫持到子目录）；根 `exports` 三连都落在这个目录里；
 *   ② `version` 存在且 **=== 根清单 version**（"漂回极简"的主要抓手；依据 BUNDLE-SPLIT §12.1
 *      「主包与所有子包同号」）；
 *   ③ 入口（`main` / `exports['.']`）指向的文件真实存在，且与根 `exports['./<sub>']` 的落点一致；
 *   ④ 声明了 `dsh.client` ⇒ 必须有 `exports['./client']` 且入口在盘上（没有浏览器半边就不该声明）；
 *   ⑤ `peerDependencies` 每个包名都在根 peer 里；`@deepseek-ai/dsh-*` 的范围与根**逐字相等**
 *      （依据 BUNDLE-SPLIT §12.5 / I6：范围不一致 ⇒ 宿主整次安装被拒 + 回滚）；
 *   ⑥ 清单是**可 `JSON.parse` 的 LF 文本、无 BOM**（本仓 `.gitattributes` = `* text=auto eol=lf`；
 *      而 `JSON.parse` 不剥 BOM ⇒ `.json` 带 BOM 是真缺陷）。
 *
 * ⚠️ 本文件**不 import 任何裸包**（链上脚本零裸包依赖是 `verify-package-files` 的 P5 硬判据），
 * 也不读 `lib/**` 的实现 —— 它只看包面：patch 行 + 根清单 + 三份子包清单。
 * ⚠️ 负对照一律在**内存里**改文本/改对象再喂同一判据，**不碰磁盘**。
 *
 * Usage:  node test/verify-subpackage-manifests.mjs
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATCH_REL = 'cordis.patch.yml';
/** 子包目录的父路径（仓库根相对，正斜杠口径）。 */
const COMPONENTS_DIR = 'lib/components';

let failed = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failed++;
};

/** 行级标量取值：剥引号；非引号形态切掉行尾 ` #` 注释（与 `verify-bundle-rows.mjs` 同口径）。 */
function scalar(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const q = s[0];
  if (q === "'" || q === '"') {
    const end = s.indexOf(q, 1);
    return end > 0 ? s.slice(1, end) : s.slice(1);
  }
  const hash = s.indexOf(' #');
  return (hash >= 0 ? s.slice(0, hash) : s).trim();
}

/**
 * 从 patch 文本派生「列表行」：每行只取**第一次**出现的 `id` / `name` 标量。
 * 顶层那个 `- insert:` 也会被收进来（它没有 id/name ⇒ 由 `id` 过滤掉）。
 * 不引入 YAML 解析器：链上不许有裸包依赖，而本 patch 就是一张简单列表。
 * `config:` 子树里若也有 `name:`，因为「只认本行还没出现过的键」而**不会**覆盖行自己的 name。
 */
function patchRows(text) {
  const rows = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const item = /^(\s*)-\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (item) { cur = {}; rows.push(cur); cur[item[2]] = scalar(item[3]); continue; }
    const kv = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv && cur && !(kv[2] in cur)) cur[kv[2]] = scalar(kv[3]);
  }
  return rows.filter((r) => r.id || r.name);
}

/** `exports` 某一项的目标（字符串形态，或 `{ types, default }` 里的 `default`）。 */
function exportTarget(spec) {
  if (typeof spec === 'string') return spec;
  if (spec && typeof spec === 'object' && typeof spec.default === 'string') return spec.default;
  return null;
}

/** 去掉 `./` 前缀（比较落点用；根 exports 与子包自身 exports 的写法不同但落点可比）。 */
function dropDot(p) {
  return String(p == null ? '' : p).replace(/^\.\//, '');
}

/** 清单**文本**的形态问题：先于 `JSON.parse` 判，否则 BOM 只会得到一个难读的 `Unexpected token`。 */
function textShapeProblems(text) {
  const out = [];
  if (text.charCodeAt(0) === 0xfeff) out.push('带 UTF-8 BOM（JSON.parse 不剥 BOM ⇒ 读清单会抛）');
  if (text.includes('\r')) out.push('含 CR（本仓 `.gitattributes` 是 `* text=auto eol=lf`，这里应保持 LF）');
  return out;
}

/**
 * 判据本体：一份子包清单**文本** + 从根清单派生的期望值 ⇒ 违反项数组（空 = 通过）。
 * 生产路径（读磁盘）与全部负对照（内存里改文本 / 改对象再序列化）都只经过它。
 *
 * @param {{sub: string, text: string, rootPkg: object,
 *          fileExists: (rel: string) => boolean, dirExists: (rel: string) => boolean}} input
 * @returns {string[]} 违反项（人读文案）
 */
function manifestViolations({ sub, text, rootPkg, fileExists, dirExists }) {
  const out = textShapeProblems(text);
  let m;
  try { m = JSON.parse(text); } catch (e) { return [...out, 'JSON.parse 失败：' + e.message]; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return [...out, '清单不是 JSON 对象'];

  const here = COMPONENTS_DIR + '/' + sub;
  // ① name：由「根包名 + 子路径」派生（三处一致的第三处）。同时挡住 = 根包名的写法 ——
  //    那会让 Node 的最近清单解析把这个子目录当成根包，劫持根包内的裸说明符解析。
  const expectedName = rootPkg.name + '-' + sub;
  if (m.name !== expectedName) {
    out.push('name=' + JSON.stringify(m.name) + ' ≠ 期望 ' + JSON.stringify(expectedName)
      + '（`<根包名>-<子路径>`；写成根包名会让最近清单解析劫持根包）');
  }

  // ② version：与根清单同号（BUNDLE-SPLIT §12.1）。
  if (typeof m.version !== 'string' || !m.version) {
    out.push('缺 version（子包随根包同号发布，必须写出来）');
  } else if (m.version !== rootPkg.version) {
    out.push('version=' + m.version + ' ≠ 根清单 ' + rootPkg.version);
  }

  // ③ 入口落点：子包自己的 main / exports['.'] ⇄ 根 exports['./<sub>'] 必须是同一个文件。
  const subExports = m.exports && typeof m.exports === 'object' && !Array.isArray(m.exports) ? m.exports : null;
  const dotTarget = subExports ? exportTarget(subExports['.']) : null;
  const mainTarget = typeof m.main === 'string' && m.main ? m.main : null;
  if (mainTarget && dotTarget && dropDot(mainTarget) !== dropDot(dotTarget)) {
    out.push('main=' + mainTarget + ' 与 exports["."]=' + dotTarget + ' 落点不一致');
  }
  const ownEntry = dotTarget || mainTarget;
  if (!ownEntry) out.push('既没有 main 也没有 exports["."]（独立成包后没有入口）');
  else if (!fileExists(here + '/' + dropDot(ownEntry))) out.push('入口不存在：' + here + '/' + dropDot(ownEntry));
  const rootTarget = exportTarget(rootPkg.exports ? rootPkg.exports['./' + sub] : undefined);
  if (!rootTarget) out.push('根 exports 缺 "./' + sub + '" 的入口目标');
  else if (ownEntry && dropDot(rootTarget) !== here + '/' + dropDot(ownEntry)) {
    out.push('根 exports["./' + sub + '"]=' + dropDot(rootTarget)
      + ' 与子包入口 ' + here + '/' + dropDot(ownEntry) + ' 不是同一落点');
  }

  // 根 exports 三连（入口 / 清单 / locale）必须都落在这个子包目录里。
  const triple = [
    ['./' + sub, '入口'],
    ['./' + sub + '/package.json', '清单元数据'],
    ['./' + sub + '/locale/*.json', 'locale'],
  ];
  for (const [key, what] of triple) {
    const t = exportTarget(rootPkg.exports ? rootPkg.exports[key] : undefined);
    if (!t) { out.push('根 exports 缺 ' + key + '（' + what + '）'); continue; }
    if (!dropDot(t).startsWith(here + '/')) out.push('根 exports[' + key + ']=' + dropDot(t) + ' 不落在 ' + here + '/');
  }

  // ④ 自洽：声明了 exports 就得自带这套子路径（与根的三连同名），且 client / locale 落点在盘上。
  if (subExports) {
    if (!dotTarget) out.push('声明了 exports 却没有 "." 入口');
    const pkgTarget = exportTarget(subExports['./package.json']);
    if (!pkgTarget) out.push('声明了 exports 却没有 "./package.json"（宿主要靠它读清单）');
    else if (dropDot(pkgTarget) !== 'package.json') out.push('exports["./package.json"]=' + pkgTarget + '（应为 ./package.json）');
    const localeTarget = exportTarget(subExports['./locale/*.json']);
    if (!localeTarget) out.push('声明了 exports 却没有 "./locale/*.json"（插件列表的显示名/描述从那里读）');
    else if (!dirExists(here + '/locale')) out.push('声明了 locale 出口，但 ' + here + '/locale 不在盘上');
  }

  // ④′ `dsh` 声明面：声明了浏览器半边就必须有可解析的 `./client`；自带 patch 就必须有那个文件。
  const dsh = m.dsh && typeof m.dsh === 'object' && !Array.isArray(m.dsh) ? m.dsh : null;
  if (dsh && dsh.client) {
    const clientTarget = subExports ? exportTarget(subExports['./client']) : null;
    if (!clientTarget) out.push('声明了 dsh.client 却没有 exports["./client"]（宿主按它加载浏览器半边）');
    else if (!fileExists(here + '/' + dropDot(clientTarget))) out.push('dsh.client 入口不存在：' + here + '/' + dropDot(clientTarget));
  }
  if (dsh && dsh.bundle && dsh.bundle.patch) {
    if (!fileExists(here + '/' + dropDot(dsh.bundle.patch))) out.push('dsh.bundle.patch 不存在：' + here + '/' + dropDot(dsh.bundle.patch));
  }

  // ⑤ peer：不许引入根没有的 peer；`@deepseek-ai/dsh-*` 的范围与根逐字相等（I6）。
  const rootPeers = rootPkg.peerDependencies && typeof rootPkg.peerDependencies === 'object' ? rootPkg.peerDependencies : {};
  const peers = m.peerDependencies && typeof m.peerDependencies === 'object' && !Array.isArray(m.peerDependencies) ? m.peerDependencies : {};
  for (const [name, range] of Object.entries(peers)) {
    if (!(name in rootPeers)) { out.push('peer ' + name + ' 不在根 peerDependencies 里（不许引入根没有的 peer）'); continue; }
    if (name.startsWith('@deepseek-ai/dsh-') && range !== rootPeers[name]) {
      out.push('peer ' + name + ' 范围 ' + JSON.stringify(range) + ' ≠ 根 ' + JSON.stringify(rootPeers[name])
        + '（I6：子包 peer 范围须与主包逐字对齐）');
    }
  }
  const metas = m.peerDependenciesMeta && typeof m.peerDependenciesMeta === 'object' && !Array.isArray(m.peerDependenciesMeta)
    ? Object.keys(m.peerDependenciesMeta) : [];
  for (const k of metas) if (!(k in peers)) out.push('peerDependenciesMeta 里的 ' + k + ' 不在 peerDependencies 里');

  return out;
}

// ═══ 派生：patch 子行 + 根清单（数据驱动，不写死组件名）════════════════════════════
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const patchText = readFileSync(join(ROOT, PATCH_REL), 'utf8');
const rows = patchRows(patchText);
const bareRows = rows.filter((r) => r.name === rootPkg.name);
const subs = [...new Set(rows
  .filter((r) => r.name && r.name.startsWith(rootPkg.name + '/'))
  .map((r) => r.name.slice(rootPkg.name.length + 1)))];
check('派生：patch 恰好一行裸包名 + 至少一行子包行', bareRows.length === 1 && subs.length >= 1,
  '裸行 ' + bareRows.length + ' · 子行 ' + (subs.join(' ') || '（没有）'));

const fileExists = (rel) => existsSync(join(ROOT, rel)) && statSync(join(ROOT, rel)).isFile();
const dirExists = (rel) => existsSync(join(ROOT, rel)) && statSync(join(ROOT, rel)).isDirectory();

// ═══ 判据：逐个子包清单（数据驱动的包面）═══════════════════════════════════════════
const texts = new Map();
const allProblems = [];
for (const sub of subs) {
  const dir = COMPONENTS_DIR + '/' + sub;
  const rel = dir + '/package.json';
  if (!dirExists(dir)) { allProblems.push(dir + ' 目录不在盘上'); continue; }
  if (!fileExists(rel)) { allProblems.push(rel + ' 不在盘上'); continue; }
  const text = readFileSync(join(ROOT, rel), 'utf8');
  texts.set(sub, text);
  const v = manifestViolations({ sub, text, rootPkg, fileExists, dirExists });
  allProblems.push(...v.map((x) => sub + '：' + x));
  let shown = '（清单读不出来）';
  try {
    const m = JSON.parse(text);
    shown = 'version=' + m.version + ' · name=' + m.name
      + ' · entry=' + (typeof m.main === 'string' ? m.main : exportTarget(m.exports && m.exports['.']))
      + ' · peers=' + Object.keys(m.peerDependencies || {}).join(',');
  } catch { /* 上面已经把 parse 失败记进 allProblems */ }
  check('子包清单包面：' + sub, v.length === 0, v.length ? v.join(' | ') : shown);
}
check('覆盖面：派生的每个子包目录都有一份可 parse 的清单', texts.size === subs.length && subs.length >= 1,
  texts.size + '/' + subs.length + ' 份：' + [...texts.keys()].join(' '));

// ═══ 负对照：全部在**内存**里改文本 / 改对象再喂**同一个** manifestViolations ═════════
{
  const sub = subs[0];
  const real = texts.get(sub) || '';
  const base = { sub, rootPkg, fileExists, dirExists };
  /** 在内存里改一份对象再序列化（绝不写盘）。 */
  const mutated = (fn) => {
    const o = JSON.parse(real);
    fn(o);
    return JSON.stringify(o, null, 2) + '\n';
  };
  const violationsOf = (text) => manifestViolations({ ...base, text });

  check('正对照：磁盘上的原样文本 ⇒ 0 条违反', real.length > 0 && violationsOf(real).length === 0,
    violationsOf(real).join(' | ') || '0 条');
  check('正对照：JSON.parse → 重新序列化 ⇒ 仍 0 条（判据不是恒红）', violationsOf(mutated(() => {})).length === 0);

  const noVersion = violationsOf(mutated((o) => { delete o.version; }));
  check('negative control: 删掉 version ⇒ 判红（"漂回极简"的主抓手）',
    noVersion.some((x) => /version/.test(x)), noVersion.join(' | ') || '（没报出来）');

  const drifted = violationsOf(mutated((o) => { o.version = '0.0.1'; }));
  check('negative control: version 漂离根版本 ⇒ 判红', drifted.some((x) => /version/.test(x)),
    drifted.join(' | ') || '（没报出来）');

  const hijack = violationsOf(mutated((o) => { o.name = rootPkg.name; }));
  check('negative control: 清单 name 改成根包名（嵌套清单劫持）⇒ 判红',
    hijack.some((x) => /name/.test(x)), hijack.join(' | ') || '（没报出来）');

  const ghostMain = violationsOf(mutated((o) => { o.main = 'no-such-entry.js'; }));
  check('negative control: main 与 exports["."] 落点不一致 ⇒ 判红',
    ghostMain.some((x) => /no-such-entry/.test(x)), ghostMain.join(' | ') || '（没报出来）');

  const ghostExport = violationsOf(mutated((o) => { o.main = 'no-such-entry.js'; o.exports['.'] = './no-such-entry.js'; }));
  check('negative control: 入口（exports["."]）指向不存在的文件 ⇒ 判红',
    ghostExport.some((x) => /入口不存在/.test(x)), ghostExport.join(' | ') || '（没报出来）');

  const bogusPeer = violationsOf(mutated((o) => { o.peerDependencies = { 'left-pad': '^1.0.0' }; }));
  check('negative control: 引入根没有的 peer ⇒ 判红',
    bogusPeer.some((x) => /left-pad/.test(x)), bogusPeer.join(' | ') || '（没报出来）');

  const badRange = violationsOf(mutated((o) => {
    o.peerDependencies = Object.assign({}, o.peerDependencies, { '@deepseek-ai/dsh-host-webserver': '^9.9.9' });
  }));
  check('negative control: dsh-* peer 范围与根不逐字相等（I6）⇒ 判红',
    badRange.some((x) => /逐字/.test(x)), badRange.join(' | ') || '（没报出来）');

  const fakeClient = violationsOf(mutated((o) => { o.dsh = { client: { platform: 'web' } }; }));
  check('negative control: 声明 dsh.client 却没有 exports["./client"] ⇒ 判红',
    fakeClient.some((x) => /client/.test(x)), fakeClient.join(' | ') || '（没报出来）');

  const bom = violationsOf('\uFEFF' + real);
  check('negative control: 文本带 BOM ⇒ 判红（JSON.parse 不剥 BOM）', bom.length > 0,
    bom.join(' | ') || '（没报出来）');

  const crlf = violationsOf(real.replace(/\n/g, '\r\n'));
  check('negative control: CRLF 行尾 ⇒ 判红', crlf.some((x) => /CR/.test(x)), crlf.join(' | ') || '（没报出来）');
}

console.log('');
if (failed) {
  console.log('SUBPACKAGE MANIFEST CHECKS FAILED — ' + failed + ' failed');
  process.exit(1);
}
console.log('ALL SUBPACKAGE MANIFEST CHECKS PASSED (' + subs.length + ' subpackage(s))');
process.exit(0);
