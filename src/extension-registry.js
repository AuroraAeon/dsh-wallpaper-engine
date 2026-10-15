/**
 * extension-registry.js — 跨包「扩展模块 / 层钩子」注册表（P-A 的首个跨包贡献点）。
 *
 * 为什么需要它：P-A 之后，「扩展」页签的三项**不再住在同一个 bundle 里** ——
 *   一号 自定义会话头像（src/ext-avatar.js + src/avatar-layer.js）留在主包；
 *   二号 点击效果与拖尾（packages/fx）、三号 3D 视差（packages/parallax）各自是一个**独立包**，
 *   三份 bundle 的**求值顺序不保证**，唯一的共同作用域是宿主经 loader 的 `require` 提供的
 *   主 bundle 导出面（BUNDLE-SPLIT §6.2「宿主注入显式键集」）。
 * 于是"谁登记了什么"必须落在一张**共享注册表**上，而不是一个按数组顺序 import 的静态清单：
 *   · panel-tabs 的 `extensionModules()` 只问注册表（屏上顺序 = (order, 注册序)）；
 *   · client.js 的挂载期只问注册表（每层的 `sync` 接 store 订阅、`dispose` 交 fiber 拆卸）。
 *
 * ## 三条硬口径
 *   ① **缺什么就抛什么**（D3③「宁可显示，不可静默消失」）：id / 描述符 / sync+dispose 缺一即抛。
 *      静默 undefined 的失效模式在屏上是"这个功能根本不存在"—— 没有报错、也没有空态提示。
 *   ② **注册期不读译文**：描述符的 `title` 是 getter（渲染时才取词，见 panel-tabs 的模块形状），
 *      所以这里只用 `'title' in descriptor` 判**有没有**，绝不取值 —— 取值会把 `weT` 拉到
 *      bundle 求值期（那时 i18n 表可能还没内联到位）。
 *   ③ **id 唯一**：重复注册 = 同一份 bundle 被求值两次（或两个包抢同一个 id），当场抛。
 *      HMR/重挂不会走这条路 —— loader 有模块缓存，工厂体一辈子只求值一次。
 *
 * 本文件必须**浏览器安全**（无 import / require / Node API），且**不得有顶层可执行语句**
 * 读 client.js 的 const（会被内联到 bundle 顶部，撞 TDZ）。
 * 挂载台（test/verify-scene-live.mjs）按文件 import 本模块，因此导出面**必须是真导出**。
 */

/** id → { descriptor, seq }。 */
const weExtensionModuleTable = new Map();
/** 注册序（order 相同时按它 —— 数组顺序是 bundle 求值顺序，跨包不可依赖）。 */
let weExtensionModuleSeq = 0;
/** id → { sync, dispose, discoveredGroups? }。 */
const weLayerHookTable = new Map();
/** 挂载期由 client.js 装上的「把某一层的 sync 接上 + 立刻对时」函数；未挂载时为 null。 */
let weLayerAttacher = null;
/** 挂载期由 client.js 装上的「注册表变了，重画面板」回调（迟到注册时用）。 */
let weRegistryListener = null;

/** 描述符的默认排序位：没写 `order` 的模块排在所有显式项之后（但仍在注册序内稳定）。 */
const WE_EXTENSION_DEFAULT_ORDER = 100;

function weRegistryFire() {
  if (typeof weRegistryListener === "function") {
    try { weRegistryListener(); } catch { /* 面板重画失败不许把注册链带崩 */ }
  }
}

/**
 * 登记一个「扩展」页签模块。
 *
 * @param {string} id React key：稳定且唯一（也是跨包去重的键）
 * @param {{ id: string, title: string, desc?: string, resetGroup?: string, order?: number, render?: Function }} descriptor
 * @returns {object} 同一个描述符（便于链式写法）
 */
