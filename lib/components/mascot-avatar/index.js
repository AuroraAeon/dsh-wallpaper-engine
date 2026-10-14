/**
 * `mascot-avatar` 组件入口（C6 宿主侧，P2-2 从主包出户的第二格：吉祥物立绘 + 会话头像）。
 *
 * 为什么这两族合成**一格**出户：它们是同一套形态的两条腿（POST 导入 raw body + MIME 白名单 /
 * GET·HEAD 查看 / DELETE 清除，见 `lib/components/mascot-avatar/avatar.js` 与
 * `lib/components/mascot-avatar/mascot.js` 的文件头），
 * 共用同一批内核服务层符号（目录 / 上限 / 原子落盘 / 请求收尾）与同一条用户资产语义。拆成两行
 * 只会让"头像两个 side + 立绘只有一张"这套不变量散在两处。
 *
 * 两处加载路径共用同一份实现（照抄 dsh-ops 的组件真形）：
 *   ① 宿主把 patch 行的 `name` 当**独立 plugin** 加载 ⇒ `apply(ctx, config)` 是入口；
 *   ② 门面的 `applyComponent(root, rawConfig, 'mascot-avatar')` 是"按组件加载"入口。
 * P2-2b 拆环后两条路径不再互相 import：都从叶子模块 `lib/host-boot.js` 取**同一份 deps**
 * （同一个 `hostKernel` 实例 / `BASE` / `PLUGIN_NAME`），并调同一个 `applyImpl` ⇒ "整包加载"与
 * "按组件加载"仍不可能漂移，且 `组件入口 → 门面` 那条环边（E2）已被拆除。
 *
 * `export const name` 与 patch 行的 slug 逐字相等（`dsh-plugin-wallpaper-engine/mascot-avatar`）：
 * 实物反例（dsh-ops 的组件入口导出 `dsh-ops-file`、patch 行写 `dsh-ops/file`）说明宿主不一定
 * 要求相等，但取等号对两种宿主行为都安全。
 *
 * 与主行的**有意不对称**（同 about-notice）：本组件**不** `acquireKernelLease`。租约护的是
 * `transcodeKit` 这类内核共享可变资源，而本组件只用两条静态图片的读写族，没有可释放的共享资源
 * ⇒ 不 acquire 也就不 release。
 *
 * 形态（侦察 §2.3 方案乙）：**自建最小出站套件**，不复用 `createHostSession` —— 后者会写
 * `build-stamp.json` 并再排一次 3s 启动清扫，三行（裸行 + 两个组件行）同时加载等于把这两件事做三遍。
 * P2-7B 起这一份"迷你会话"不再住在组件里：工厂收进 `lib/kernel/component-session.js`
 * （`createComponentSession()`，teardown 只有一份），组件只消费**内核导出的组件视图**
 * （`componentViewFrom(hostKernel, 'mascot-avatar')`，键集 = 内核 `COMPONENT_VIEW_KEYS` 里
 * 这一格声明的那几个）⇒ 不再从整个 `hostKernel` 解构（M9 的现状）；serve 套件的入参（`SESSION_SERVE_KEYS`）
 * 由会话从视图取，本组件只取两条路由族要的目录 / 上限 / 落盘 / 请求收尾。
 *
 * ⚠️ **取服务姿势（两个组件行都适用）**：本行虽然是**独立 plugin**
 * （patch 行加载），取服务姿势仍与主行**逐字同款** —— 先声明 `export const inject = ['webServer']`，
 * 再直接读 `ctx.webServer`。**不许**在没有 inject 声明的情况直读服务属性：cordis 的 reflect `get`
 * 陷阱对「未声明 inject 就取的服务属性」当场抛 `cannot get property "webServer" without inject at
 * applyImpl`（真机原文），随后的早退分支永远执行不到（死代码），
 * 两条装载路径双双失败、该组件的路由全 404。声明 inject 后由 Loader 保证「服务就绪才激活」，下面的早退
 * 分支只兜「服务在、但路由表还没挂上」这一种情况。
 * 依据：主行 `lib/index.js` 的 `inject` 声明 早就 `export const inject = ['webServer']`，即整包本来就硬依赖 web
 * 服务（没有 webServer 的 profile 里裸行自身就 pending）⇒ 组件行补同一句**不引入任何新假设**；
 * 反过来「缺服务就软失败」是个假前提，会把「没挂上」伪装成「激活成功」。
 * 对应判据：`test/verify-bundle-rows.mjs` ⑧（组件入口读的每个 `ctx.<服务>` 都必须在其 inject 里）。
 *
 * ⚠️ **teardown 得交两份（关掉再打开子组件会撞 `duplicate … route`）**：本模块
 * 导出的 `apply` 是**函数声明**（有 `prototype`）⇒ cordis 的 loader 走 `new apply(ctx, config)` 分支、
 * **返回值被丢弃** ⇒ 只 `return runComponent(…)` 的话 fiber 卸载时没人撤路由（旧注册留在宿主路由表里），
 * 下一次启用立刻撞「重复路由」。所以返回值一律走 `handOffTeardown(ctx, …)`：同一份 disposer 也交给
 * `ctx.effect`（cordis 的显式清理通道）并做幂等包装。见 `lib/host-boot.js`；
 * 判据 `test/verify-bundle-rows.mjs` ⑧c。
 *
 * ⚠️ **模块作用域纪律（P2-1b 定，P2-2b 后仍适用）**：本模块被 `lib/index.js` **静态** import
 * （`test/verify-reachability.mjs` 的 import 图承重），宿主真实装载顺序又是**裸行在前** ⇒ 本模块
 * 可能**先于**门面求值。P2-2b 拆环后本模块只 import 叶子模块（`lib/host-boot.js`）与路由/套件模块，
 * **不再** import 门面。纪律照旧：模块作用域（顶层、任何函数体之外）只许放声明/常量 —— 不得在模块
 * 求值期去读别的模块的绑定并调用它，否则那一刻对方可能还没求值完，抛
 * `ReferenceError: Cannot access '…' before initialization`（P2-1b NC1 实测报错原文）。
 * 对应判据：`test/verify-bundle-rows.mjs` ⑥（结构判据 + 模块作用域文本兜底，双向）。
 */
