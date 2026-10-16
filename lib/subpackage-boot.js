/**
 * subpackage-boot.js — 子包的**宿主服务实现 + 冻结键集真源**（P-A，BUNDLE-SPLIT §5.1 ① / §5.2 允许清单 1）。
 *
 * 跨包通道只有一条：**Cordis Service**。主包在 `apply()` 里
 *   `ctx.provide(HOST_SERVICE_NAME, createSubpackageHost())`
 * 把本文件组装的冻结面挂成一个服务；子包宿主半边 `export const inject = [HOST_SERVICE_NAME]`
 * 后用 `ctx.wallpaperEngineHost` 取用 —— 子包**不再 import 主包的任何模块**（包括本文件；
 * `test/verify-subpackage-purity.mjs` 把「子包半边零主包说明符」变成机器事实）。
 *
 * 为什么不再走「叶子 import」（§5.1 ② 的旧裁决）：`import` 是**模块图**上的边，关掉主包后子包
 * 仍握着旧代 exports（§5.2 反模式表第 2 行）；而 `inject` 是 cordis 唯一的级联判据
 * （`name in fiber.inject`）⇒ 主包停用，子包 fiber 自动 park（D-13 B「关主包 = 关整族」的物理基础）。
 *
 * 键集纪律不变：`subpackageKeys(id, ctx?)` —— 缺 id / 缺键一律**抛错**，不许静默 undefined
 * （D3③「宁可显示，不可静默消失」的宿主侧对应纪律）。
 *
 * 四个面，各有其唯一消费者：
 *   ① `subpackageSpecifiers(patchText, selfName)` —— 启动自检要用的「主 patch 里插了哪些子包行」。
 *      口径与判据逐字一致：先剥行尾 ` #` 注释，再按行级 `id:` / `name:` 取行；只认
 *      `<selfName>-*` 形态的**净新增**行（主包自己的行与 `<selfName>/<sub>` 子路径行都不算）。
 *   ② `assertSubpackagesResolvable(rows, resolve)` —— 启动自检：每个子包行必须真的能被解析到。
 *      行级失败在宿主侧是**静默**的（§4.1 I5：Loader 只记一行 failed，插件照常起来），
 *      所以主包 `apply()` 必须自己 resolve 一遍并**大声报错**（§7.6①）。
 *   ③ `createSubpackageHost()` / `provideSubpackageHost(ctx)` —— 服务值（冻结六键）与供给。
 *      子包经 `ctx.wallpaperEngineHost` 取到它，再按 id 要自己的键集与拆卸交接。
 *   ④ 键集三件套 `subpackageIds/subpackageKeyNames/subpackageKeys` + `schemaView`/`httpView`
 *      —— 服务面 `{ ids, keyNames, keys, handOff, schema, http }` 的零件（本文件内部共用，
 *      不再以裸 specifier 暴露给任何子包）。
 *
 * 纪律：本文件**只** import 相对路径与 `node:` 内置（零裸包 import），
 * 且除 `host-boot.js` 的模块级 `createHostKernel()` 外没有任何求值期副作用。
 */

import { PLUGIN_NAME, BASE, handOffTeardown, hostKernel, repoSlugFromPkg, runComponent } from './host-boot.js';
import { createLog } from './log.js';
import { bodyReader, CONTROL_JSON_MAX_BYTES } from './http-body.js';
import { sendJson } from './json-response.js';
import { pluginDataDir, configPath } from './kernel/data-dir.js';
import { componentViewFrom, createComponentSession } from './kernel/component-session.js';
import {
  FONTSET_MIGRATED_ID,
  FONTSET_SCHEMA_TAG,
  isFontSetId,
  sanitizeFontset,
  systemFontKeyOf,
} from './settings-schema.js';

/** 与 `lib/host-boot.js` 同义的拆卸交接：`export function apply` 是函数声明（有 prototype）
 *  ⇒ cordis 走 `new apply(ctx)`、**返回值被丢弃** ⇒ 只 `return dispose` 不够，必须同时交 `ctx.effect`。
 *  子包不再直接 import 本文件 —— 它们经服务面的 `handOff` 拿到同一个函数
 *  （本地绑定 + 再导出：服务面要的是值，不是 re-export 前的绑定）。 */