function weRegisterExtensionModule(id, descriptor) {
  if (typeof id !== "string" || id === "") {
    throw new Error("[wallpaper-engine] 扩展模块 id 必须是非空字符串");
  }
  if (!descriptor || typeof descriptor !== "object") {
    throw new Error("[wallpaper-engine] 扩展模块 " + id + " 的描述符必须是对象");
  }
  if (descriptor.id !== id) {
    throw new Error("[wallpaper-engine] 扩展模块 id 不一致：注册 ' + id + '，描述符 id = " + JSON.stringify(descriptor.id));
  }
  if (!("title" in descriptor)) {
    throw new Error("[wallpaper-engine] 扩展模块 " + id + " 缺 title（面板要拿它当标题画）");
  }
  if (weExtensionModuleTable.has(id)) {
    throw new Error("[wallpaper-engine] 扩展模块 id 重复注册：" + id + "（同一份 bundle 求值两次，或两个包抢同一个 id）");
  }
  weExtensionModuleSeq += 1;
  weExtensionModuleTable.set(id, { descriptor, seq: weExtensionModuleSeq });
  weRegistryFire();
  return descriptor;
}

/** 屏上顺序 = (order, 注册序)：跨包求值顺序不保证，所以顺序**必须**由描述符声明，不靠数组序。 */
function weExtensionModules() {
  return Array.from(weExtensionModuleTable.values())
    .sort((a, b) => {
      const ao = typeof a.descriptor.order === "number" ? a.descriptor.order : WE_EXTENSION_DEFAULT_ORDER;
      const bo = typeof b.descriptor.order === "number" ? b.descriptor.order : WE_EXTENSION_DEFAULT_ORDER;
      return ao === bo ? a.seq - b.seq : ao - bo;
    })
    .map((e) => e.descriptor);
}

/**
 * 登记一条**行为层**钩子（画布层 / 视差层这样的"活着的东西"）。
 * `sync` 与 `dispose` **缺一即抛**：只有 sync 的层会留在屏上，只有 dispose 的层从不显形。
 * 迟到注册（子包产物在插件挂载之后才求值）由 attacher 立刻补接，不用等下一次挂载。
 */
function weRegisterLayerHooks(id, hooks) {
  if (typeof id !== "string" || id === "") {
    throw new Error("[wallpaper-engine] 层钩子 id 必须是非空字符串");
  }
  if (!hooks || typeof hooks !== "object") {
    throw new Error("[wallpaper-engine] 层钩子 " + id + " 必须是对象");
  }
  if (typeof hooks.sync !== "function" || typeof hooks.dispose !== "function") {
    throw new Error("[wallpaper-engine] 层钩子 " + id + " 必须同时给 sync 与 dispose —— "
      + "缺一个就会留下一条只显形不收尾（或只收尾不显形）的层");
  }
  if (hooks.discoveredGroups !== undefined && typeof hooks.discoveredGroups !== "function") {
    throw new Error("[wallpaper-engine] 层钩子 " + id + " 的 discoveredGroups 必须是函数（面板按它画「插件前端」那几行）");
  }
  if (weLayerHookTable.has(id)) {
    throw new Error("[wallpaper-engine] 层钩子 id 重复注册：" + id);
  }
  weLayerHookTable.set(id, hooks);
  if (typeof weLayerAttacher === "function") {
    try { weLayerAttacher(id, hooks); } catch { /* 补接失败不许把注册链带崩（挂载期那次会再报） */ }
  }
  weRegistryFire();
  return hooks;
}

/** [id, hooks] 列表（挂载/拆卸期遍历用；顺序 = 注册序）。 */
function weLayerHooks() {
  return Array.from(weLayerHookTable.entries());
}

/** 该层认到的插件槽位（没有这层 / 没声明 discoveredGroups ⇒ 空数组，不是 undefined）。 */
function weDiscoveredGroupsOf(id) {
  const hooks = weLayerHookTable.get(id);
  if (!hooks || typeof hooks.discoveredGroups !== "function") return [];
  const groups = hooks.discoveredGroups();
  return Array.isArray(groups) ? groups : [];
}

/** 挂载期装上/摘下「补接一条迟到的层钩子」的函数（由 client.js 在 ctx.effect 里成对设置）。 */
function weSetLayerAttacher(fn) {
  weLayerAttacher = typeof fn === "function" ? fn : null;
}

/** 挂载期装上/摘下「注册表变了 ⇒ 重画面板」的回调（同上，由 client.js 成对设置）。 */
function weSetRegistryListener(fn) {
  weRegistryListener = typeof fn === "function" ? fn : null;
}

export {
  weRegisterExtensionModule,
  weExtensionModules,
  weRegisterLayerHooks,
  weLayerHooks,
  weDiscoveredGroupsOf,
  weSetLayerAttacher,
  weSetRegistryListener,
};