import { registerMascotRoutes } from './mascot.js';
import { registerAvatarRoutes } from './avatar.js';
// P2-7B：组件会话与组件视图都在内核侧（`createLog` / `createServeKit` 不再由本模块直接 import ——
// 那两个符号现在是会话的实现细节，组件只看见 `view` / 会话返回值）。
import { createComponentSession, componentViewFrom } from '../../kernel/component-session.js';
// P2-2b 拆环：本模块**不再** import 门面（`import { applyComponent } from '../../index.js'` 已删）。
// 改为从叶子模块取同一份 deps 与同一个记账函数 —— 门面静态 import 本模块（reachability 承重），
// 本模块若再 import 门面就是 `门面 ⇄ 组件入口` 的环；宿主裸行在前装载时本模块先求值，那一刻门面
// 的模块级 `const` 还在 TDZ（P2-1b NC1 实测 `Cannot access 'hostKernel' before initialization`）。
import { hostKernel, BASE, PLUGIN_NAME, repoSlugFromPkg, runComponent, handOffTeardown } from '../../host-boot.js';

/** patch 行 slug（`cordis.patch.yml` 里该行 `name` 的完整值，两处逐字相等）。 */
export const name = 'dsh-plugin-wallpaper-engine/mascot-avatar';

/**
 * 硬依赖 web 服务：与主行 `lib/index.js` 的 `inject` 声明 **同一句**（理由见文件头「取服务姿势」）。
 * 组件行走 patch 行加载时，Loader 靠这句保证「webServer 就绪才激活」，`ctx.webServer` 才读得到。
 */
export const inject = ['webServer'];

