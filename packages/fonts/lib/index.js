/**
 * index.js — **字体系统子包的宿主入口**。
 *
 * P-A 的落点（docs/wip/BUNDLE-SPLIT.md §7.1 / lead 裁决「fonts 只搬宿主半边」）：
 *   · 搬进来的：字体系统的**两条宿主路由族** —— `fontsets`（字体集 /fontsets）与
 *     `system-fonts`（本机字体清单 /system-fonts），见 ./routes/*.js。
 *   · **不搬**的：浏览器半边（`src/font/**`、`src/fontset-store.js`、`src/fontset-editor.js`、
 *     `src/system-fonts.js`）仍在主 bundle 内联 —— 字体浏览器面就是设置面板的字体段，§7.1 明写
 *     P-A 不动设置面板 ⇒ 本包**不声明** `dsh.client`（声明了却没有 exports['./client'] 会按 C2 抛错）。
 *
 * 两条加载路径共用这一个实现（与 lib/components/about-notice/index.js 同形）：
 *   ① 宿主按 patch 行（cordis.patch.yml）当独立 plugin 加载 ⇒ `apply(ctx, config)`；
 *   ② 门面把同一批解构出来的键交给 ./routes/*.js 的 register 函数（主包 lib/index.js:347/:381 今天
 *      就是这么调的）。⇒ 本文件只负责「把 c 拼齐 + 把拆卸交给 ctx.effect」。
 *
 * ══ 跨包通道（唯一一条）══════════════════════════════════════════════════════════════
 * BUNDLE-SPLIT §5.1 出路② / §6.2 D-8：子包**不 import 主包任何其它模块**（相对路径 import 全部
 * 禁止），只认唯一受控叶子：
 *
 *     dsh-plugin-wallpaper-engine/subpackage-boot.js
 *
 * 该叶子由主包 task-1 落地，导出：
 *   · `subpackageKeys(id)` —— **冻结的显式键集**（本文件只消费它，不自己拼内核）。
 *   · `handOffTeardown(ctx, dispose)` —— 与 lib/host-boot.js 同名函数同义：`export function apply`
 *     是**函数声明**（有 prototype）⇒ cordis 走 `new apply(ctx)`、**返回值被丢弃** ⇒ 只 return dispose
 *     不够，必须再 `ctx.effect`（同 lib/index.js:412-420 的教训）。
 *
 * 为什么不是「解构整个 hostKernel」/ 不是新开 Service：§5.2 禁止项 + D-4「先走 ②」已定案；
 * 键集缺一个就抛错，**不许静默 undefined**（D3③「宁可显示、不可静默消失」的宿主侧对应纪律）。
 *
 * 开发期解析：`scripts/dev-link-subpackages.mjs` 在 `<profile>/node_modules/` 建
 * `dsh-plugin-wallpaper-engine-<pkg> → packages/<pkg>` junction（发布态天然是兄弟目录，同一份 patch 两态成立）。
 * ⚠️ 仓内跑本文件还需要**仓库根**的 `node_modules/dsh-plugin-wallpaper-engine → 仓库根` 自链接
 * （包内裸名解析只走 node_modules 查找，不走 Node 自引用：最近的 package.json 是子包自己的名字）；
 * 该脚本当前只链接子包名（scripts/dev-link-subpackages.mjs:171-203）⇒ 缺口已报 lead。
 */

import { join } from 'node:path';

import { subpackageKeys, subpackageKeyNames, handOffTeardown } from 'dsh-plugin-wallpaper-engine/subpackage-boot.js';

import { registerFontsetsRoutes } from './routes/fontsets.js';
import { registerSystemFontsRoutes } from './routes/system-fonts.js';

/** 行标识：与 packages/fonts/cordis.patch.yml 里那行的 `name` 逐字相同（§3 行标识判据会逐字对账）。 */
export const name = 'dsh-plugin-wallpaper-engine-fonts';

/** 这一族只用到宿主注入的 `webServer`（两条路由都注册在它上面）。 */
export const inject = ['webServer'];

