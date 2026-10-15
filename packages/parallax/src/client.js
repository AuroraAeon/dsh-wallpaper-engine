/**
 * packages/parallax/src/client.js —— 「3D 效果」子包的**浏览器半边入口**（P-A，task-3 草案）。
 *
 * 构建期形状与 packages/fx/src/client.js 完全同形（见那份文件头的长注释）：本文件 = 入口，
 * 构建期只取**首个块注释之后**的正文；包内 INLINE_MODULES（src/parallax-layer.js、
 * src/ext-parallax.js）被内联到正文之前，与正文同一个 factory 作用域 ⇒ 那两份里的裸名由本文件的
 * prelude + 构建期那一行 host 绑定共同提供，兄弟文件之间**不 import**（零改动迁移）。
 * 注：src/ext-parallax.js 的样式归主包 src/styles.js 管，所以本包只注入"行为层 + 描述符"两份。
 *
 * ⚠️ 本文件同样**不许**出现 require/import（test/verify-subpackage-purity.mjs:84/147-148 只放行
 *    客户端产物里的 require('dsh-plugin-wallpaper-engine')）⇒ 那行绑定由构建循环 outline 在正文与
 *    内联件之前发出：`const host = require('dsh-plugin-wallpaper-engine');`。下面的 prelude 是消费侧契约。
 *
 * 键集的依据（acorn 扫描的逐行清单）：
 *   packages/parallax/src/parallax-layer.js : selection×12 · weClampTo×7 · weNow×6 · weBody×4
 *   packages/parallax/src/ext-parallax.js   : weT×28 · React×7 · SliderRow×7 · switchRow×4
 *   ⚠️ PARALLAX_PLUGIN_DEFAULT(line 60) / PARALLAX_GROUP_DEPTH_MIN / PARALLAX_GROUP_DEPTH_MAX(line 64)
 *   三枚由**同包** src/parallax-layer.js 声明 ⇒ 走包内内联，**不进**宿主键集（这是本包与 fx 包
 *   在接缝上唯一的差别）。
 */

/** 缺键**大声失败**，不许静默 undefined（D-8 + D3③）。理由同 packages/fx/src/client.js。 */
const PARALLAX_HOST_REQUIRED = [
  // 内核（只读面）
  'selection', 'weNow', 'weClampTo', 'weBody',
  // 渲染助手（主 bundle 的共享零件表）
  'React', 'weT', 'switchRow', 'SliderRow',
  // 贡献面（主 bundle 的收件箱：值 + 回调，写权留主包）
  'registerExtensionModule', 'registerLayerHooks',
];
for (const key of PARALLAX_HOST_REQUIRED) {
  if (!(key in host)) {
    throw new Error('[wallpaper-engine-parallax] 主 bundle 键集缺少 "' + key
      + '"（D-8 显式键集：要么补键，要么改申报表，不许静默 undefined）');
  }
}
const {
  selection, weNow, weClampTo, weBody,
  React, weT, switchRow, SliderRow,
  registerExtensionModule, registerLayerHooks,
} = host;

/* ===== 贡献 ===== */

// ① 「扩展」页签的三号模块描述符（id='parallax'，resetGroup 同为 'parallax'，与包名无关）。
//    主包 src/panel-tabs.js:261 的静态数组改成读注册表后，这一行就是它的来源。
registerExtensionModule('parallax', PARALLAX_EXTENSION_MODULE);

// ② 行为层生命周期 + 插件槽位发现。主包 src/client.js 今天对这些裸名有 6 处引用，另有一处在
//    extensionCtx() 里（4358）：
//      5365/5371 subscribe(syncFxLayer/syncParallaxLayer) · 5492/5493 syncXxxLayer() · 5536/5539 disposeXxxLayer()
//      4358 `parallaxPluginSlots: sel.parallaxPlugin === true ? parallaxDiscoveredGroups().sort() : [],`
//    ⇒ discoveredGroups 与 sync/dispose 一起注册（主包只调用、不接管实现）。
registerLayerHooks('parallax', {
  sync: syncParallaxLayer,
  dispose: disposeParallaxLayer,
  discoveredGroups: parallaxDiscoveredGroups,
});
