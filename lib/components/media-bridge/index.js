/**
 * `media-bridge` 组件入口（第三件组件：系统媒体桥宿主侧，M6 —— 让 `lib/media/` 只剩内核媒体）。
 *
 * 为什么这一格独立成行：这五条路由（`/media-status`、`/audio-spectrum`、`/now-playing`、
 * `/now-playing/artwork`、`/media-control`）与它们的后端实现（media-bridge 子进程 + 内置回落）
 * 自成一条边：桥的状态 = 一个**子进程**与它自己的磁盘载体，与 `lib/media/` 那六个"内核媒体"
 * 文件（帧缓存 / 媒体目录 / MP4 探测 / 场景探测 / 视频预览 / 转码）零交叉 —— 后者仍由内核
 * （`lib/kernel/host-kernel.js`）持有，因为 `lib/index.js` 的 `/inventory`、`/media`、`/scene-*`
 * 都消费它们。搬进本目录后"这个组件由哪些文件构成"由**位置**回答（M6/M10）。
 *
 * 两处加载路径共用同一份实现（照抄 dsh-ops 的组件真形）：
 *   ① 宿主把 patch 行的 `name` 当**独立 plugin** 加载 ⇒ `apply(ctx, config)` 是入口；
 *   ② 门面的 `applyComponent(root, rawConfig, 'media-bridge')` 是"按组件加载"入口。
 * 两条路径都从叶子模块 `lib/host-boot.js` 取**同一份 deps**（同一个 `hostKernel` 实例 /
 * `BASE` / `PLUGIN_NAME`），并调同一个 `applyImpl` ⇒ 两条装载路径不可能漂移。
 *
 * `export const name` 与 patch 行的 slug 逐字相等（`dsh-plugin-wallpaper-engine/media-bridge`）。
 *
 * ⚠️ **取服务姿势（与另两个组件行逐字同款）**：先声明 `export const inject = ['webServer']`，
 * 再直接读 `ctx.webServer`（理由与真机故障原文见 `lib/components/about-notice/index.js` 文件头
 * 「取服务姿势」一节，此处不重复）。缺服务且不声明 inject 会被 cordis 的 reflect `get` 当场抛错。
 *
 * ⚠️ **teardown 得交两份**（同两个既有组件）：本模块导出的 `apply` 是**函数声明**（有 `prototype`）
 * ⇒ cordis 的 loader 走 `new apply(ctx, config)` 分支、**返回值被丢弃** ⇒ teardown 必须走
 * `handOffTeardown(ctx, …)` 同时交给 `ctx.effect`。判据 `test/verify-bundle-rows.mjs` ⑧c。
 *
 * ⚠️ **模块作用域纪律**：本模块被门面**静态** import（`test/verify-reachability.mjs` 的 import 图
 * 承重），宿主真实装载顺序又是**裸行在前** ⇒ 本模块可能**先于**门面求值。模块作用域（顶层、
 * 任何函数体之外）只许放声明/常量 —— 不得在求值期读别的模块的绑定并调用它（会踩 TDZ）。
 * 对应判据：`test/verify-bundle-rows.mjs` ⑥（结构判据 + 模块作用域文本兜底，双向）。
 *
 * ⚠️ **两个叶子 import（第三件组件的实测取舍）**：`configPath` 与 `CONTROL_JSON_MAX_BYTES`
 * **不在实跑内核对象上**（前者是 `lib/kernel/data-dir.js` 的模块级函数、门面自己也这么直取；
 * 后者是 `lib/http-body.js` 的收体上限常量、单一真源就在收体器旁边）⇒ 写进组件视图会让
 * `componentViewFrom()` **缺键即抛**。所以路由族要的这两个键由本入口直接 import 叶子模块后
 * 传给 `registerNowPlayingRoutes`，与门面取它们的姿势逐字同款（详见
 * `lib/kernel/component-session.js` 的 `COMPONENT_VIEW_KEYS['media-bridge']` 注释）。
 */
import { registerNowPlayingRoutes } from './now-playing.js';
// 数据目录里的 `config.json` 路径（模块级函数，不是内核对象字段）—— 媒体后端的 `dataDir`
// 取它的父目录。门面是同一个 import 姿势。
import { configPath } from '../../kernel/data-dir.js';
// 小控制面 JSON 请求体的**统一上限**（单一真源在收体器旁边）—— `/media-control` 用它。
import { CONTROL_JSON_MAX_BYTES } from '../../http-body.js';
// P2-7B：组件会话与组件视图都在内核侧；`log` / `disposers` / `serveFile` / `teardown` 由会话交出，
// `appendDiagLine` 也由会话交出（路由族把它当 `c.diag` —— 它同时在 SESSION_SERVE_KEYS 里，
// 入口若自己再从视图解构一次，`verify-component-face` ③ 的「入口 ∩ 会话 = ∅」会红）。
import { createComponentSession, componentViewFrom } from '../../kernel/component-session.js';
// 本模块**不** import 门面（`../../index.js`）：门面静态 import 本模块（reachability 承重），
// 再反向 import 就是环；宿主裸行在前装载时本模块先求值，那一刻门面的模块级 `const` 还在 TDZ。
import { hostKernel, BASE, PLUGIN_NAME, repoSlugFromPkg, runComponent, handOffTeardown } from '../../host-boot.js';