/**
 * 宿主半边入口。`ctx` 是 cordis 的插件上下文（`new apply(ctx)` 形态），`config` 来自 patch 行的 config
 * （本包今天不使用：路由路径/键名都是定死的，§7.1 要求行为零回归）。
 *
 * @returns {() => void} 拆卸函数（同时已交 `ctx.effect`；mock ctx 无 effect 时退回返回值，见 host-boot.js:188-197）。
 */
export function apply(ctx, _config) {
  const webServer = ctx && ctx.webServer;
  // provider 缺席（主包没起 / 没有 webServer）：与 about-notice 同口径 —— 静默退回空拆卸，
  // 不抛异常炸掉整行（行级失败静默，§4.1 I5）。
  if (!webServer || typeof webServer.register !== 'function') return () => {};

  // 显式键集：键表 **逐字派生**自叶子的冻结表，缺 id / 缺键在这里抛错（**不静默 undefined**）。
  // 键集只含 host-only 的**运行期实例**（见表注释）；共享内核的 7 个纯函数 / 常量**不在**这里 ——
  // 两条路由各自从叶子具名视图 `schemaView` / `httpView` 静态取用（见 routes/*.js 顶部说明）。
  const keys = subpackageKeys('fonts');
  assertFontsKeys(keys);

  // 拆卸句柄数组：照主包 lib/kernel/host-session.js:190/:257 的口径（一个数组、插入顺序、
  // 逐条兜错），两条路由族的 register 都往它 push。
  const disposers = [];
  // 两个调用点各自给**自己那一族**的键集：`...keys` 是叶子冻结表（唯一真源），`disposers` 是共用
  // 拆卸句柄数组，`cachePath` 只给 system-fonts 一族（fontsets 不消费它 —— 别把不认识自己的键塞给它，
  // test/verify-inject-contracts.mjs 的调用点对账会把它记成「多给」）。
  try {
    registerFontsetsRoutes(webServer, { ...keys, disposers });
    registerSystemFontsRoutes(webServer, {
      ...keys,
      disposers,
      // 落盘缓存路径与主包同式（lib/index.js:383）：pluginDataDir()/system-fonts.json。
      cachePath: () => join(keys.pluginDataDir(), 'system-fonts.json'),
    });
  } catch (error) {
    // 半边起不来就整行回滚（不留半死态：第一条已经 push 的 disposer 先跑掉再抛）。
    disposeAll(disposers);
    throw error;
  }

  return handOffTeardown(ctx, () => disposeAll(disposers));
}

/**
 * 本包从 `c` 消费的全部键。**不手写第二份清单**（lead m00210 §1）：逐字派生自叶子里的冻结表
 * `subpackageKeyNames('fonts')` —— 冻结表是唯一真源（守卫读的声明面），派生保证两份永不漂移。
 * `disposers`/`cachePath` 由本文件自带，不在叶子表内。
 */
const REQUIRED_KEYS = subpackageKeyNames('fonts');

/**
 * D3③「宁可显示、不可静默消失」的宿主侧对应纪律：键集**缺一个就抛错**，绝不让 `undefined` 顺着
 * `c` 流进路由（那时错误会变成"某个请求 500"或"某个下拉空着"，离根因很远）。
 * 冻结表（`subpackageKeys('fonts')`）与这张表不一致 = 契约漂移，必须在这里炸而不是靠人记得。
 */
function assertFontsKeys(keys) {
  const missing = REQUIRED_KEYS.filter((k) => keys[k] === undefined);
  if (missing.length) {
    throw new Error(`subpackageKeys('fonts') 缺少必需键：${missing.join(', ')}`);
  }
}

/**
 * 逐条兜错的拆卸：**插入顺序**、单条抛错不影响其余（与 lib/kernel/host-session.js:257 逐字同口径）。
 * `splice(0)` 让重复调用成 no-op（teardown 可能被 ctx.effect + 调用方各跑一次）。
 */
function disposeAll(disposers) {
  for (const d of disposers.splice(0)) {
    try { d(); } catch { /* ignore */ }
  }
}
