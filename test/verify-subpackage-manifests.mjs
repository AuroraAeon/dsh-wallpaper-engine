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
 * ⚠️ 本文件**不 import 任何裸包**（链上脚本零裸包依赖是 `verify-package-files` 的 P5 硬判据）。
 *
 * ── 第二段：`packages/*` 独立子包（fx / parallax / fonts）的**包面** ─────────────────
 *
 * 上面这一整段（含 `manifestViolations()`）覆盖的是 `lib/components/<sub>` **组件行**：patch 用
 * **子路径名** `<根包名>/<sub>`，随主包一起发布。`packages/<pkg>/` 是另一种包 —— **独立子包行**：
 * patch 用**真名** `<根包名>-<pkg>`，各自有自己的 `cordis.patch.yml` / `dsh.client` / 浏览器半边产物。
 * 早期守卫（purity / boot / client-half / toggle-roundtrip）盯的是**半边接线**，包面本身
 * （清单字段、行 ⇄ 自带 patch 对账、键表 / 构建表登记、发布两形态）此前**零判据** —— 本段补这个洞。
 *
 * 条款号 = `docs/adr/0014-subpackage-contract.md`（`S*` 是那份 ADR 的条款命名空间）：
 *   S2.1 布局文件集 · S2.2 `main` 在盘 · S3.1 `name` = 根名 + '-' + 目录名 · S3.2 `version` === 根
 *   S3.3 `exports['.']` 在盘 + `files` 覆盖每个具名出口 · S3.4 `exports['./client']` ⇔ `dsh.client`
 *   S3.5 peer ⊆ 根 peer、`@deepseek-ai/*` 范围逐字取根、依赖里不得出现主包 / 子包名
 *   S3.6 `dsh.bundle.patch` === `./cordis.patch.yml` + 在盘 + `files` 覆盖清单三件
 *   S3.7 清单 LF / 无 BOM / 可 parse · S4.2 自带 patch 的 `(id, name)` 与主包行逐字相等
 *   S4.3 主包行 id === `wallpaper-engine-<pkg>` · S8.1 根 devDeps 有 `file:packages/<pkg>`、deps 无子包名
 *   S10.1 `SUBPACKAGE_KEY_TABLE` 每包一项、无多余 · S10.2 `dsh.client` ⇔ `packages/<pkg>/client.build.json`
 *   一项，且 `artifact` === `exports['./client']`、产物在盘 · S10.3 配方形状：`entry` 与
 *   `inline[].file/why/markers` 齐备、`entry` / `file` 都在盘（T2 起字面量表搬进了逐包配方 JSON）
 *
 * ⚠️ 两个真源，读法不同：`lib/subpackage-boot.js` 的 `SUBPACKAGE_KEY_TABLE` 是**源码字面量**
 * （等长遮蔽后配对），`packages/<pkg>/client.build.json` 是**逐包配方 JSON**（T2 起取代了
 * `scripts/build-client.mjs` 里的 `SUBPACKAGE_BUILDS` 字面量表）。**在盘但读不出来**的配方逐包点名判红
 * （静默跳过 = 登记面判据恒真）；「某包没有配方文件」不算缺陷 —— 那件事由 S10.2 按 `dsh.client`
 * 两向对账（host-only 子包本来就不编浏览器半边）。覆盖面另有一条**地板**：枚举包目录 < 3 或主包真名行 < 3 ⇒ 判红。
 * ⚠️ 负对照一律在**内存里**改文本/改对象再喂同一判据，**不碰磁盘**。
 *
 * Usage:  node test/verify-subpackage-manifests.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// 发现层（task-1 冻结接口）：枚举面 ⇄ 发现层的发散判据靠它，不写死包名单。
import { discoverPackages } from './tools/packages.mjs';

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

// ═══ 第二段：packages/* 独立子包行的包面（S* 条款 = docs/adr/0014-subpackage-contract.md）═══════
/** 独立子包目录的父路径（仓库根相对，正斜杠口径）。 */
const PACKAGES_DIR = 'packages';

/**
 * S3.8 模板（ADR-0014 S3.8）—— **显式常量是唯一真源**，不以任何一份现成清单为基准：
 * 拿某一份清单当基准，谁先漂移就跟谁走，判据会变成"跟漂移者对齐"。
 *
 * ① MANIFEST_TOP_KEY_TEMPLATE：packages/<pkg>/package.json 顶层键的规范**相对顺序**。
 *    必选键必须全在且按序；optional 的键只允许**跨形态**缺失（host-only 包没有浏览器半边，
 *    也就没有 exports['./client'] / dsh.client；注入宿主 webServer 面的包才多出
 *    peerDependencies）—— 跨形态差异不是缺陷（S3.8 末句）。模板序外的顶层键一律判红。
 * ② MANIFEST_FILES_LINE：files 键值行的规范**字面量**（单行数组），位置由模板序钉死
 *    （files 必须在 dsh 块之后）。
 */
const MANIFEST_TOP_KEY_TEMPLATE = [
  { key: 'name' },
  { key: 'version' },
  { key: 'description' },
  { key: 'icon' },
  { key: 'type' },
  { key: 'main' },
  { key: 'exports' },
  { key: 'dsh' },
  { key: 'files' },
  { key: 'peerDependencies', optional: true },
  { key: 'peerDependenciesMeta', optional: true },
  { key: 'license' },
];
/** files 键值行的规范字面量（单行数组；见 ADR-0014 S3.8）。 */
const MANIFEST_FILES_LINE = '  "files": ["lib/", "cordis.patch.yml", "locale/", "icon.png", "package.json"],';

/** 独立子包目录（数据驱动：不写死包名，目录名 = 真名里根包名 '-' 之后那一段）。 */
function discoverPackageDirs() {
  if (!dirExists(PACKAGES_DIR)) return [];
  return readdirSync(join(ROOT, PACKAGES_DIR), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => PACKAGES_DIR + '/' + e.name)
    .sort();
}

/**
 * 把**字符串与注释等长**换成空格（引号留着）：只给结构取值用。
 * 为什么必须等长：被遮蔽的源码里字符串 / 模板 / 注释也可能含 `{` `}`（`SUBPACKAGE_KEY_TABLE`
 * 的注解文案就有），不等长遮蔽会让括号配对的下标错位，取出来的键就是别的条目的。
 */