export { handOffTeardown };

/**
 * `settings-schema.js` 的具名视图（子包不出现在它的 import 面里 —— 那是跨包 value import）。
 *
 * **对外具名导出**：纯符号（无状态、无进程内唯一性）不该走 `c` 注入面 —— 注入面是
 * 「运行期才存在的实例」的通道，纯函数在**模块求值期**就该可用（子包里的模块级 helper
 * 与守卫的直读都依赖这一点）。子包**不再**静态 import 本文件 —— 它们在 `apply()` 里从
 * 服务面取一次（`host.schema` / `host.http`），再传给自己的路由工厂。
 */
const SCHEMA_VIEW = Object.freeze({
  isFontSetId,
  sanitizeFontset,
  FONTSET_MIGRATED_ID,
  FONTSET_SCHEMA_TAG,
  systemFontKeyOf,
});

/** 本叶子自己的纯函数（`../routes/**` 搬出主包前是直接 import 主包的）。用法同 `SCHEMA_VIEW`：经服务面取。 */
const HTTP_VIEW = Object.freeze({ sendJson, bodyReader, CONTROL_JSON_MAX_BYTES });

/**
 * P-F：组件行（`lib/components/<c>/` → `packages/<pkg>/`）的宿主半边不再相对 import 主包文件
 * —— 它们要的模块级绑定与实例都从这里经服务面取。
 *   · `HOST_VIEW`：宿主装载面的函数（记账/失败留证/teardown 交接都在里面，子包拿不到那两个模块级账本）。
 *   · `SESSION_VIEW`：组件会话工厂。`componentViewFrom` **必须**绑上主包那个唯一的 `hostKernel`
 *     实例（子包拿不到它，也不许自建第二份）。
 *   · `DATA_VIEW`：`lib/kernel/data-dir.js` 的路径解析（`pluginDataDir` / `configPath` **不在**
 *     `hostKernel` 对象上，故不能走 `kernel:` 源型）。
 */
const HOST_VIEW = Object.freeze({ repoSlugFromPkg, runComponent, handOffTeardown });
const SESSION_VIEW = Object.freeze({
  componentViewFrom: (component) => componentViewFrom(hostKernel, component),
  createComponentSession,
});
const DATA_VIEW = Object.freeze({ pluginDataDir, configPath });

/** 见上：`lib/settings-schema.js` 的纯符号视图。 */
export const schemaView = SCHEMA_VIEW;
/** 见上：JSON 应答 / 请求体读取 / 控制体上限的纯符号视图。 */
export const httpView = HTTP_VIEW;

/**
 * 冻结显式键集：`id` → 该子包宿主半边**允许消费**的键（view 键 → 取值处）。
 *
 * 取值处七型：`const:<常量>` / `kernel:<hostKernel 键>` / `schema:<settings-schema 导出>` /
 * `http:<本叶子重导出>` / `boot:<host-boot 导出>` / `session:<组件会话工厂>` / `data:<data-dir 导出>`，
 * 另有每次调用现建的 `log`。
 * ⚠️ **表 = 允许消费面，不是"能给的都给"**：三个子包一个都不消费 `PLUGIN_NAME`（它是纯常量，
 * 子包要报自己名字就写自己的包名）—— 于是它**不进这张表**（P-A 实测：pkg-fonts 报 14 键里
 * 只有它零消费）。判据拿 `subpackageKeyNames(id)` 当声明面，删键后自动同步，不用改守卫。
 * 这张表是**声明面唯一真源**：`subpackageKeyNames(id)` 给守卫读，`subpackageKeys(id)` 给运行期用；
 * 两者同源，不会漂移。
 */