/** 独立 plugin 入口：宿主按 patch 行加载本组件时走这里，转调本模块的实现（不经门面）。 */
export function apply(ctx, config) {
  // 记账 / 错误留证 / 「失败仍原样抛」三件事都在 `runComponent()`（叶子模块，门面 `applyComponent`
  // 走的是同一个函数）⇒ 两条装载路径共用一份语义，不可能一条记了、另一条忘了。
  // 键名与键序照抄门面 `applyComponent` 里那个注入字面量对象（`test/tools/host-route-index.mjs`
  // 就是按这个契约推组件行的 `c` 面）；两边取的是 `lib/host-boot.js` 里**同一批绑定** ⇒ 不漂移。
  // 记账走 `runComponent()`；teardown 走 `handOffTeardown()`（交一份给 fiber，见文件头）。
  return handOffTeardown(ctx, runComponent('mascot-avatar', ctx, config, {
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
  // 就是门面的 ctx，而门面同样声明了 `inject = ['webServer']`（主行 `lib/index.js` 的 `inject` 声明）。
  const webServer = root && root.webServer;
  // 与门面 `apply()` 同款早退：服务在、但 register 面还没挂上（或换成了别的 webServer 实现）。
  if (!webServer || typeof webServer.register !== 'function') return () => {};

  // P2-7B 注入面收窄：从内核取**本组件声明的视图**（`COMPONENT_VIEW_KEYS['mascot-avatar']`），
  // 不再 `const { … } = hostKernel` 现解构 —— 后者等于把整个内核（键数与分级由 `test/verify-component-face.mjs` 现算）
  // 当成注入面（M9 的现状）。视图缺键即抛，不静默 `undefined`。
  const view = componentViewFrom(hostKernel, 'mascot-avatar');
  // 迷你会话（disposers / activeStreams / mediaMap / log / serveFile / 同序 teardown）收在内核侧：
  // serve 套件的入参（`SESSION_SERVE_KEYS`）由会话从视图取，本组件只取下面两条路由族要的键。
  const { disposers, serveFile, teardown } = createComponentSession(root, { base, pluginName }, view);
  // 服务层符号（目录 / 上限 / 原子落盘 / 请求收尾）继续由内核持有 —— 主包的 settings-schema、
  // presets、startup-sweep 与门面本身都还按同一套目录语义读写它们（见 lib/media/media-dirs.js）。
  const {
    mascotDir, mascotPath, MASCOT_EXT, MASCOT_MAX_BYTES,
    avatarDir, avatarPath, AVATAR_SIDES, AVATAR_EXT, AVATAR_MAX_BYTES,
    atomicWriteFileP, armBodyIdleTimeout, lingerClose,
  } = view;

  // 6f. 「系统」页签的自定义吉祥物立绘 → lib/components/mascot-avatar/mascot.js。POST 导入（raw body + MIME 白名单）/
  //     GET·HEAD 查看 / DELETE 清除，只认一张：导入前先清同族旧文件（"下一次导入覆盖上一次"）。
  registerMascotRoutes(webServer, {
    disposers, base, serveFile,
    mascotDir, mascotPath, MASCOT_EXT, MASCOT_MAX_BYTES,
    atomicWriteFileP, armBodyIdleTimeout, lingerClose,
  });

  // 6e. 「扩展」页签第一个模块（自定义会话头像）的两张图 → lib/components/mascot-avatar/avatar.js。一条 prefix 注册
  //     覆盖三个端点；图落在插件数据目录的 `avatars/` 下（不进 overrides，也不进 uploads）。
  registerAvatarRoutes(webServer, {
    disposers, base, serveFile,
    avatarDir, avatarPath, AVATAR_SIDES, AVATAR_EXT, AVATAR_MAX_BYTES,
    atomicWriteFileP, armBodyIdleTimeout, lingerClose,
  });

  // 本组件自己的收尾（会话的 teardown，见 lib/kernel/component-session.js）：与 host-session 的
  // teardown 同序（逐个 disposer → destroy 在途流 → 清两个容器），但**没有** releaseKernelLease
  // —— 见文件头那条有意不对称。
  return teardown;
}