function maskStructure(src) {
  const s = String(src);
  const out = s.split('');
  const blank = (from, to) => { for (let k = from; k < to; k++) out[k] = ' '; };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      let closed = false;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === ch) { j++; closed = true; break; }
        if (ch !== '`' && s[j] === '\n') break;
        j++;
      }
      blank(i + 1, closed ? j - 1 : j);
      i = j;
    } else if (ch === '/' && next === '/') {
      let j = i; while (j < s.length && s[j] !== '\n') j++;
      blank(i, j); i = j;
    } else if (ch === '/' && next === '*') {
      let j = i + 2;
      while (j < s.length && !(s[j] === '*' && s[j + 1] === '/')) j++;
      j = Math.min(s.length, j + 2);
      blank(i, j); i = j;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** 取 `const <name> = <open> … <close>;` 的字面量体：masked 给配对用、raw 给取值用（长度一致 ⇒ 下标可照搬）。 */
function literalBody(src, name, open, close) {
  const masked = maskStructure(src);
  const at = masked.indexOf('const ' + name + ' = ');
  if (at < 0) return null;
  const start = masked.indexOf(open, at);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < masked.length; i++) {
    if (masked[i] === open) depth++;
    else if (masked[i] === close) {
      depth--;
      if (depth === 0) return { masked: masked.slice(start, i + 1), raw: String(src).slice(start, i + 1) };
    }
  }
  return null;
}

/** lib/subpackage-boot.js 的 SUBPACKAGE_KEY_TABLE 顶层键（读不出来 ⇒ null，由判据判红，不许静默跳过）。 */
function keyTableOf(src) {
  const lit = literalBody(src, 'SUBPACKAGE_KEY_TABLE', '{', '}');
  if (!lit) return null;
  // 顶层键缩进 2 空格（内层对象是 4 空格）；注释行已被遮蔽成空格，不会误收。
  const ids = [...lit.masked.matchAll(/^ {2}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]);
  return ids.length ? ids : null;
}

/** 逐包构建配方文件名（`packages/<dir>/client.build.json`；T2 起是"浏览器半边怎么编"的真源）。 */
const RECIPE_REL = 'client.build.json';
/** 配方里每个内联源码项的必填字段（缺一 ⇒ S10.3 判红，不是"没有就跳过"）。 */
const RECIPE_INLINE_FIELDS = ['file', 'why', 'markers'];

/**
 * 一份配方的**形状**判据（读得出来之后跑）：返回该包的问题文案（`<dir>：<文案>`）。
 * 为什么查 `entry` / `inline[].file` 在盘：配方说"拿这份源码编出这份产物"，而文件不在盘时
 * 红的是构建器（读文件炸在很后面），不是"配方与包对不上"这件真事。
 */
function recipeShapeProblems(dir, obj) {
  const out = [];
  const at = dir + '/' + RECIPE_REL;
  const entry = typeof obj.entry === 'string' ? obj.entry.trim() : '';
  if (!entry) out.push(dir + '：S10.3 ' + at + ' 没有 entry（子包浏览器入口）');
  else if (!fileExists(dir + '/' + dropDot(entry))) out.push(dir + '：S10.3 ' + at + ' 的 entry 不在盘：' + dir + '/' + dropDot(entry));
  if (!Array.isArray(obj.inline) || obj.inline.length === 0) {
    out.push(dir + '：S10.3 ' + at + ' 的 inline 不是非空数组（没有内联源码就编不出浏览器半边）');
    return out;
  }
  obj.inline.forEach((it, i) => {
    const label = 'S10.3 ' + at + ' inline[' + i + ']';
    if (!it || typeof it !== 'object') { out.push(dir + '：' + label + ' 不是对象'); return; }
    for (const f of RECIPE_INLINE_FIELDS) {
      const v = it[f];
      const ok = f === 'markers'
        ? Array.isArray(v) && v.length > 0 && v.every((m) => typeof m === 'string' && m.trim())
        : typeof v === 'string' && v.trim();
      if (!ok) out.push(dir + '：' + label + ' 缺 ' + f + '（' + JSON.stringify(v === undefined ? null : v) + '）');
    }
    if (typeof it.file === 'string' && it.file.trim() && !fileExists(dir + '/' + dropDot(it.file))) {
      out.push(dir + '：' + label + ' 的 file 不在盘：' + dir + '/' + dropDot(it.file));
    }
  });
  return out;
}

/**
 * 逐包**构建配方**（`packages/<dir>/client.build.json`）→ `{ entries, problems }`。
 * `entries` = 读得出来的 `{ dir, artifact }`（给 S10.2 三角对账；与旧字面量表同形）；
 * `problems` = **在盘但读不出来 / 形状不对**的逐包问题（点名包与文件，不许静默跳过）；
 * 没有任何一份读得出来 ⇒ `entries` 为 null（由覆盖面判据判红）。
 * ⚠️ "某包没有配方文件" **不算**问题（host-only 包不编浏览器半边）；那件事由 S10.2 三角判据判。
 */
function buildTableOf(dirs) {
  const entries = [];
  const problems = [];
  for (const dir of dirs) {
    const rel = dir + '/' + RECIPE_REL;
    // 没有配方文件 **不等于缺陷**：host-only 包本来就不编浏览器半边（`packages/fonts` 就是）。
    // "声明了 dsh.client 却没有配方" 由下面 S10.2 的三角判据两向对账（只有那边知道 declaresClient）。
    if (!fileExists(rel)) continue;
    // 初值刻意不写：try 成功即赋值，catch 直接 continue（写 `= null` 是死赋值）。
    let obj;
    try { obj = JSON.parse(readFileSync(join(ROOT, rel), 'utf8')); }
    catch (e) { problems.push(dir + '：S10.2 ' + rel + ' 解析失败：' + String((e && e.message) || e)); continue; }
    const artifact = obj && typeof obj.artifact === 'string' ? obj.artifact.trim() : '';
    if (!artifact) { problems.push(dir + '：S10.2 ' + rel + ' 没有 artifact（浏览器产物的落点）'); continue; }
    entries.push({ dir, artifact });
    problems.push(...recipeShapeProblems(dir, obj));
  }
  return { entries: entries.length ? entries : null, problems };
}

/**
 * 判据本体：packages/* 独立子包的**包面**（S2–S10）。生产路径（读磁盘）与全部负对照（内存里
 * 改文本 / 换表）都只经过它。
 *
 * @param {{dirs: string[], texts: Map<string, string>, selfPatches: Map<string, string>, rootPkg: object,
 *          rows: {id?: string, name?: string}[],
 *          fileExists: (rel: string) => boolean, dirExists: (rel: string) => boolean,
 *          keyTableIds: string[]|null, buildEntries: {dir: string, artifact: string}[]|null}} input
 * @returns {string[]} 违反项（`<主体>：<人读文案>`；空 = 通过）
 */