const SUBPACKAGE_KEY_TABLE = Object.freeze({
  // fx / parallax：宿主半边今天只有空壳（行为全在浏览器半边），只需要平台基址 + log。
  fx: Object.freeze({
    base: 'const:BASE',
    log: 'log',
  }),
  parallax: Object.freeze({
    base: 'const:BASE',
    log: 'log',
  }),
  // P-F 第一格：组件行 `about-notice` 出户后的宿主半边面（原 `lib/components/about-notice/index.js`
  // 直接 import 主包的 9 个模块级绑定；出户后一律经这里取）。
  // ⚠️ 只登记**它真的用**的键：`configPath` / `CONTROL_JSON_MAX_BYTES` 是 media-bridge 才要的，
  // 不预先塞进来（表 = 允许消费面，见上）。
  'about-notice': Object.freeze({
    base: 'const:BASE',
    pluginName: 'const:PLUGIN_NAME',
    log: 'log',
    // 数据目录（`lib/kernel/data-dir.js`；这两个不在 hostKernel 对象上）
    pluginDataDir: 'data:pluginDataDir',
    // 组件视图与会话工厂（`lib/kernel/component-session.js`，视图绑主包唯一的 hostKernel）
    componentViewFrom: 'session:componentViewFrom',
    createComponentSession: 'session:createComponentSession',
    // 宿主装载面（`lib/host-boot.js`）：记账 / 失败留证 / teardown 交接
    repoSlugFromPkg: 'boot:repoSlugFromPkg',
    runComponent: 'boot:runComponent',
    handOffTeardown: 'boot:handOffTeardown',
  }),
  // P-F 第二格：组件行 `mascot-avatar` 出户后的宿主半边面（原
  // `lib/components/mascot-avatar/index.js` 直接 import 主包的 4 个模块级绑定 + 内核视图；
  // 出户后一律经这里取）。
  // ⚠️ 只登记**它真的用**的键：它不需要 `log`（会话返回值里自带）、不需要 `pluginDataDir` /
  // `configPath` / `repoSlugFromPkg` / `CONTROL_JSON_MAX_BYTES`（两条图片族不落盘 JSON、
  // 不出站、body 上限走内核视图的 `MASCOT_MAX_BYTES` / `AVATAR_MAX_BYTES`）。
  'mascot-avatar': Object.freeze({
    base: 'const:BASE',
    pluginName: 'const:PLUGIN_NAME',
    // 组件视图与会话工厂（`lib/kernel/component-session.js`，视图绑主包唯一的 hostKernel）
    componentViewFrom: 'session:componentViewFrom',
    createComponentSession: 'session:createComponentSession',
    // 宿主装载面（`lib/host-boot.js`）：记账 / 失败留证 / teardown 交接
    runComponent: 'boot:runComponent',
    handOffTeardown: 'boot:handOffTeardown',
  }),
  'pet-link': Object.freeze({
    base: 'const:BASE',
    runComponent: 'boot:runComponent',
    handOffTeardown: 'boot:handOffTeardown',
  }),
  // P-F 第三格：组件行 `media-bridge` 出户后的宿主半边面（原
  // `lib/components/media-bridge/index.js` 直接 import 主包的 6 个模块级绑定 + 内核视图；
  // 出户后一律经这里取）。
  // ⚠️ 只登记**它真的用**的键：它不需要 `log`（会话返回值里自带，且要 `.tag('media')`）、
  // 不需要 `pluginDataDir`（后端走 `configPath` 的父目录）/ `repoSlugFromPkg`（不出站）。
  // 与另两格不同之处：它是唯一需要 `configPath`（`data:` 源）与 `CONTROL_JSON_MAX_BYTES`
  // （`http:` 源）的组件 —— 这两个键**都不在** `KERNEL_STABLE_FACE` 上，故不能走 `kernel:` 源。
  'media-bridge': Object.freeze({
    base: 'const:BASE',
    pluginName: 'const:PLUGIN_NAME',
    // 数据目录（`lib/kernel/data-dir.js`；这两个不在 hostKernel 对象上）
    configPath: 'data:configPath',
    // 收体上限（`lib/http-body.js`；单一真源在收体器旁边）
    CONTROL_JSON_MAX_BYTES: 'http:CONTROL_JSON_MAX_BYTES',
    // 组件视图与会话工厂（`lib/kernel/component-session.js`，视图绑主包唯一的 hostKernel）
    componentViewFrom: 'session:componentViewFrom',
    createComponentSession: 'session:createComponentSession',
    // 宿主装载面（`lib/host-boot.js`）：记账 / 失败留证 / teardown 交接
    runComponent: 'boot:runComponent',
    handOffTeardown: 'boot:handOffTeardown',
  }),
  // fonts：两条宿主路由族（fontsets / system-fonts）的 c 面，逐键对应主包 lib/index.js:344-351
  // 与 :377-385 今天传给两个 register 的键。
  // ⚠️ 纯符号（settings-schema 的 5 个 + 叶子的 sendJson/bodyReader）**不在这张表里**：
  // 它们是模块求值期就该可用的纯函数，走 `schemaView` / `httpView` 具名导出静态取用；
  // 这张表只登记「运行期才存在的实例」（常量、内核状态、每次现建的 log）。
  fonts: Object.freeze({
    base: 'const:BASE',
    log: 'log',
    // 内核键（`lib/kernel/host-kernel.js` 的平坦对象）
    fontSetsDir: 'kernel:fontSetsDir',
    fontSetsBuiltinDir: 'kernel:FONTSET_BUILTIN_DIR',
    pluginDataDir: 'kernel:pluginDataDir',
    readSettings: 'kernel:readSettings',
    readFontSetId: 'kernel:readFontSetId',
    setFontSetId: 'kernel:setFontSetId',
    commitFontSetMigration: 'kernel:commitFontSetMigration',
    atomicWriteFileP: 'kernel:atomicWriteFileP',
    ensureDirOnce: 'kernel:ensureDirOnce',
    armBodyIdleTimeout: 'kernel:armBodyIdleTimeout',
    lingerClose: 'kernel:lingerClose',
  }),
});