/** patch 行 slug（`cordis.patch.yml` 里该行 `name` 的完整值，两处逐字相等）。 */
export const name = 'dsh-plugin-wallpaper-engine/media-bridge';

/**
 * 硬依赖 web 服务：与主行 `lib/index.js` 的 `export const inject = ['webServer']` **同一句**
 * （理由见文件头「取服务姿势」）。组件行走 patch 行加载时，Loader 靠这句保证「webServer 就绪
 * 才激活」，`ctx.webServer` 才读得到。
 */
export const inject = ['webServer'];

/** 独立 plugin 入口：宿主按 patch 行加载本组件时走这里，转调本模块的实现（不经门面）。 */
export function apply(ctx, config) {
  // 记账 / 错误留证 / 「失败仍原样抛」三件事都在 `runComponent()`（叶子模块，门面 `applyComponent`
  // 走的是同一个函数）⇒ 两条装载路径共用一份语义。键名与键序照抄门面 `applyComponent` 里那个
  // 注入字面量对象（`test/tools/host-route-index.mjs` 就是按这个契约推组件行的 `c` 面）。
  // 记账走 `runComponent()`；teardown 走 `handOffTeardown()`（交一份给 fiber，见文件头）。
  return handOffTeardown(ctx, runComponent('media-bridge', ctx, config, {
    hostKernel,
    base: BASE,
    pluginName: PLUGIN_NAME,
    repoSlugFromPkg,
  }, applyImpl));
}

/**
 * 组件实现。第三个形参名取 `c`（与 `lib/kernel/host-session.js` 同一约定）：
 * `test/tools/host-route-index.mjs --deps` 按 `const { … } = c;` 现抽契约。
 */
export function applyImpl(root, _rawConfig, c) {
  const { hostKernel, base, pluginName } = c;
  // 两条装载路径都能这么读：① 组件行自己声明了 `inject = ['webServer']`；② 门面路径的 `root`
  // 就是门面的 ctx，而门面同样声明了 `inject = ['webServer']`。
  const webServer = root && root.webServer;
  // 与门面 `apply()` 同款早退：服务在、但 register 面还没挂上（或换成了别的 webServer 实现）。
  if (!webServer || typeof webServer.register !== 'function') return () => {};

  // P2-7B 注入面收窄：从内核取**本组件声明的视图**（`COMPONENT_VIEW_KEYS['media-bridge']`），
  // 不再 `const { … } = hostKernel` 现解构；视图缺键即抛，不静默 `undefined`。
  const view = componentViewFrom(hostKernel, 'media-bridge');
  // 迷你会话（disposers / log / serveFile / 同序 teardown）收在内核侧；`appendDiagLine` 由会话
  // 一并交出（见文件头第三个 import 的注释）。
  const { log, disposers, serveFile, teardown, appendDiagLine } = createComponentSession(root, { base, pluginName }, view);
  // 本组件自己要的两个键：后端启动决策每次现读设置（`readConfig`），缓存根传**访问器**。
  const { readConfig, cacheBaseDir } = view;

  // 3c-5. 媒体状态族路由（媒体后端懒启动 + /media-status、/audio-spectrum、/now-playing、
  //       /now-playing/artwork、/media-control）→ 同目录 `now-playing.js`。
  //       后端实例、启动决策与五条注册都在那个文件里；这里只声明它的依赖（与门面调用点逐键相同）。
  registerNowPlayingRoutes(webServer, {
    disposers, base, appendDiagLine, configPath, cacheBaseDir, readConfig, serveFile,
    CONTROL_JSON_MAX_BYTES,
    // 媒体子系统的行统一带 `[media]` 标签（与终端既有形状逐字一致）；级别由调用点标注。
    log: log.tag('media'),
  });

  // 本组件自己的收尾（会话的 teardown）：与 host-session 的 teardown 同序（逐个 disposer →
  // destroy 在途流 → 清两个容器），但**没有** releaseKernelLease —— 见 `component-session.js`
  // 文件头那条有意不对称（桥的子进程由它自己的 disposer `mediaBackend.stop()` 收掉）。
  return teardown;
}