function packagesViolations(input) {
  const out = [];
  const add = (who, msg) => { out.push(who + '：' + msg); };
  const { dirs, texts, selfPatches, rootPkg, rows, fileExists, dirExists,
    keyTableIds: keyIds, buildEntries: builds, buildProblems: buildIssues = [] } = input;
  const nameOf = (dir) => rootPkg.name + '-' + dir.slice(PACKAGES_DIR.length + 1);
  const siblingNames = new Set(dirs.map((d) => nameOf(d)));
  const rootDev = rootPkg.devDependencies || {};
  const rootPeers = rootPkg.peerDependencies || {};
  const nameRows = rows.filter((r) => r.name && r.name.startsWith(rootPkg.name + '-'));

  // 覆盖面地板：枚举面被削空（或两张声明面表读不出来）时，下面每一条都恒真 ⇒ 先钉住这条。
  if (dirs.length < 3) {
    add('覆盖面', 'packages/ 下只枚举到 ' + dirs.length + ' 个包目录（< 3 ⇒ 本判据可能恒真；确实要收缩包数时，'
      + '同一次提交改这条地板；见 docs/adr/0014-subpackage-contract.md 的复核触发线）');
  }
  if (nameRows.length < 3) {
    add('覆盖面', '主包 cordis.patch.yml 只派生到 ' + nameRows.length + ' 条真名行（< 3 ⇒ 本判据可能恒真）');
  }
  if (!keyIds) add('覆盖面', '读不出 lib/subpackage-boot.js 的 SUBPACKAGE_KEY_TABLE（登记面判据不许静默跳过）');
  if (!builds) add('覆盖面', '读不出任何 packages/*/client.build.json 构建配方（登记面判据不许静默跳过）');
  // 逐包配方问题（缺文件 / 解析失败 / 形状不对）**点名到包**：有问题的包不许被当成"没有浏览器半边"。
  for (const p of buildIssues) {
    const at = p.indexOf('：');
    if (at > 0) add(p.slice(0, at), p.slice(at + 1));
    else add('覆盖面', p);
  }

  // 根清单的发布两形态（S8.1）与两张登记面的**多余项**（S10.1 / S10.2 的反向半边）。
  for (const [n, spec] of Object.entries(rootPkg.dependencies || {})) {
    if (n === rootPkg.name || siblingNames.has(n)) {
      add('根清单', 'S8.1 dependencies 里出现主包 / 子包名 ' + n + '（跨包通道走 patch 行 + 冻结面，不靠 npm 依赖图）');
    }
    if (String(spec).startsWith('file:')) {
      add('根清单', 'S8.1 dependencies 里出现 file: 规格 ' + n + '=' + JSON.stringify(spec) + '（file: 只允许留在 devDependencies 的开发链接里）');
    }
  }
  if (keyIds) {
    for (const k of keyIds) if (!dirs.includes(PACKAGES_DIR + '/' + k)) add('根清单', 'S10.1 SUBPACKAGE_KEY_TABLE 多了 ' + k + '：没有 packages/' + k + '/ 对应');
  }
  if (builds) {
    for (const b of builds) if (!dirs.includes(b.dir)) add('根清单', 'S10.2 构建配方多了 ' + b.dir + '：不在 packages/ 枚举面里');
  }

  for (const dir of dirs) {
    const leaf = dir.slice(PACKAGES_DIR.length + 1);
    const manifestRel = dir + '/package.json';
    const text = texts.get(dir);
    if (text == null) { add(dir, 'S2.1 缺 ' + manifestRel); continue; }

    // S2.1 布局：清单 + 自带 patch + 图标 + 两份 locale + lib/ 目录
    for (const f of ['cordis.patch.yml', 'icon.png', 'locale/en.json', 'locale/zh.json']) {
      if (!fileExists(dir + '/' + f)) add(dir, 'S2.1 缺 ' + dir + '/' + f);
    }
    if (!dirExists(dir + '/lib')) add(dir, 'S2.1 缺 ' + dir + '/lib/ 目录');

    // S3.7 文本形态先判：BOM 会让 JSON.parse 抛一句难读的错，掩盖真正的缺陷
    for (const s of textShapeProblems(text)) add(dir, 'S3.7 ' + s);
    let m;
    try { m = JSON.parse(text); } catch (e) { add(dir, 'S3.7 JSON.parse 失败：' + e.message); continue; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) { add(dir, 'S3.7 清单不是 JSON 对象'); continue; }

    // S3.1 / S3.2 身份：name = 根名 + '-' + 目录名；version 与根同号
    const wantName = rootPkg.name + '-' + leaf;
    if (m.name !== wantName) add(dir, 'S3.1 name=' + JSON.stringify(m.name) + ' ≠ ' + JSON.stringify(wantName) + '（= 根包名 + "-" + 目录名）');
    if (m.version !== rootPkg.version) add(dir, 'S3.2 version=' + JSON.stringify(m.version) + ' ≠ 根 version ' + JSON.stringify(rootPkg.version) + '（主包与所有子包同号）');

    // S2.2 / S3.3 入口：main 在盘、exports['.'] 在盘、两者落点一致、files 覆盖每个具名出口
    const exp = (m.exports && typeof m.exports === 'object' && !Array.isArray(m.exports)) ? m.exports : {};
    const dot = exportTarget(exp['.']);
    if (typeof m.main === 'string' && m.main && !fileExists(dir + '/' + dropDot(m.main))) {
      add(dir, 'S2.2 main 指向的文件不在盘上：' + dir + '/' + dropDot(m.main));
    }
    if (!dot) add(dir, 'S3.3 缺 exports["."]（宿主按它解析包入口）');
    if (dot && typeof m.main === 'string' && m.main && dropDot(m.main) !== dropDot(dot)) {
      add(dir, 'S3.3 main=' + JSON.stringify(m.main) + ' 与 exports["."]=' + JSON.stringify(dot) + ' 落点不一致');
    }
    const entry = dot || (typeof m.main === 'string' ? m.main : null);
    if (entry && !fileExists(dir + '/' + dropDot(entry))) add(dir, 'S3.3 入口不在盘上：' + dir + '/' + dropDot(entry));
    const files = Array.isArray(m.files) ? m.files.map(String) : null;
    const filesNorm = files ? files.map((f) => dropDot(f).replace(/\/$/, '')) : [];
    if (!files) {
      add(dir, 'S3.3 缺 files（发布白名单：漏了入口就是把包发成残废）');
    } else {
      for (const [key, spec] of Object.entries(exp)) {
        const target = exportTarget(spec);
        if (!target || target.includes('*')) continue;
        const rel = dropDot(target);
        const covered = filesNorm.some((p) => rel === p || rel.startsWith(p + '/'));
        if (!covered) add(dir, 'S3.3 files 没覆盖 exports[' + JSON.stringify(key) + ']=' + JSON.stringify(target));
      }
      for (const f of ['package.json', 'icon.png', 'cordis.patch.yml']) {
        if (!filesNorm.includes(f)) add(dir, 'S3.6 files 缺 ' + f);
      }
      if (!filesNorm.includes('locale')) add(dir, 'S3.6 files 缺 locale/');
    }

    // S3.4 / S3.6：浏览器半边与自带 patch 的声明两处必须成对，且落点在盘
    const dsh = (m.dsh && typeof m.dsh === 'object' && !Array.isArray(m.dsh)) ? m.dsh : {};
    const clientTarget = exportTarget(exp['./client']);
    const declaresClient = dsh.client != null && dsh.client !== false;
    if (declaresClient && !clientTarget) add(dir, 'S3.4 声明了 dsh.client 却没有 exports["./client"]');
    if (!declaresClient && clientTarget) add(dir, 'S3.4 有 exports["./client"] 却没声明 dsh.client（声明面不完整）');
    if (clientTarget && !fileExists(dir + '/' + dropDot(clientTarget))) add(dir, 'S3.4 ./client 产物不在盘：' + dir + '/' + dropDot(clientTarget));
    const patchTarget = dsh.bundle && dsh.bundle.patch;
    if (patchTarget !== './cordis.patch.yml') {
      add(dir, 'S3.6 dsh.bundle.patch=' + JSON.stringify(patchTarget) + ' ≠ "./cordis.patch.yml"（守卫与宿主加载自带 patch 的共同入口）');
    }
    if (typeof patchTarget === 'string' && !fileExists(dir + '/' + dropDot(patchTarget))) {
      add(dir, 'S3.6 dsh.bundle.patch 不在盘：' + dir + '/' + dropDot(patchTarget));
    }

    // S3.5 依赖方向：peer ⊆ 根 peer、@deepseek-ai/* 范围逐字取根、依赖里不得出现主包 / 子包名
    const peers = (m.peerDependencies && typeof m.peerDependencies === 'object') ? m.peerDependencies : {};
    for (const [n, range] of Object.entries(peers)) {
      if (!(n in rootPeers)) { add(dir, 'S3.5 peer ' + n + ' 不在根 peerDependencies 里'); continue; }
      if (n.startsWith('@deepseek-ai/') && range !== rootPeers[n]) {
        add(dir, 'S3.5 peer ' + n + ' 范围 ' + JSON.stringify(range) + ' ≠ 根 ' + JSON.stringify(rootPeers[n])
          + '（范围不逐字等同 ⇒ 宿主整次安装被拒 + 回滚）');
      }
    }
    for (const field of ['dependencies', 'peerDependencies']) {
      const dep = (m[field] && typeof m[field] === 'object') ? m[field] : {};
      for (const n of Object.keys(dep)) {
        if (n === rootPkg.name || siblingNames.has(n)) {
          add(dir, 'S3.5 ' + field + ' 里出现主包 / 子包名 ' + n + '（跨包通道走服务面与冻结面，不是 npm 依赖）');
        }
      }
    }

    // S4.1 / S4.3：主包 patch 里认领这个包的行，id 是覆盖面锚点
    const row = rows.find((r) => r.name === m.name);
    if (!row) add(dir, 'S4.1 主包 cordis.patch.yml 里没有认领这个包的行（name=' + JSON.stringify(m.name) + '）');
    else if (row.id !== 'wallpaper-engine-' + leaf) {
      add(dir, 'S4.3 主包行 id=' + JSON.stringify(row.id) + ' ≠ ' + JSON.stringify('wallpaper-engine-' + leaf)
        + '（id 被改名 = 这一行从覆盖面锚点上静默消失）');
    }

    // S4.2：自带的 patch 只能有那一行，且 (id, name) 与主包行逐字相等
    const selfText = selfPatches.get(dir);
    if (selfText == null) {
      add(dir, 'S2.1 读不出 ' + dir + '/cordis.patch.yml');
    } else {
      const named = patchRows(selfText).filter((r) => r.name);
      if (named.length !== 1) add(dir, 'S4.2 自带 patch 应有恰好一行带 name（现在 ' + named.length + ' 行）');
      else if (!row) add(dir, 'S4.2 自带 patch 的行 name=' + JSON.stringify(named[0].name) + ' 在主包 patch 里找不到');
      else {
        if (named[0].id !== row.id) add(dir, 'S4.2 自带 patch 行 id=' + JSON.stringify(named[0].id) + ' ≠ 主包行 id=' + JSON.stringify(row.id));
        if (named[0].name !== row.name) add(dir, 'S4.2 自带 patch 行 name=' + JSON.stringify(named[0].name) + ' ≠ 主包行 name=' + JSON.stringify(row.name));
      }
    }

    // S8.1 开发形态：根 devDependencies 必须有 file:packages/<pkg> 这条链接
    const wantSpec = 'file:' + dir;
    if (rootDev[m.name] !== wantSpec) {
      add(dir, 'S8.1 根 devDependencies[' + JSON.stringify(m.name) + ']=' + JSON.stringify(rootDev[m.name] ?? null)
        + ' ≠ ' + JSON.stringify(wantSpec) + '（开发期子包靠这条链接进 profile/node_modules）');
    }

    // S10.1 / S10.2：两张登记面表与清单逐包对账
    if (keyIds && !keyIds.includes(leaf)) add(dir, 'S10.1 SUBPACKAGE_KEY_TABLE 里没有 ' + leaf + '（宿主半边拿不到注入键）');
    if (builds) {
      const build = builds.find((b) => b.dir === dir);
      if (declaresClient) {
        if (!build) add(dir, 'S10.2 声明了 dsh.client 却没有 packages/<pkg>/client.build.json 配方（浏览器半边不会被编出来）');
        else {
          if (clientTarget && dropDot(build.artifact) !== dropDot(clientTarget)) {
            add(dir, 'S10.2 配方 artifact=' + JSON.stringify(build.artifact) + ' ≠ exports["./client"]=' + JSON.stringify(clientTarget));
          }
          if (!fileExists(dir + '/' + dropDot(build.artifact))) add(dir, 'S10.2 构建产物不在盘：' + dir + '/' + dropDot(build.artifact));
        }
      } else if (build) {
        add(dir, 'S10.2 没有 dsh.client 却出现了构建配方（会产出一份没人加载的产物）');
      }
    }
  }
  return out;
}