/** 已登记的子包 id（判据与错误文案共用）。 */
export function subpackageIds() {
  return Object.freeze(Object.keys(SUBPACKAGE_KEY_TABLE));
}

/**
 * 该子包**声明面**的键名列表（冻结）。守卫拿它当「子包宿主入口的注入契约」的调用点事实 ——
 * 子包里的 c 是 `{ ...subpackageKeys('fonts'), … }` 运行期展开，静态扫描看不见键。
 *
 * @param {string} id 子包 id（= patch 行 id 去掉 `wallpaper-engine-` 前缀的那一段）
 * @returns {readonly string[]}
 */
export function subpackageKeyNames(id) {
  const table = SUBPACKAGE_KEY_TABLE[id];
  if (!table) throw new Error('[wallpaper-engine] 未登记的子包 id：' + String(id) + '（合法值：' + Object.keys(SUBPACKAGE_KEY_TABLE).join(' / ') + '）');
  return Object.freeze(Object.keys(table));
}

/**
 * 取该子包的冻结 c 面。**缺键即抛**（不静默 undefined）：这是 §7.6① 的宿主侧一半 ——
 * 主包哪天把内核键改名/删掉，子包在其 `apply()` 的第一行就大声失败，而不是跑成半死态。
 *
 * @param {string} id 子包 id
 * @param {{ logger?: Function | object | null } | null} [ctx] cordis 插件上下文（有 logger 时日志同时落平台通道）
 * @returns {Readonly<Record<string, unknown>>}
 */
