/**
 * packages/fx/lib/index.js —— 「点击效果与拖尾效果」子包的**宿主半边**。
 *
 * 这一族的实现**全在浏览器半边**（packages/fx/src/*.js，入口 src/client.js，产物 lib/client.fx.js）。
 * 宿主侧**零实现、零路由、零服务**：按 docs/wip/BUNDLE-SPLIT.md §2.2，官方对"纯浏览器包"的写法
 * 就是空宿主壳（in-box 的 dsh-client-ui-layout/lib/index.js 全文只有 function apply() {}）。
 * 它在 cordis.patch.yml 里是一条**独立插件行**（id=wallpaper-engine-fx / name=本包真实包名）。
 *
 * 但"空壳"不等于"不接线"（m00214 §3 ③）：
 *   ① apply 先向**唯一受控叶子** `dsh-plugin-wallpaper-engine/subpackage-boot.js` 要一份本包的
 *      **显式键集**（subpackageKeys('fx')）—— 缺 id 会抛、不静默 undefined；这是子包与主包之间
 *      **唯一**的通道（§5.1 ② / §5.2 允许清单第 2 条：不新开 Service、不 import 主包其他叶子、
 *      不出现任何指向主包的相对路径）。启动自检的宿主侧那一半就是这一步：键表不存在就大声红。
 *   ② 拆除账照交：D15「teardown 必须交 ctx.effect」⇒ 用 handOffTeardown(ctx, dispose) 转发。
 *      宿主半边零副作用 ⇒ dispose 是空操作，但形状与 lib/components/<组件>/index.js 同形。
 *
 * 纪律：不再注册额外 ctx.effect（不留残留，D-12 / §13 风险 #11）、不读 config、不 acquireKernelLease、
 * 模块顶层只有 import/声明（无求值期副作用、无定时器、无 window/DOM）。产物（lib/client.fx.js）
 * 落盘前不要声明 dsh.client / exports["./client"]：声明了却没有产物，客户端会按 id 去取那个
 * lazy factory 然后抛错（§2.2）。
 */
import { subpackageKeys, handOffTeardown } from 'dsh-plugin-wallpaper-engine/subpackage-boot.js';

export const name = 'dsh-plugin-wallpaper-engine-fx';

/** 宿主侧不需要任何宿主服务：空数组是**表态**（"我不依赖任何宿主服务"），不是遗漏。 */
export const inject = [];

export function apply(ctx) {
  // ① 显式键集：叶子契约是"缺 id 抛错（不静默 undefined）"，这里再兜一层形状判据。
  //    （叶子 lib/subpackage-boot.js 已落地：SUBPACKAGE_KEY_TABLE.fx = base / log（不消费的键不进表）；
  //      传 ctx 让 log 同时落平台通道。）
  const keys = subpackageKeys('fx', ctx);
  if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) {
    throw new Error('[wallpaper-engine-fx] subpackageKeys("fx") 没有返回键集对象（D-8 显式键集契约）');
  }
  // 宿主半边刻意**不用** keys 做任何事（这一族的全部行为都在浏览器半边）。
  // 读一次 = 键表真的存在，失败即大声抛：这就是启动自检里属于宿主半边的那一半。
  void keys;
  // ② 拆除账照交（D15）：空壳 = 空操作，但 teardown 必须走 ctx.effect。
  return handOffTeardown(ctx, () => {});
}

export default { name, inject, apply };