/**
 * 结构取行用的括号配对：从 startLine 那行起，配到深度归零的那一行（返回值 = 0 基行号）。
 * 跳过 JSON 字符串体（description 里可能有 { / }），避免把字符串里的花括号当成结构。
 */
function braceEndLine(lines, startLine) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startLine; i < lines.length; i++) {
    const s = lines[i];
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return i; }
    }
  }
  return -1;
}

/** 「形态」= 有没有浏览器半边（host-only ⟺ client-half）：S3.8 ③ 的逐字对账只在同形态内做。 */
function manifestHalfOf(m) {
  const dsh = (m.dsh && typeof m.dsh === 'object' && !Array.isArray(m.dsh)) ? m.dsh : {};
  return (dsh.client != null && dsh.client !== false) ? 'client-half' : 'host-only';
}

/**
 * 把「跨包允许不同」的三处掩成占位：name / description / exports['./client'] 的目标。
 * 掩完剩下的是**整份字符串**，逐字比对连排版（缩进、files 单行、键序、块位置）一并进判据。
 */
function maskSameShape(text) {
  return String(text)
    .replace(/^(\s*"name"\s*:\s*)"(?:[^"\\]|\\.)*"/m, '$1"<masked>"')
    .replace(/^(\s*"description"\s*:\s*)"(?:[^"\\]|\\.)*"/m, '$1"<masked>"')
    .replace(/"\.\/client"(\s*:\s*)"(?:[^"\\]|\\.)*"/g, '"./client"$1"<masked>"');
}