export function subpackageKeys(id, ctx) {
  const table = SUBPACKAGE_KEY_TABLE[id];
  if (!table) throw new Error('[wallpaper-engine] 未登记的子包 id：' + String(id) + '（合法值：' + Object.keys(SUBPACKAGE_KEY_TABLE).join(' / ') + '）');
  const logger = ctx && typeof ctx.logger === 'function' ? ctx.logger(PLUGIN_NAME) : (ctx && ctx.logger) || null;
  const log = createLog(logger, PLUGIN_NAME);
  const view = {};
  for (const key of Object.keys(table)) {
    const source = table[key];
    let value;
    if (source === 'const:BASE') value = BASE;
    else if (source === 'const:PLUGIN_NAME') value = PLUGIN_NAME;
    else if (source === 'log') value = log;
    else if (source.slice(0, 7) === 'kernel:') {
      const kernelKey = source.slice(7);
      if (!(kernelKey in hostKernel)) throw new Error('[wallpaper-engine] 子包 ' + id + ' 的键 ' + key + ' 缺内核键 ' + kernelKey);
      value = hostKernel[kernelKey];
    } else if (source.slice(0, 7) === 'schema:') value = SCHEMA_VIEW[source.slice(7)];
    else if (source.slice(0, 5) === 'http:') value = HTTP_VIEW[source.slice(5)];
    else if (source.slice(0, 5) === 'boot:') value = HOST_VIEW[source.slice(5)];
    else if (source.slice(0, 8) === 'session:') value = SESSION_VIEW[source.slice(8)];
    else if (source.slice(0, 5) === 'data:') value = DATA_VIEW[source.slice(5)];
    else value = undefined;
    if (value === undefined) throw new Error('[wallpaper-engine] 子包 ' + id + ' 的键 ' + key + ' 取到 undefined（声明面与取值面必须一致）');
    view[key] = value;
  }
  return Object.freeze(view);
}

/** 行级解析：与 `test/verify-subpackage-boot.mjs` 的口径逐字一致（先剥行尾注释，再匹配 id/name）。 */
function patchRows(patchText) {
  const rows = [];
  let current = null;
  for (const raw of String(patchText == null ? '' : patchText).split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    const id = /^\s*(?:-\s*)?id:\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(line);
    if (id) { current = { id: id[1], name: null }; rows.push(current); continue; }
    const name = /^\s*(?:-\s*)?name:\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(line);
    if (name) {
      if (current && current.name === null) current.name = name[1];
      else { current = { id: null, name: name[1] }; rows.push(current); }
    }
  }
  return rows;
}

/**
 * 主 patch 里**净新增的子包行名**（不排序、按出现顺序，与判据的 `rowNames.filter(…)` 同序）。
 *
 * 「净新增」= `name` 以 `<selfName>-` 开头，但既不是主包自己那行（`name === selfName`），
 * 也不是复用主包子路径的组件行（`name === selfName + '/<sub>'`）—— 后者仍住主包内，
 * 不是独立子包（§2.2/§2.4：子路径行不参与客户端 graph 扫描）。
 *
 * @param {string} patchText cordis.patch.yml 全文
 * @param {string} selfName 主包名（= 主包 package.json 的 name）
 * @returns {string[]}
 */
export function subpackageSpecifiers(patchText, selfName) {
  const self = String(selfName == null ? '' : selfName);
  const out = [];
  for (const row of patchRows(patchText)) {
    const name = row.name;
    if (typeof name !== 'string' || !name) continue;
    if (name === self) continue;
    if (name.indexOf(self + '/') === 0) continue;
    if (name.indexOf(self + '-') !== 0) continue;
    out.push(name);
  }
  return out;
}

/**
 * 启动自检：`rows` 里每个子包都必须能被 `resolve(name)` 解析到（返回真值）。
 *
 * 行级失败在宿主侧是静默的（§4.1 I5），所以这一遍是**唯一**会把「子包没装上 / 链接没了 /
 * 包名写错」大声说出来的地方。任一失败 ⇒ 抛 Error，消息里同时带**失败的包名**与**行 id**
 * （判据 `test/verify-subpackage-boot.mjs` 逐字要求这两样都在）。
 *
 * @param {({id?: string|null, name?: string}|string)[]} rows patch 行（`{id,name}[]` 或 `string[]` 两种形状都吃）
 * @param {(name: string) => unknown} resolve 解析器（返回真值 = 可解析）
 * @returns {number} 检查过的行数
 */