/** 掩掉三处后第一个不同的行（1 基行号 + 两侧文本），供人读文案直接定位到行。 */
function firstDiff(aText, bText) {
  const a = String(aText).split('\n');
  const b = String(bText).split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return { line: i + 1, a: a[i] == null ? '' : a[i], b: b[i] == null ? '' : b[i] };
}

/**
 * 判据本体：packages/* 清单的 **S3.8 模板一致性** —— 顶层键序 / files 单行与位置 /
 * 同形态逐字对账。生产路径（读磁盘文本）与全部负对照（内存里改文本）都只经过它。
 *
 * @param {{dirs: string[], texts: Map<string, string>}} input texts：目录 → 清单原文
 * @returns {string[]} 违反项（<dir>：S3.8 …；空 = 通过）
 */
function manifestTemplateViolations({ dirs, texts }) {
  const out = [];
  const add = (who, msg) => { out.push(who + '：S3.8 ' + msg); };
  const templateKeys = MANIFEST_TOP_KEY_TEMPLATE.map((s) => s.key);
  const parsed = new Map();
  const linesOf = new Map();

  // 覆盖面地板：任一清单读不出 / parse 不了 ⇒ 判红（静默跳过 = 判据恒真）。
  for (const dir of dirs) {
    const text = texts.get(dir);
    if (text == null) {
      add(dir, '读不出 ' + dir + '/package.json（覆盖面地板：三份清单任一读不出就判红，不许静默跳过）');
      continue;
    }
    linesOf.set(dir, String(text).split('\n'));
    let m;
    try { m = JSON.parse(text); } catch (e) { add(dir, 'JSON.parse 失败：' + e.message); continue; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) { add(dir, '清单不是 JSON 对象'); continue; }
    parsed.set(dir, m);
  }

  for (const [dir, m] of parsed) {
    // ① 顶层键序：必选键全在、模板外键判红、相对顺序落在模板序里。
    const keys = Object.keys(m);
    for (const slot of MANIFEST_TOP_KEY_TEMPLATE) {
      if (!slot.optional && !keys.includes(slot.key)) {
        add(dir, '顶层缺必选键 ' + JSON.stringify(slot.key) + '（模板：' + templateKeys.join(' → ') + '）');
      }
    }
    for (const k of keys) {
      if (!templateKeys.includes(k)) {
        add(dir, '出现模板外的顶层键 ' + JSON.stringify(k) + '（模板：' + templateKeys.join(' → ')
          + '；确要新增键就先改 MANIFEST_TOP_KEY_TEMPLATE 常量）');
      }
    }
    for (let i = 1; i < keys.length; i++) {
      const a = templateKeys.indexOf(keys[i - 1]);
      const b = templateKeys.indexOf(keys[i]);
      if (a < 0 || b < 0 || b > a) continue;
      add(dir, '顶层键序逆序：' + JSON.stringify(keys[i]) + ' 排在 ' + JSON.stringify(keys[i - 1]) + ' 之后'
        + '（模板序：' + templateKeys.join(' → ') + '；把这两个键换成模板顺序）');
    }

    // ② files：规范单行字面量（多行 / 内容漂移都在这里判红），且位置在 dsh 块之后。
    const lines = linesOf.get(dir);
    const filesAt = lines.findIndex((l) => /^\s*"files"\s*:/.test(l));
    if (filesAt < 0) {
      add(dir, '顶层没有 files 键（模板要求；发布白名单）');
    } else if (lines[filesAt] !== MANIFEST_FILES_LINE) {
      add(dir, 'files 不是规范单行字面量：实际 L' + (filesAt + 1) + ' ' + JSON.stringify(lines[filesAt])
        + '（应为 ' + JSON.stringify(MANIFEST_FILES_LINE) + '；改回单行数组，键值行样式与 S3.8 模板逐字相同）');
    }
    const dshAt = lines.findIndex((l) => /^\s*"dsh"\s*:\s*\{/.test(l));
    if (dshAt >= 0 && filesAt >= 0) {
      const dshEnd = braceEndLine(lines, dshAt);
      if (dshEnd >= 0 && filesAt < dshEnd) {
        add(dir, 'files（L' + (filesAt + 1) + '）排在 dsh 块（L' + (dshAt + 1) + '–L' + (dshEnd + 1)
          + '）之前（模板要求 files 在 dsh 块之后；把这一行移到 dsh 的收尾 }, 后面）');
      }
    }
  }

  // ③ 同形态逐字对账：掩掉 name / description / exports['./client'] 目标后整份字符串必须相等。
  const byHalf = new Map();
  for (const [dir, m] of parsed) {
    const half = manifestHalfOf(m);
    if (!byHalf.has(half)) byHalf.set(half, []);
    byHalf.get(half).push(dir);
  }
  let compared = 0;
  for (const [half, members] of byHalf) {
    for (let i = 0; i < members.length; i++) {
      for (let k = i + 1; k < members.length; k++) {
        compared++;
        const a = members[i];
        const b = members[k];
        const ma = maskSameShape(texts.get(a));
        const mb = maskSameShape(texts.get(b));
        if (ma === mb) continue;
        const d = firstDiff(ma, mb);
        const msg = '同形态（' + half + '）包 ' + a + ' 与 ' + b + ' 的包面不是逐字一致'
          + '（除 name / description / exports["./client"] 目标外必须逐字相同）：第一处差异 L' + d.line
          + ' ' + JSON.stringify(d.a) + ' ⇄ ' + JSON.stringify(d.b) + '（改回同形态模板排版）';
        add(a, msg);
        add(b, msg);
      }
    }
  }
  if (!compared) add('覆盖面', '没有任何一组同形态（≥ 2 个包）可做逐字对账（S3.8 ③ 会恒真；检查形态分组没被削空）');
  return out;
}
// ═══ 执行：读盘 → 喂判据 → 逐包打印（数据驱动的包面；负对照见下一段）══════════════════════
const packageDirs = discoverPackageDirs();
const packageTexts = new Map();
const packageSelfPatches = new Map();
for (const dir of packageDirs) {
  const manifestRel = dir + '/package.json';
  if (fileExists(manifestRel)) packageTexts.set(dir, readFileSync(join(ROOT, manifestRel), 'utf8'));
  const selfRel = dir + '/' + PATCH_REL;
  if (fileExists(selfRel)) packageSelfPatches.set(dir, readFileSync(join(ROOT, selfRel), 'utf8'));
}
const bootSrc = fileExists('lib/subpackage-boot.js') ? readFileSync(join(ROOT, 'lib/subpackage-boot.js'), 'utf8') : '';
const keyIds = keyTableOf(bootSrc);
// 构建登记面的真源 = **逐包配方 JSON**（T2 起；不再从 `scripts/build-client.mjs` 的源码文本里切片）。
const recipeTable = buildTableOf(packageDirs);
const buildList = recipeTable.entries;
const realRows = rows.filter((r) => r.name && r.name.startsWith(rootPkg.name + '-'));

/** 生产输入：负对照 = 在内存里换掉 texts / selfPatches / rows / rootPkg / 两张表，喂同一个判据。 */
const packagesInput = {
  dirs: packageDirs,
  texts: packageTexts,
  selfPatches: packageSelfPatches,
  rootPkg,
  rows,
  fileExists,
  dirExists,
  keyTableIds: keyIds,
  buildEntries: buildList,
  buildProblems: recipeTable.problems,
};

check('派生：packages/ 目录数 ≥ 3 且主包 patch 真名行数 ≥ 3（地板；防判据恒真）',
  packageDirs.length >= 3 && realRows.length >= 3,
  '目录 ' + packageDirs.length + ' 个 [' + packageDirs.join(' ') + '] · 真名行 ' + realRows.length + ' 条 · 键表 ' + (keyIds ? keyIds.join(' ') : '（读不出）') + ' · 配方 ' + (buildList ? buildList.map((b) => b.dir).join(' ') : '（读不出）'));

// 发现层对账（Ruling 1 的**硬**落点）：`packages/` 下每个目录都必须是发现层认下的包
// （`test/tools/packages.mjs` 的 standalone 枚举面 = 带 package.json 的直接子目录）。
// 为什么要有这条：扫描面是**磁盘通配**（只许变大不许变小），而产物面来自发现层 —— 两者一旦发散，
// 就会静默出现"扫得到、但没人认领"的目录：它下面的模块没有产物判据，也没进覆盖面。
const discoveredModel = (() => { try { return discoverPackages(ROOT); } catch { return null; } })();
const discoveredDirs = new Set((discoveredModel ? discoveredModel.packages : []).map((p) => p.dir));
const divergentDirs = packageDirs.filter((d) => !discoveredDirs.has(d));
check('发散判据：packages/ 下每个目录都是发现层认下的包（枚举面 ⇄ discoverPackages；发散时点名）',
  discoveredModel !== null && divergentDirs.length === 0,
  discoveredModel === null
    ? 'discoverPackages() 抛错 ⇒ 枚举面与发现层无法对账'
    : (divergentDirs.length
      ? divergentDirs.join(' ') + '：有目录却没被认成包（缺 package.json / 没进发现层）'
      : packageDirs.length + ' 个目录全部认下 [' + packageDirs.join(' ') + ']'));
check('negative control: 枚举面多一个没被发现的目录 ⇒ 发散判据点名（同一集合运算）',
  [...packageDirs, 'packages/zzz-ghost'].filter((d) => !discoveredDirs.has(d)).join(' ') === 'packages/zzz-ghost');

const templateProblems = manifestTemplateViolations({ dirs: packageDirs, texts: packageTexts });
const packageProblems = [...packagesViolations(packagesInput), ...templateProblems];
const scoped = new Map(packageDirs.map((d) => [d, []]));
const unscoped = [];
for (const p of packageProblems) {
  const at = p.indexOf('：');
  const who = at > 0 ? p.slice(0, at) : '';
  if (scoped.has(who)) scoped.get(who).push(p.slice(at + 1));
  else unscoped.push(p);
}
for (const dir of packageDirs) {
  const v = scoped.get(dir);
  let shown = '（清单读不出来）';
  try {
    const m = JSON.parse(packageTexts.get(dir));
    shown = 'version=' + m.version + ' · name=' + m.name + ' · files=' + (Array.isArray(m.files) ? m.files.length : '—') + ' 项';
  } catch { /* 上面的判据已经把 parse 失败记进 packageProblems */ }
  check('独立子包包面：' + dir, v.length === 0, v.length ? v.join(' | ') : shown);
}
check('S3.8 模板一致性：顶层键序落在模板序 / files 单行且在 dsh 块之后 / 同形态逐字对账',
  templateProblems.length === 0,
  templateProblems.join(' | ') || ('0 条（模板序 ' + MANIFEST_TOP_KEY_TEMPLATE.map((s) => s.key).join(' → ') + '）'));
check('独立子包：登记面 / 根清单无违反（含覆盖面地板）', unscoped.length === 0,
  unscoped.join(' | ') || '0 条');

// ═══ 负对照：全部在**内存**里改文本 / 换表，再喂**同一个** packagesViolations ═══════════════
{
  const dir = packageDirs[0];
  const leaf = dir.slice(PACKAGES_DIR.length + 1);
  const real = packageTexts.get(dir) || '';
  const serialize = (o) => JSON.stringify(o, null, 2) + '\n';
  const mutated = (fn) => { const o = JSON.parse(real); fn(o); return serialize(o); };
  const vOf = (text, patch) => packagesViolations({
    ...packagesInput,
    texts: new Map(packageTexts).set(dir, text),
    ...(patch || {}),
  });
  const hit = (list, re) => list.some((x) => re.test(x));

  check('正对照：磁盘上的原样输入 ⇒ 0 条违反', real.length > 0 && packageProblems.length === 0,
    packageProblems.join(' | ') || '0 条');
  check('正对照：JSON.parse → 重新序列化 ⇒ 仍 0 条（判据不是恒红）',
    vOf(mutated(() => {})).length === 0, vOf(mutated(() => {})).join(' | ') || '0 条');

  const noName = vOf(mutated((o) => { o.name = rootPkg.name; }));
  check('negative control: name 改成根包名 ⇒ 判红（S3.1）', hit(noName, /S3\.1/), noName.join(' | ') || '（没报出来）');

  const drift = vOf(mutated((o) => { o.version = '0.0.1'; }));
  check('negative control: version 漂离根版本 ⇒ 判红（S3.2）', hit(drift, /S3\.2/), drift.join(' | ') || '（没报出来）');

  const ghostEntry = vOf(mutated((o) => { o.main = 'no-such-entry.js'; o.exports['.'] = './no-such-entry.js'; }));
  check('negative control: main / exports["."] 指向不存在的文件 ⇒ 判红（S2.2 + S3.3）',
    hit(ghostEntry, /S2\.2/) && hit(ghostEntry, /S3\.3/), ghostEntry.join(' | ') || '（没报出来）');

  const noFiles = vOf(mutated((o) => { delete o.files; }));
  check('negative control: 删掉 files 发布白名单 ⇒ 判红（S3.3）', hit(noFiles, /S3\.3/), noFiles.join(' | ') || '（没报出来）');

  const uncovered = vOf(mutated((o) => { o.files = ['icon.png', 'package.json', 'cordis.patch.yml', 'locale/']; }));
  check('negative control: files 没覆盖 exports["."] 的落点 ⇒ 判红（S3.3）',
    hit(uncovered, /S3\.3/), uncovered.join(' | ') || '（没报出来）');

  const fakeClient = vOf(mutated((o) => { o.dsh = { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } }; }));
  check('negative control: 声明 dsh.client 却没有 exports["./client"] ⇒ 判红（S3.4）',
    hit(fakeClient, /S3\.4/), fakeClient.join(' | ') || '（没报出来）');

  const badPatch = vOf(mutated((o) => { o.dsh = Object.assign({}, o.dsh, { bundle: { patch: './nope.yml' } }); }));
  check('negative control: dsh.bundle.patch 指向别处 ⇒ 判红（S3.6）',
    hit(badPatch, /S3\.6/), badPatch.join(' | ') || '（没报出来）');

  const badTrust = vOf(mutated((o) => {
    o.peerDependencies = Object.assign({}, o.peerDependencies, { 'left-pad': '^1.0.0', '@deepseek-ai/dsh-host-webserver': '^9.9.9' });
    o.dependencies = { [rootPkg.name]: 'file:..' };
  }));
  check('negative control: 根没有的 peer / dsh-* 范围漂移 / 依赖里塞主包名 ⇒ 判红（S3.5）',
    hit(badTrust, /S3\.5/), badTrust.join(' | ') || '（没报出来）');

  const bom = vOf('\uFEFF' + real);
  check('negative control: 清单带 BOM ⇒ 判红（S3.7）', hit(bom, /S3\.7/), bom.join(' | ') || '（没报出来）');

  const crlfPkg = vOf(real.replace(/\n/g, '\r\n'));
  check('negative control: CRLF 行尾 ⇒ 判红（S3.7）', hit(crlfPkg, /S3\.7/), crlfPkg.join(' | ') || '（没报出来）');

  const missingPiece = packagesViolations({
    ...packagesInput,
    fileExists: (rel) => rel !== dir + '/icon.png' && fileExists(rel),
  });
  check('negative control: 布局少一件（icon.png 不在盘）⇒ 判红（S2.1）',
    hit(missingPiece, /S2\.1/), missingPiece.join(' | ') || '（没报出来）');

  const selfYml = packageSelfPatches.get(dir) || '';
  const driftYml = selfYml.replace(/(\bid:\s*)\S+/, '$1wallpaper-engine-zzz');
  const selfDrift = vOf(real, { selfPatches: new Map(packageSelfPatches).set(dir, driftYml) });
  check('negative control: 自带 patch 的行 id 与主包行不一致 ⇒ 判红（S4.2）',
    driftYml !== selfYml && hit(selfDrift, /S4\.2/), selfDrift.join(' | ') || '（没报出来）');

  const rowDrift = vOf(real, {
    rows: rows.map((r) => (r.name === rootPkg.name + '-' + leaf ? { ...r, id: 'wallpaper-engine-zzz' } : r)),
  });
  check('negative control: 主包行 id 被改名 ⇒ 判红（S4.3）', hit(rowDrift, /S4\.3/), rowDrift.join(' | ') || '（没报出来）');

  const noLink = packagesViolations({ ...packagesInput, rootPkg: { ...rootPkg, devDependencies: {} } });
  check('negative control: 根 devDependencies 少了 file:packages/<pkg> 链接 ⇒ 判红（S8.1）',
    hit(noLink, /S8\.1/), noLink.join(' | ') || '（没报出来）');

  const missingKey = packagesViolations({ ...packagesInput, keyTableIds: (keyIds || []).filter((k) => k !== leaf) });
  check('negative control: 键表少了这个包 ⇒ 判红（S10.1）', hit(missingKey, /S10\.1/), missingKey.join(' | ') || '（没报出来）');

  const extraKey = packagesViolations({ ...packagesInput, keyTableIds: [...(keyIds || []), 'zzz-ghost'] });
  check('negative control: 键表多了没有对应目录的包 ⇒ 判红（S10.1 多余项）',
    hit(extraKey, /S10\.1/), extraKey.join(' | ') || '（没报出来）');

  const synthClient = mutated((o) => {
    o.dsh = { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } };
    o.exports['./client'] = './lib/index.js';
  });
  const noBuild = vOf(synthClient, { buildEntries: [] });
  check('negative control: 声明 dsh.client 却没有构建配方 ⇒ 判红（S10.2）',
    hit(noBuild, /S10\.2/), noBuild.join(' | ') || '（没报出来）');

  const wrongArtifact = vOf(synthClient, { buildEntries: [{ dir, artifact: 'lib/client.wrong.js' }] });
  check('negative control: artifact 与 exports["./client"] 不一致 / 产物不在盘 ⇒ 判红（S10.2）',
    hit(wrongArtifact, /S10\.2/), wrongArtifact.join(' | ') || '（没报出来）');

  const guestBuild = vOf(real, { buildEntries: [{ dir, artifact: 'lib/client.fx.js' }] });
  check('negative control: 没有 dsh.client 的包出现了构建配方 ⇒ 判红（S10.2）',
    hit(guestBuild, /S10\.2/), guestBuild.join(' | ') || '（没报出来）');

  const emptyDirs = packagesViolations({ ...packagesInput, dirs: [] });
  check('negative control: 枚举面被削空（dirs=[]）⇒ 判红（覆盖面地板在起作用）',
    hit(emptyDirs, /覆盖面/), emptyDirs.join(' | ') || '（没报出来）');

  const noTables = packagesViolations({ ...packagesInput, keyTableIds: null, buildEntries: null });
  check('negative control: 键表与构建配方都读不出来 ⇒ 判红（登记面判据不许静默跳过）',
    hit(noTables, /读不出/), noTables.join(' | ') || '（没报出来）');

  // 新（T2 连带）：配方出问题时**点名那个包**，且不许"没配方 = 这包没有浏览器半边"。
  const recipeBad = packagesViolations({
    ...packagesInput,
    buildProblems: [dir + '：S10.3 ' + dir + '/' + RECIPE_REL + ' inline[0] 缺 file（null）'],
  });
  check('negative control: 逐包配方问题点名到包 ⇒ 判红（S10.3）',
    hit(recipeBad, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '：')) && hit(recipeBad, /S10\.3/),
    recipeBad.join(' | ') || '（没报出来）');

  // 新：读取层 / 形状判据本身有牙 —— 配方在盘但缺字段时必须**点名那个包**（不碰磁盘）。
  const shapeBad = recipeShapeProblems('packages/zzz-ghost', {
    entry: 'src/zzz-entry.js', artifact: 'lib/client.zzz.js', inline: [{ why: 'w', markers: ['m'] }],
  });
  check('negative control: 配方形状判据对缺字段（inline[].file）点名到包 ⇒ 判红（S10.3）',
    shapeBad.length >= 1 && shapeBad.every((x) => x.startsWith('packages/zzz-ghost：')) && shapeBad.some((x) => /inline\[0\] 缺 file/.test(x)),
    shapeBad.join(' | ') || '（没报出来）');
}