export function assertSubpackagesResolvable(rows, resolve) {
  const list = Array.isArray(rows) ? rows : [];
  const failed = [];
  for (const row of list) {
    const entry = typeof row === 'string' ? { id: null, name: row } : (row || {});
    const name = entry.name;
    let ok = false;
    if (typeof name === 'string' && name !== '') {
      try { ok = Boolean(typeof resolve === 'function' ? resolve(name) : null); } catch { ok = false; }
    }
    if (!ok) failed.push((typeof name === 'string' && name ? name : '(缺 name)') + '（行 ' + (entry.id ? String(entry.id) : '?') + '）');
  }
  if (failed.length > 0) throw new Error('[wallpaper-engine] 子包启动自检失败：' + failed.length + ' 个子包行解析不到 —— ' + failed.join('；') + '。先跑 node scripts/dev-link-subpackages.mjs 建开发期链接，或检查主包 package.json 的 dependencies 是否精确依赖这些子包。');
  return list.length;
}

// ─── 跨包服务面（§5.1 ①；子包 `inject` 的唯一条目）──────────────────────────────
/**
 * 主包对子包暴露的 Cordis 服务名（**唯一真源**）。
 *
 * 子包宿主半边不能 import 本文件（否则又回到模块图上的边），所以它们在自己的
 * `export const inject = ['wallpaperEngineHost']` 里**硬编码**同一字面量；
 * `test/verify-subpackage-purity.mjs` 拿本导出逐包对账 —— 名字漂移即判红。
 */
export const HOST_SERVICE_NAME = 'wallpaperEngineHost';

/**
 * 服务值：子包宿主半边允许消费的**全部面**（冻结）。
 *
 * | 键 | 取值 | 子包用法 |
 * |---|---|---|
 * | `ids()` | `subpackageIds()` | 枚举已登记子包（守卫 / 诊断） |
 * | `keyNames(id)` | `subpackageKeyNames(id)` | 声明面对账（fonts 的 REQUIRED_KEYS） |
 * | `keys(id, ctx?)` | `subpackageKeys(id, ctx)` | 运行期实例键集（缺键即抛） |
 * | `handOff(ctx, dispose)` | `handOffTeardown(ctx, dispose)` | D15：teardown 交 `ctx.effect` |
 * | `schema` | `schemaView`（settings-schema 的 5 个纯符号） | 字体路由的纯函数 |
 * | `http` | `httpView`（`sendJson` / `bodyReader`） | 字体路由的应答 / 读体 |
 *
 * 纯符号（`schema`/`http`）**也在服务面里**：§5.2 反模式表把「直接 import 另一个包的模块级导出」
 * 判为禁用形态（HMR 后是旧代 exports），所以纯函数同样不能静态 import 主包 ——
 * 子包在 `apply()` 里从服务取一次，再传给自己的路由工厂。
 */
export function createSubpackageHost() {
  return Object.freeze({
    ids: subpackageIds,
    keyNames: subpackageKeyNames,
    keys: subpackageKeys,
    handOff: handOffTeardown,
    schema: SCHEMA_VIEW,
    http: HTTP_VIEW,
  });
}

/**
 * 把服务挂到当前 ctx 上（主包 `apply()` 的第一件事）。
 *
 *  · 真宿主（cordis）：走 `ctx.provide(name, value)` —— 服务随主包 fiber 卸载而撤销，
 *    子包的 `inject` 级联因此成立（D-13 B「关主包 = 关整族」）。
 *  · 直调夹具（只提供 webServer 的 mock ctx）没有 `provide` ⇒ 退回把同一份值挂成属性：
 *    语义等价（子包仍取得到），只是没有级联；真宿主永远走 provide 那条。
 *
 * @param {{ provide?: Function } & Record<string, unknown>} ctx
 * @returns {Readonly<Record<string, unknown>>} 服务值
 */
export function provideSubpackageHost(ctx) {
  const value = createSubpackageHost();
  if (ctx && typeof ctx.provide === 'function') { ctx.provide(HOST_SERVICE_NAME, value); return value; }
  if (ctx && (typeof ctx === 'object' || typeof ctx === 'function')) {
    try { ctx[HOST_SERVICE_NAME] = value; } catch { /* 冻结/只读 ctx：失败面由子包的 inject 检查暴露 */ }
  }
  return value;
}