// ═══ 负对照：S3.8 模板一致性（同一 manifestTemplateViolations；全部在内存里改文本，不碰磁盘）═══
{
  const halfOfDir = (dir) => {
    try { return manifestHalfOf(JSON.parse(packageTexts.get(dir))); } catch { return '(unparsed)'; }
  };
  const anyDir = packageDirs[0];
  const realAny = packageTexts.get(anyDir) || '';
  const hostDir = packageDirs.find((d) => halfOfDir(d) === 'host-only');
  const tOf = (dir, text) => manifestTemplateViolations({ dirs: packageDirs, texts: new Map(packageTexts).set(dir, text) });
  const hit = (list, re) => list.some((x) => re.test(x));

  const clean = manifestTemplateViolations({ dirs: packageDirs, texts: packageTexts });
  check('正对照：S3.8 判据对磁盘上的原样输入 ⇒ 0 条违反', clean.length === 0,
    clean.join(' | ') || ('0 条（形态分组：' + [...new Set(packageDirs.map(halfOfDir))].join(' / ') + '）'));

  // 负对照 ①：改键序 —— 把 files 那一行搬到 dsh 行之前（字面量不变，只破相对顺序）。
  const reordered = (() => {
    const lines = realAny.split('\n');
    const fi = lines.findIndex((l) => /^\s*"files"\s*:/.test(l));
    const line = lines[fi];
    const rest = lines.filter((_, i) => i !== fi);
    rest.splice(rest.findIndex((l) => /^\s*"dsh"\s*:/.test(l)), 0, line);
    return rest.join('\n');
  })();
  const orderBad = tOf(anyDir, reordered);
  check('negative control: files 行挪到 dsh 之前（改顶层键序）⇒ 判红（S3.8 ①）',
    reordered !== realAny && hit(orderBad, /顶层键序逆序/), orderBad.join(' | ') || '（没报出来）');

  // 负对照 ②：files 改回多行数组（内容不变，只破单行字面量样式）。
  const multiline = realAny.replace(MANIFEST_FILES_LINE,
    '  "files": [\n    "lib/",\n    "cordis.patch.yml",\n    "locale/",\n    "icon.png",\n    "package.json"\n  ],');
  const filesBad = tOf(anyDir, multiline);
  check('negative control: files 改回多行数组 ⇒ 判红（S3.8 ②）',
    multiline !== realAny && hit(filesBad, /不是规范单行字面量/), filesBad.join(' | ') || '（没报出来）');

  // 负对照 ③：给 host-only 包塞 ./client —— 形态从 host-only 变成 client-half，就要与客户端形态逐字对账。
  const withClient = hostDir == null ? '' : (() => {
    const o = JSON.parse(packageTexts.get(hostDir));
    o.exports['./client'] = './lib/client.host.js';
    o.dsh = Object.assign({}, o.dsh, { client: { platform: 'web' } });
    return (JSON.stringify(o, null, 2) + '\n').replace(/^ {2}"files": \[[\s\S]*?\],$/m, MANIFEST_FILES_LINE);
  })();
  const shapeBad = hostDir == null ? [] : tOf(hostDir, withClient);
  check('negative control: host-only 包塞进 exports["./client"] + dsh.client ⇒ 判红（S3.8 ③ 同形态对账）',
    hostDir != null && hit(shapeBad, /同形态/), shapeBad.join(' | ') || '（没报出来）');

  // 负对照 ④：任一清单读不出 —— 覆盖面地板必须判红（不许静默跳过）。
  const missing = manifestTemplateViolations({ dirs: packageDirs, texts: new Map(packageTexts).set(anyDir, null) });
  check('negative control: 任一清单读不出 ⇒ 判红（覆盖面地板）',
    hit(missing, /覆盖面地板/), missing.join(' | ') || '（没报出来）');
}
console.log('');
if (failed) {
  console.log('SUBPACKAGE MANIFEST CHECKS FAILED — ' + failed + ' failed');
  process.exit(1);
}
console.log('ALL SUBPACKAGE MANIFEST CHECKS PASSED (' + subs.length + ' 组件行 + ' + packageDirs.length + ' 独立子包)');
process.exit(0);
