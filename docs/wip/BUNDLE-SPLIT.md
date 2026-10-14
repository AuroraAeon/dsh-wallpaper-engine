# 插件包重构手册 —— 多包拆分（主包 + 核心子插件 + 边缘子插件）

> **哈希说明（squash 后）**：本文件中的短哈希是 **squash 前历史哈希**。追版本第二期收口已把
> `c43a936..352467a` 的 **108 笔**压缩为一笔（父 = `c43a936`，树内容逐字未变），该提交以 tag `catchup-2nd` 标注。
> 原文可由分支 `backup/pre-squash-20261014` 取得；逐条对应见该提交正文附录。
> 新增引用请优先使用 tag `catchup-2nd`。


> **本文是这条重构线的唯一执行口径**：目标架构、机制约束、包边界、通讯纪律、阶段计划、判据改造、发布流程。
> **决策正本** = [`adr/0012`](../adr/0012-bundle-multi-component-rows.md)（目标与判据、开关语义、明确不做的事）；
> 本文**只写"怎么做"**，与 ADR 重复的目标陈述一律改成指针。
> **写作纪律**（[`docs/README.md`](../README.md) §写作纪律）：不抄会漂的数值；证据锚点用**符号名 / 文件路径 / 复算命令**；
> 行号必漂，一律不写。**状态**：进行中（住 `docs/wip/`，收口后按 §11 移入 `docs/archive/wip/`）。

**基线**：上游 `main` + 未发布增量；当前形态 = **单包 + 4 个插件行**（`dsh-plugin-wallpaper-engine`）。
**目标形态** = **主包 + N 个子插件包**（版本一致、一次安装落地、代码各自成包、第三方代码除外）。

---

## 1. 目标架构

### 1.1 蓝图（用户口径，2026-10-14 重述）

| 包 | 职责 | 备注 |
|---|---|---|
| **主包** `dsh-plugin-wallpaper-engine` | 设置面板、配置文件、WE 壁纸获取、多平台识别与差异处理、**留给其它插件的钩子**、以及"大部分组件都依赖的基础模块" | 唯一被"一次安装"的名字 |
| **壁纸子插件** | WE 壁纸与自定义导入壁纸的**渲染**；壁纸库 + 播放-画面里的配置项、声音、省电 | 以现在的 `lib/components/media-bridge` 为基础，**大改** |
| **UI 子插件** | 玻璃面板、侧边栏圆角等**前端 UI**；外观里的配置项 | **字体除外** |
| **字体系统子插件** | 字体集 / 排版 / 应用 | 已可自成一系 |
| **点击与拖尾效果子插件** | `src/fx-layer.js` 一族 | 天然低耦合 |
| **3D 效果子插件** | `src/parallax-layer.js` 一族 | 天然低耦合 |

**贯穿性约束**：
1. **实现代码搬进各自插件**（不是"目录搬、实现留主包"）；
2. **第三方代码除外** —— 现在是 `lib/webwallgl/**`（vendored，1.15 MB）：**"不搬"= 留在主包**，
   由 `WEBWALLGL_DIR` 作注入键交给需要它的包（见 §9.4 的两种做法与取舍）；
3. **所有子包版本一致**（不追求独立发布）—— 这条把"发布面 ×N"的成本消掉（见 §4.1）；
4. **组件之间明确的通讯纪律**（见 §6）。

### 1.2 与现行 ADR 的关系

- 现行形态（单包多行）与 D3（关掉一行 ⇒ 路由不注册 ＋ 界面不渲染）**已经落地**，是本手册的**起点**；
- 目标形态（多包）需要**修订 ADR-0012 的 D8**（"不做多包 monorepo"）。修订理由**只有一条**：
  **降复杂度与解耦**（用户口径：独立发布不必要；版本一致更方便管理）。**"关掉即不下载"仍是非目标（D16）**。

---

## 2. 三个核心概念（先立起来，后面全依赖它们）

### 2.1 包边界 = 卸载边界（Cordis 原生，不是我们发明的）

Cordis 的级联只有**一个判据**：`name in fiber.inject`（`cordis/src/reflect.ts` 的 `notify()` → `_refresh()`）。
提供方消失时：消费者 `ACTIVE` → `_unload()` → `PENDING`（**park，不抛错**）；提供方的 disposer 会
**await 所有消费者卸完**才返回。恢复时 epoch 变化 ⇒ 消费者**重跑一遍 `apply`**。

**推论（写进纪律，不靠人记）**：
- 跨包依赖**必须**走 Cordis 服务（`ctx.provide` / `export const inject`）；
- **禁止**：`ctx.get(name, false)` 惰性取值后缓存、直接 `import` 另一个包的模块级导出、模块级共享单例
  —— 这三条在停用时**静默半挂**，没有任何告警（见 §5.2 的失败形态表）。

### 2.2 四个半边（每个子包都要自己回答"我占哪几个"）

| 半边 | 是什么 | 缺了会怎样 |
|---|---|---|
| **宿主实现** `lib/index.js` | 一个可调用的 `apply`（哪怕空） | **不可省**：Loader 行的目标必须是函数或 `{apply}`，否则装载期报错 |
| **宿主行** `cordis.patch.yml` 里的一行 | 让宿主知道"有这么一个插件" | 整包不存在（行级失败是**只打印、不中断启动**，见 §5.1） |
| **浏览器半边** `exports["./client"]` + `dsh.client` | 界面/样式/槽贡献 | **可选**（in-box 218/289 个包没有）；缺了不影响宿主半边 |
| **行元数据** `exports` 三连 + `locale/` + `icon` | 插件管理器里的标题/描述/图标 | **静默降级**：显示裸 specifier |

**官方对"纯浏览器包"的写法**：**空宿主壳**。in-box 的 `dsh-client-ui-layout/lib/index.js` 全文
只有 `function apply() {}` 与一行注释 —— 这是被认可的形态，不是取巧。

**⚠️ 最容易漏的一条**：浏览器半边**只能由"活动的 Loader 行"发现**（`dsh-client-modules` 的
`processOne` 只遍历 `ctx.loader.entries()`，且要求 `entry.fiber && !entry.disabled`）。
⇒ **子包行必须被某个已选中的 bundle 的 patch 插入**；只把它写进 npm 依赖**不会**让它出现在浏览器里，
而且**没有任何判据会告诉你**。§7.6 的启动自检就是为这条设的。

### 2.3 "一次安装" = 主包的 patch 引用子包（唯一三通道都支持的语义）

| 语义 | 形态 | Web 一键装 | Agent 工具 | CLI |
|---|---|---|---|---|
| **A（采纳）** | 主包 `dependencies` 精确依赖子包；**主包自己的 patch** 用 `name: '<子包名>'` 插入子包行 | ✅ | ✅ | ✅ |
| B | 每个子包各是独立 bundle（各自 `dsh.bundle.patch`、各自进 `dsh.profile.bundles`） | ❌ `ambiguous-install` | ❌ 同左 | ✅ `dsh plugin add a b c` |

**为什么 A 三通道都行**：`installBundle` 只把**主包**写进 profile 的 `dependencies`；子包作为**传递依赖**
被 pnpm hoist 到 `profile/node_modules` 顶层，`resolveBundleDir` 用 `require.resolve.paths` 就能命中
（本机实证：`js-yaml` / `undici` / `zod` 都在顶层）。宿主还会**连带校验** patch 指向的每个包的
`peerDependencies`（`bundleComponentManifests`）—— 任一不匹配 ⇒ 整次安装被拒并回滚（含 `node_modules` 修复）。

**B 为什么不行**：`installBundle` 硬性要求"这次 `pnpm add` 恰好让 1 个包从无到有"（`installed.length === 1`），
多一个就 `ambiguous-install` 拒绝。⇒ **不采纳 B**。

---

## 3. 行标识与兼容性（决策：零迁移代价）

**现状（必须原样保留）**：

| 行 id | 行 `name`（现为子路径 specifier） |
|---|---|
| `wallpaper-engine` | `dsh-plugin-wallpaper-engine` |
| `wallpaper-engine-about-notice` | `dsh-plugin-wallpaper-engine/about-notice` |
| `wallpaper-engine-mascot-avatar` | `dsh-plugin-wallpaper-engine/mascot-avatar` |
| `wallpaper-engine-media-bridge` | `dsh-plugin-wallpaper-engine/media-bridge` |

**开关机制的两条硬事实**（决定兼容策略）：
1. 开关写入 = `writePluginEnabled(filename, id, name, enabled)`：在 profile 的 `cordis.patch.yml` 里找
   **最后一条** `id` 相同、**且 `name` 相符**的非 `insert` 覆盖项，只改它的 `disabled`；找不到就追加一条。
   ⇒ **`id` 与 `name` 任一变了，老用户的开关记忆就丢**（覆盖项变成 warn-then-skip 的孤儿）。
2. 行自身带 `insert` 键的条目**不可通过 UI 开关**（`item.has('insert')` 直接跳过）—— 这是 `- insert:` 这个
   **YAML 语法**与"行上有个 `insert` 字段"的区别；我们插进 `- insert:` 列表里的行**没有** `insert` 键，
   **可以开关**（真机实证：profile patch 里有 `- id: wallpaper-engine-about-notice / disabled: false`）。

**结论（决策）**：**老行出口时保留 `id` 与 `name` 两者不变**。
子包在自己 `package.json` 的 `exports` 里保留同名子路径（`"./<c>"` / `"./<c>/package.json"` / `"./<c>/locale/*.json"`），
于是主包 patch 里那一行的 `name` 一个字都不用改，**老用户零迁移**。
（Agent 另写"新行才用真实包名"的做法**不采纳**：它要求一次性重置所有用户的开关记忆。）

**新增子包**（字体 / 点击效果 / 3D / UI / 壁纸）用**真实包名**做行 `name`，且**先把 `id` 定死**（一旦发布不许改 id）。

---

## 4. 机制约束清单（**已逐条取证；实施时以此为准**）

取证方式：解析 `app.asar`（`headerSize = uint32LE@12`，`base = 16 + headerSize`）+ 阅读
`@deepseek-ai/{dsh-plugin-manager,dsh-app-boot,dsh-client-modules,dsh-client-hmr,cordis}` 的产物与 README。
抽取件与复算脚本见 §附录 D。

### 4.1 安装 / 分发

| # | 事实 | 对我们的约束 |
|---|---|---|
| I1 | Web / Agent 工具的安装面是**单 spec**；`installBundle` 要求"恰好 1 个新直接依赖" | 子包**不得**各自成为被单独安装的 bundle（语义 A） |
| I2 | CLI `dsh plugin add a b c` 是 `pnpm` 直通 + `reconcile()`：一次命令可落地 N 个并全部选入 bundles | 发布/升级流程的**唯一**多包通道；Web 装不了多包 |
| I3 | `bundledDependencies`、`workspace:`、真实 monorepo **都不被支持**（全 asar 零命中 / 显式拒绝） | 子包必须是**普通 npm 包**；主包用精确版本依赖它们 |
| I4 | patch 行 `name` 支持：裸包名 / 子路径 / `./`·`../`（相对 patch 文件）/ 绝对路径 / `file://` | 主包 patch 用**裸包名或子路径**引用子包即可 |
| I5 | 行级失败（包解析不到、`ERR_MODULE_NOT_FOUND`）**只影响那一行**，不中断启动、不报安装错 | 必须自己加**启动自检**（§7.6） |
| I6 | 宿主会连带校验 patch 指向的每个包的 `@deepseek-ai/dsh-*` peer；任一不合 ⇒ **整次安装被拒 + 回滚** | 子包的 peer range 必须与主包**逐字对齐** |
| I7 | 宿主无 `overrides` / `resolutions`，也不校验"包组版本一致" | 版本一致靠**我们的发布纪律**（精确版本 + 只在主包 `dependencies` 里出现） |
| I8 | 没有 `update_bundle`；更新已选 bundle 返回 `restart-required`；卸载**允许**部分变更 | 升级 = 卸载 + 重装 + **重启**；写进用户文档 |
| I9 | 服务路径 N 包 = N 次独立操作（无跨包事务）；CLI 单命令在 manifest/lockfile 层近似原子 | 升级走 CLI 单命令 |

### 4.2 行开关与热更新

| # | 事实 | 对我们的约束 |
|---|---|---|
| R1 | 开关只改 profile `cordis.patch.yml` 的覆盖项，**保留注释**、只改最后一条 `id`+`name` 匹配项 | 见 §3（保留 id 与 name） |
| R2 | 行不写 `disabled` ⇒ **默认开**；要"默认关"必须在 bundle 自己的 patch 里写 `disabled: true` | 新子包的默认值在这里定 |
| R3 | `hanging`: HMR 缺席时 `reload()` 直接返回 `[]`，结果记 `restart-required`；`dsh-hmr` 监听 profile 的 `package.json` + 两份 patch（**不含 bundle 自己的 patch**） | **改行后要重启/重载才生效**（现行 README 已写）；改 bundle 自己的 patch 需要重装 |
| R4 | profile manifest 的 `dsh.profile.patchReload`（本机 = `"live"`）控制行开关能否热生效 | 文档里要与 R3 一起讲清 |

### 4.3 卸载 / 停用语义

| # | 事实 | 对我们的约束 |
|---|---|---|
| U1 | 停用一行 ⇒ `Entry.disabled = true` ⇒ fiber dispose；`entries()` **仍列出**它（`entry.fiber` 已废） | 读 `entries()` 的代码要自己过滤 `disabled` |
| U2 | dispose 顺序 = **LIFO 启动、并发完成**（`Promise.all`），单个 disposer 异常**被吞**（只记日志） | 清理要有序时，别指望 dispose 顺序 |
| U3 | **模块缓存不清**（ESM `loadCache` / `require.cache`）：只有 HMR 的替换路径清 | **模块顶层副作用不随停用消失** —— 别在模块级起定时器/挂 window |
| U4 | 级联的唯一判据是 `inject` 声明面；`ctx.get(name,false)` 缓存的消费者**不被级联** | §2.1 的纪律 |
| U5 | 停用"被依赖的行"时：运行期是**安全 park + 提供方等消费者卸完**；但 `reconcileProfilePatches` 会把"新出现的 inactive 行"当失败**抛错**，插件管理器记 `application: 'failed'`，且**不回滚 YAML** | 关主包会**大声失败**（对"整族一起下去"是好事）；要用"停用主包"当正常操作时需重新评估 |
| U6 | 客户端侧启停走 `ClientEntries.sync(graph)`：`loader.remove` → 等 `fiber.inertia` → `prune` 模块与样式（`style[data-plugin=<id>]`） | 浏览器半边**可逆**、样式会回收 |
| U7 | 客户端侧代码替换走 `reload()`：**无回滚**；换 bootstrap 包被硬拒（`requires a page reload`）；**纯 JS import 的消费者不会跟着换** | 跨包协作只走 Cordis 服务（in-box 构建期 purity gate 就禁止跨插件 value import） |
| U8 | 卸载彻底性 = 你把副作用注册进 `ctx.effect` 的程度；window / DOM / 定时器 / 原生句柄**不在回收面** | 每个包都必须交拆除函数（本仓已有 `handOffTeardown`） |

### 4.4 客户端（浏览器半边）

| # | 事实 | 对我们的约束 |
|---|---|---|
| C1 | 一个包 = 一个客户端 graph row（`exactPackageSpecifier` → `nearestPackage` → `table.set(包名, …)`）；子路径行不参与扫描 | 子包要浏览器半边 ⇒ **自己是一个包**（不能靠主包的子路径） |
| C2 | 缺 `dsh.client` ⇒ **静默 return null**（连否定结论都被缓存）；声明了却缺 `exports["./client"]` ⇒ **抛错** | 四个半边缺一不可（§2.2） |
| C3 | 跨包模块只能 `require`：`seed 静态表 → loadCache → factories → throw`；静态表由外壳注入且**不可扩展** | 共享长命对象**没有**干净通道；`external` 是窄口逃生舱 |
| C4 | `external` 只做"排到消费者之前"；provider 缺席时**到达阶段静默跳过**，真用到才抛；in-box 71 个客户端包只有 5 个用它 | 默认用 `dsh.client.inject` 排顺序；`external` 要有明确理由 |
| C5 | `inject`（客户端）只影响到达顺序，缺席**完全静默** | 不能用它表达"必须有" |
| C6 | React / react-dom / cordis / slots / primitives / client-store 在静态表里共享（双 React 问题不存在） | 子包不要内联自己的 React |

### 4.5 设置与配置（现存单一真源的约束，不变）

| # | 事实 | 对我们的约束 |
|---|---|---|
| S1 | `lib/settings-schema.js` 是**宿主 import + 构建期内联**的**唯一共享内核**（`verify-module-layout` 的白名单只许一项） | 多客户端半边要么各内联一份（产物 ×N + 漂移），要么宿主下发，要么子包不碰 schema |
| S2 | `settingsVersion` 是**全局单计数器**，`migrateSettings` 在 `sanitizeFromSchema` 入口（幂等靠版本短路） | **迁移只能由持有 schema 的那一侧跑**；子包各带 schema ⇒ 版本号在包间来回摆动 + 对已换算值反复换算（数据损坏级） |
| S3 | `sanitizeFromSchema` 是**白名单**：不认识的键**静默丢弃** | 子包不认识别的包的键 ⇒ 一次写入抹掉别人的键（ADR-0002 记录的原始 bug 型） |
| S4 | 7 个设置簇（`core` / `appearance` / `mascot` / `fx` / `parallax` / `typeColor` / `media`）**不是按插件边界画的** | 见 §6.3 的三选一 |
| S5 | `config.json` 有 4 个根字段（`settings` / `fontSetId` / `uploadDir` / `cacheDir`），写串行化 = `enqueueConfigWrite` 的**模块级队列** | 队列必须**进程唯一**（§5.1 的共享内核问题） |
| S6 | `PROFILE_PRESET_KEYS`（116 键）横跨**全部 7 簇**；预设资产段横跨字体 / 立绘 / 头像三族 | 预设是最硬的跨包面，见 §6.4 |

---

## 5. 三个必须先解决的架构问题

### 5.1 共享可变资源的"单例语义"（**正确性前提，不是偏好**）

以下三样**不是"能力"，是"进程内唯一实例"**，各包各带一份就错：

| 资源 | 现在住在哪 | 各带一份的后果 |
|---|---|---|
| 配置写队列 `configWriteQueue` / `atomicTmpSeq` | `lib/kernel/config.js`（工厂内 `let`） | 并发写同一份 `config.json`，读-改-写窗口重开 |
| 内核租约 `KERNEL_LEASES` + `transcodeKit.dispose()` | `lib/kernel/host-kernel.js`（模块级 `WeakMap`） | 要么**提前 dispose**（打断在途 ffmpeg），要么**永不 dispose**（子进程泄漏） |
| 媒体源 loopback（`createMediaOrigin`） | `createHostSession` 每次 apply 一份 | 多个 port，`/inventory` 报哪个不确定 |

**三条出路（必须选一条，且写进 ADR）**：
- **① 主包以 Service 形式提供**（`export default class extends Service`）：官方三种导出形态之一，宿主侧**全仓零先例**；
  代价 = 主包行从"纯插件"变成 provider，`verify-component-face` 的硬编码数字（95/88/15）必须同步改。
- **② 子包 `import` 主包的叶子模块**：形状最简单、今天就能做；代价 = 把内核内部面公开进 `files`，
  且撞 `verify-module-layout` 的"共享内核白名单只许一项"。
- **③ 把内核下沉成独立小包**（`dsh-plugin-we-core`）：边界最干净；代价 = 多一个发布面 + 新包名要进各守卫的顶层目录地板。

> **本手册的建议**：**先走 ②**（零新机制、可立即验证），把 ① 作为"② 撞到白名单/耦合墙时"的升级路径。

### 5.2 跨包通讯纪律（**写进判据，不靠人记**）

**允许**：
1. Cordis 服务（`ctx.provide` / `inject`）—— 唯一有级联语义的通道；
2. 宿主注入的**显式键集**（今天 `COMPONENT_VIEW_KEYS` / 路由族 `export const DEPS` 的形态）；
3. **纯数据**的跨包读（`/inventory` 的 `components` 面、`COMPONENT_VISIBILITY` 这类声明面）。

**禁止**（每条都有对应的失效形态）：
| 反模式 | 失效形态 |
|---|---|
| `ctx.get(name, false)` 后把值存进闭包 | 提供方停用 ⇒ **不级联**，子包拿旧引用继续跑 |
| 直接 `import` 另一个包的模块级导出 | 同上；且 HMR 后是**旧代 exports** |
| 模块级共享单例（跨包） | 停用不清（U3），且各包各一份（§5.1） |
| 跨包 `require` 长命对象 | 客户端 HMR 代际：消费者不跟着换（U7） |

### 5.3 客户端半边：拆到哪一层

**必须带客户端半边**：UI 子插件（玻璃/圆角）、字体子插件、点击拖尾效果、3D 效果（它们的实现在 `src/**`）。
**可以只有宿主半边**：以宿主路由/进程为主的功能（例如媒体桥的后端）。
**"纯浏览器包"用空宿主壳**（§2.2）。

**跨包共享的浏览器侧依赖**（今天 `selection` / `emit` / `i18n` / 共享零件表）**没有干净通道**：
- 走服务（要定义服务面与生命周期）；
- 或"值 + 回调"（子包只是渲染器，写权留主包）；
- **不要**用 `external` + `require` 传长命对象。

---

## 6. 需要产品/架构拍板的四个问题（**在动手前必须表态**）

### 6.1 "配置项归子插件" = 代码归属还是**状态归属**？

| 选项 | 形态 | 代价 |
|---|---|---|
| **A 代码归属** | 子包提供渲染器/描述符；`selection` / `setSetting` / `emit` / 持久化全留主包 | 最小改动；但"实现代码搬进插件"只剩目录归属 |
| **B 各注册 `settings.section`** | 每个子包 `ctx.slots.inject("settings.section", …)` | 零跨包依赖；但设置页会多出 N 行导航，主面板的页签胶囊/玻璃壳用不上 |
| **C 状态也分家** | 各包自持 store / 持久化 / 设置段 | 最贴蓝图；要拆 `selection`、`persistSelection`、`quick-panel` 与设置页共用的渲染器，并重写多条守卫 |

### 6.2 客户端半边怎么协作（服务面形状）

若选 C，必须定服务名与形状（`weSettings` / `weKit` / …）、生命周期、以及**provider 缺席时的期望**
（park 是默认；`external` 会抛）。**这一条决定后面所有接缝的形态。**

### 6.3 设置簇要不要按插件重画？

- **重画**（`core.library` / `core.playback` / `appearance.glass` / `appearance.ui`…）：7 条路由变 N 条，
  `verify-settings-namespaces` 的 `EXPECT_COUNTS` 与分区对账全要重写，老客户端与老存档要语义映射；
- **不重画**（两个包共用一个簇）：**单写者（M4=0）不变量立刻破功**。

> **二选一，没有第三条。**

### 6.4 预设（`PROFILE_PRESET_KEYS`，116 键 / 7 簇 / 3 资产族）怎么跨包？

它是唯一"路由不写设置却必须理解所有包的键"的落点（`sanitizePresetValues` / `installAssets`）。
三选一：主包聚合（子包把键注册进主包）/ 每包自带片段 + 宿主装配 / 拆成多个预设。

### 6.5 （附带）主包被关掉时子包怎么办？

U5 说运行期是**安全 park**，但插件管理器会报 `failed`。若"停用主包"要当正常操作，需给它一个明确的用户可见语义。

---

## 7. 阶段计划

> **贯穿纪律**：① 每阶段先落**判据**、再改实现（ADR-0012 D12 的教训）；
> ② 每阶段独立提交、可单独 revert；③ 每阶段末跑 §7.7 的验收；④ **不许先放宽守卫再改**。

### 7.0 起步态（已达成，作为基线）

单包 + 4 行；D3 的界面级开关语义已落地（状态面 `/inventory.components`、可见面声明 `lib/components/visibility.js`、
判据 `test/verify-component-visibility.mjs`）；`npm run verify:all` 全绿。**历史进度与度量口径见本文件末 §12。**

### 7.1 P-A 试点：三个小子包（**建议从这里开始**）

**目标**：把"多包 + 一次装 + 启动自检 + 跨包服务"这条链走通，**不动 `selection` / 设置面板**。

| 子包 | 搬什么 | 占哪几个半边 |
|---|---|---|
| 点击与拖尾效果 | `src/fx-layer.js`、`src/ext-fx.js`（`FX_EXTENSION_MODULE`） | 宿主空壳 + 浏览器半边 + 一条行 |
| 3D 效果 | `src/parallax-layer.js`、`src/ext-parallax.js`（`PARALLAX_EXTENSION_MODULE`） | 同上 |
| 字体系统 | `src/font/**`、`src/fontset-store.js`、`src/fontset-editor.js`、`src/system-fonts.js`；宿主侧 `lib/routes/{fontsets,system-fonts}.js` | 宿主实现 + 浏览器半边 + 一条行 |

**动作**：① 建三包（`packages/` 或独立仓库，落点见 §8.1）；② 主包 `dependencies` 精确依赖三者；
③ 主包 patch 里 `insert` 三行；④ 加启动自检与"行在 patch 里"的判据（§7.6）；
⑤ 把 `extensionModules()` 从**静态数组**改成"读注册表"（首个跨包贡献点）。
**判据**：三包能被单独停用且界面/路由各自消失（复用 D3 的可见面判据）；主包不装子包时**大声报错**。

### 7.2 P-B 基础设施

- **构建**：`scripts/build-client.mjs` 从"单产物 + INLINE_MODULES"改成"**按包出产物**"（每包一个 `lib/client.<pkg>.js`），
  主包保留自己的半边；`verify-client-sync` 要覆盖 N 个产物。
- **守卫**：把单包硬假设参数化（见 §7.5）。
- **服务**：按 §5.1 选定的出路实现（② 或 ①）。
- **纪律判据**：`external` / `inject` 的使用面、"无跨包 value import"。

### 7.3 P-C UI 子插件

玻璃面板（`src/glass.js` / `src/glass-panel.js` / `src/styles.js` 的 UI 部分）、侧栏圆角、外观里的 UI 配置项。
**前置**：§6.1 与 §6.3 已表态；§6.2 的服务面已定。

### 7.4 P-D 壁纸子插件（**最大的一块，最后做**）

以 `lib/components/media-bridge` 为基础大改：WE 壁纸与自定义导入壁纸的渲染、壁纸库 + 播放-画面里的配置项、声音、省电。
**前置**：层的所有权（`LAYER_ID` / `SCRIM_ID` / iframe 的建立与退役）必须有唯一所有者，否则两个包各建层 = 撞单例 id。
**注意**：`lib/webwallgl/**` 的三方代码按 §9.4 的决策留在主包或随包。

### 7.5 P-E 收尾

文档（`CODE-STRUCTURE` / `HOW-IT-WORKS` / 三份 README / `CONTRIBUTING` / CHANGELOG 四段式）、生成物重算、本文件移入 `docs/archive/wip/`。

### 7.6 **新增判据（三条，现在零覆盖）**

1. **启动自检（宿主）**：主包 `apply` 里主动 resolve 每个子包与其行，失败**大声报错**
   （因为行级失败是静默的，I5）。
2. **浏览器半边在场判据**：每个带 `dsh.client` 的子包，其**行必须被某个已选中的 bundle patch 插入**
   （C2 + §2.2 的那条静默失效）。
3. **跨包纯度判据**：子包之间**没有** value import（in-box 靠构建期 gate，我们得自己写）；
   `external` / `inject` 的使用面要与声明一致。

### 7.7 每阶段验收（命令统一放 §附录 C）

---

## 8. 落到仓库的形态

### 8.1 目录与包布局（待定项）

| 选项 | 形态 | 代价 |
|---|---|---|
| **同仓 workspace** | `packages/<pkg>/`，各自 `package.json` + `dsh.bundle.patch` | 需要新的目录纪律；`host-route-index` / `guard-targets` / `verify-retired-lines` 的顶层目录假设都要改 |
| **多仓** | 每包独立仓库 | 发布/同步成本高；**版本一致**靠人工对齐，与"方便管理"相反 |
| **同仓但不在 `packages/`** | 例如 `sub/<pkg>/` | 同上，只是换个名字 |

> **注意**：`workspace:` / `bundledDependencies` / monorepo 的**安装语义不被 DSH 支持**（I3），
> 但"同仓多包 + 各自发布"在 npm 层是可行的 —— 我们要的只是**同仓开发**，不是 workspace 协议。

### 8.2 每个子包的清单（照抄用）

```
<sub-pkg>/
├─ package.json        # name / version（与主包一致）/ description / icon / type:module
│                      # exports: '.' , './package.json' , './locale/*.json'（有浏览器半边再加 './client'）
│                      # dsh: { bundle: { patch: './cordis.patch.yml' } }（若自己带行）
│                      #     或  dsh: { client: { platform:'web', inject:[...] } }
├─ cordis.patch.yml    # 一条 insert 行（id 定死；默认开/关由 disabled 决定）
├─ icon.png            # 与清单同目录（宿主 iconOf 要求 realpath 不出目录）
├─ locale/{en,zh}.json # meta.title / meta.description（缺了显示裸 specifier）
└─ lib/
   ├─ index.js         # 宿主半边：至少 export function apply(){}（纯浏览器包用空壳）
   └─ client.<pkg>.js  # 浏览器半边（仅当声明了 dsh.client）
```

### 8.3 主包 patch 的变化（示例形态）

```yaml
- insert:
    - id: wallpaper-engine
      name: 'dsh-plugin-wallpaper-engine'
    # 既有组件行：id 与 name 一个字都不改（§3）
    - id: wallpaper-engine-about-notice
      name: 'dsh-plugin-wallpaper-engine/about-notice'
    # 新子包：行名 = 真实包名
    - id: wallpaper-engine-fonts
      name: 'dsh-plugin-wallpaper-engine-fonts'
    - id: wallpaper-engine-fx
      name: 'dsh-plugin-wallpaper-engine-fx'
```

---

## 9. 边界与归属（逐族）

### 9.1 资源目录

| 资源 | 现状 | 破局点 |
|---|---|---|
| `lib/about/**` | `ABOUT_DIR` 由主包 `pluginRoot` 解析 | 若 about 组件出包 ⇒ 资源跟走或主包继续当宿主（作注入键） |
| `lib/fontsets/**` | `FONTSET_BUILTIN_DIR` 同上 | 字体子包出包时一并迁 |
| `lib/glass-presets/**` | 内嵌立绘（`factory-author.json` 的 `assets.mascot.data`） | **跨 UI 与吉祥物两族**，归属要表态 |
| `lib/webwallgl/**` | vendored，**零 import**，只由 `WEBWALLGL_DIR` 常量指向 | 见 §9.4 |
| `assets/**`（仓库根） | 源资产，**不进包** | 派生物目的地会按包变（两份 README 的流程要重指） |
| `lib/types/**` | 类型面，今天 = 主包 | 子包要不要类型面（`verify-types` 要按包循环） |

### 9.2 设置与配置

见 §4.5 / §6.3 / §6.4。**一句话**：schema 与迁移归主包；子包只消费结果（除非 §6.3 选了重画）。

### 9.3 三个既有组件行

| 行 | 目标 | 备注 |
|---|---|---|
| `about-notice` | 可作为**独立子包**（与 UI 相关）或并入 UI 子包 | 判定见 §6.1 |
| `mascot-avatar` | 同上（吉祥物/头像属 UI 面） | 与 `glass-presets` 的立绘资产交叉 |
| `media-bridge` | **改造成壁纸子插件**（用户口径） | 最大的一块；后端/进程能力天然是宿主半边 |

### 9.4 第三方代码（`lib/webwallgl/**`）

| 做法 | 好处 | 代价 |
|---|---|---|
| **留主包**（建议先这样） | `dependencies` 保持为空、CI 零安装、`sync-webwallgl.mjs` 零改动、上游撞车面不变 | 装壁纸子包的人必装主包，体积不省 |
| 随壁纸子包 | 语义归属正确 | `sync-webwallgl.mjs` 与 `BASE_PATH` 单一真源要参数化；上游 #195/#196 的撞车面变化（#196 正要删 vendored 副本） |

> **决策**：**先留主包**（用户口径"第三方代码除外"已经允许），等壁纸子包落地后再评估是否随迁。

---

## 10. 判据与工具改造（**按包循环这一步是主成本**）

### 10.1 单包硬假设的清单（按影响排序）

| # | 文件 / 判据 | 现假设 | 要改成 |
|---|---|---|---|
| 1 | `test/tools/host-route-index.mjs` | `PKG_MAIN` = 本包 `main`；**单份** patch；`<pkg>/<sub>` → `lib/components/<sub>/index.js` | **包清单 → 每包的 main + patch + 行**；**全部下游守卫的根，改它要最后验收** |
| 2 | `test/verify-bundle-rows.mjs` | 仓库根**恰好一份** patch；恰好一行裸包名；其余行 `startsWith(BARE + '/')` | 按包枚举；行命名空间断言按包重写；组件的"图标与包根字节相同"对独立包不成立 |
| 3 | `test/verify-inject-contracts.mjs` | 扫描面 = `lib/routes/*.js` ∪ `lib/components/*/*.js`；地板 `>=21/>=40/>=20` | 扫描面按包派生；地板按新结构重算（**最容易假绿的一处**） |
| 4 | `test/verify-component-face.mjs` | **硬编码** `95 / 88 / 15`；组件目录固定在 `lib/components/` | 数字化契约随服务化同步；目录集合按包 |
| 5 | `test/verify-route-ownership.mjs` | `lib/components/<sub>/index.js` 硬路径；地板 `>=2` | 行→入口的解析改成"读各包 `exports`/`files`" |
| 6 | `test/verify-package-files.mjs` / `verify-package-publish.mjs` | **单份** `files` / `main` / `scripts`；`CHAIN_FLOOR`；入口硬编码 8 项 | 参数化成"每包跑一次"或拆两套 |
| 7 | `test/verify-retired-lines.mjs` | 扫描面地板按**顶层目录**计数（`lib`/`src`/`test`/`scripts`） | 新顶层目录要登记 |
| 8 | `test/tools/guard-targets.mjs` | `walk(src)+walk(lib)`；`ARTIFACT='lib/client.js'` | 按包；产物 N 个 |
| 9 | `test/verify-module-layout.mjs` | 共享内核白名单**只许一项** | 若走 §5.1 出路 ② 要放宽并写理由 |
| 10 | 三份生成物（`ROUTE-INDEX` / `GUARD-MAP` / `TOKEN-CONTRACT`） | 逐字节对账、单份 | 决定"每包一份还是仓库一份" |
| 11 | `scripts/prepare.mjs`（`prepack`） | 源码与产物同包根、只有一份 | 按包循环或只挂主包 |
| 12 | 15 个读 `package.json` 的 `test/`+`scripts/` 文件 | 单包 | 同 #1（先做"包发现"层） |

### 10.2 顺序纪律

1. **先落"包发现"层**（枚举本仓有哪些包：读各包 `package.json` 的 `dsh.bundle` / `dsh.client`）；
2. 再改 **#1**（数据驱动的根）；
3. 然后逐个改下游守卫，**每改一个都要证明"牙还在"**（负对照 + 变异测试）；
4. 生成物用 `--write` 重算，禁手改。

---

## 11. 发布与升级流程（版本一致）

1. **版本**：主包与所有子包**同号**（同一个 `version`）；主包以**精确版本**依赖子包（不用 `^`）；
2. **安装**：用户只装主包一个名字（Web / 工具 / CLI 都行）；
3. **升级**：`dsh plugin add <主包>@<新版本>` + **重启**（无 `update_bundle`，I8）；
   或 `dsh plugin --profile <p> remove <主包>` 后重装；
4. **禁止**：把子包名单独写进 profile 的 `dependencies`（会产生两个副本/双实例，I7）；
5. **发布检查表**：① 各子包 `peerDependencies` 与主包**逐字对齐**（I6，否则整次安装被拒）；
   ② 三份生成物已重算；③ `npm run verify:all` 全绿；④ 本地真机走一遍"装 → 开 → 关一行 → 重启 → 卸载"。

---

## 12. 风险登记册

| # | 风险 | 缓解 |
|---|---|---|
| 1 | **行级失败静默**（子包没落地 ⇒ 那一行悄悄消失） | §7.6 的启动自检 |
| 2 | **浏览器半边静默不存在**（行不在任何 bundle patch 里） | §7.6 的在场判据 |
| 3 | **共享内核各一份**（写队列 / 租约 / 媒体源） | §5.1 三选一，先走 ② |
| 4 | **跨包耦合静默半挂**（`ctx.get` 缓存 / import / 单例） | §5.2 的禁止清单 + 纯度判据 |
| 5 | **守卫静默失去覆盖**（扫描面按路径钉死） | §10.2 顺序纪律 + 每改一条证"牙还在" |
| 6 | **设置键被别的包抹掉**（白名单消毒） | schema 归主包；子包只消费结果 |
| 7 | **版本不一致 ⇒ 双实例** | §11 的发布纪律（精确版本 + 单一出现点） |
| 8 | **`selection` 拆分的连锁**（`quick-panel` 与设置页共用渲染器、`emit` 总线） | §6.1 先表态；试点阶段不碰 |
| 9 | **层/iframe 单例 id 撞车** | §7.4 的所有权唯一化 |
| 10 | 上游 #195 / #196 撞车 | 见 §附录 B |
| 11 | 模块顶层副作用不随停用消失（U3） | 纪律：包内不得在模块级起定时器/挂 window |
| 12 | 停用被依赖的行 ⇒ 管理器报 failed 且不回滚 YAML（U5） | 用户文档讲清；或避免让共享能力走硬 `inject` |

---

## 13. 待决策清单（开工前必须表态）

| # | 决策 | 现状 |
|---|---|---|
| D-1 | 目标形态 | **多包**（主包 + 子包，版本一致）；需修订 ADR-0012 D8 |
| D-2 | 行标识兼容 | **保留老行 id 与 name**（零迁移，§3） |
| D-3 | "一次安装"语义 | **A：主包 patch 引用子包**（三通道可用，§2.3） |
| D-4 | 共享内核怎么给子包 | ② 叶子 import（先）→ ① Service（升级路径），§5.1 |
| D-5 | 第三方代码 | **留主包**（§9.4） |
| D-6 | 配置项 = 代码归属还是状态归属 | **待表态**（§6.1） |
| D-7 | 设置簇要不要按插件重画 | **待表态**（§6.3） |
| D-8 | 跨包服务面形状 | **待表态**（§6.2） |
| D-9 | 预设怎么跨包 | **待表态**（§6.4） |
| D-10 | 目录布局（`packages/` vs 其它） | **待表态**（§8.1） |
| D-11 | 从哪个子包开始 | **建议三个小包试点**（§7.1） |

---

## 附录 A —— 现行形态的资产清单（拆包时要逐项归属）

- **宿主半边**：`lib/index.js`（门面）、`lib/kernel/*`（内核 / 会话 / 组件视图）、`lib/routes/*`（16 族）、
  `lib/media/*`（6 个内核媒体文件）、`lib/*.js`（serve / inventory / faststart / upload-store / cache-dir /
  shim-seed / diag-trace / http-lifecycle / we-discovery / we-assets / json-response …）、
  `lib/components/*`（3 个组件行）、`lib/webwallgl/**`（vendored）。
- **浏览器半边**：`src/**`（41 个内联模块 + 正文 `src/client.js`）→ 单产物 `lib/client.js`。
- **资产**：`lib/about/**`、`lib/fontsets/**`、`lib/glass-presets/**`、`lib/webwallgl/**`、`lib/types/**`；
  仓库根 `assets/**`（不进包）。
- **发布面**：`files`（51 条）、`exports`（主入口三连 + 3 个组件三连 + patch + package.json）、
  5 条 `peerDependencies`（`@deepseek-ai/*` 三条 + `cordis` + `react`）。

## 附录 B —— 上游撞车面（复算：`git merge-tree --write-tree --name-only HEAD <PR>`）

| PR | 触面 | 与本手册的关系 |
|---|---|---|
| #195 | `lib/index.js` / `lib/routes/scene-serve.js` / `package.json` / `lib/client.js` / `src/client.js` / `lib/webwallgl/**`(曝光打点) / 新增 `lib/occlusion/**` | 多包化会**大幅改造** `package.json` 与构建脚本 ⇒ 与它正面相撞 |
| #196 | `lib/index.js` / `lib/routes/scene-serve.js` / `package.json` / `lib/client.js` / `src/client.js` / **删 `lib/webwallgl/**`** / 生成物 / 多条守卫 | 若采纳"引擎随壁纸子包"，与它**重复删改** |

**纪律**：① 不碰 PR 独占面；② 生成物一律重算；③ `package.json` 只做并集（多包化会重排 `files`/`exports`，
与"不重排"冲突 ⇒ **多包化必须在两个 PR 落地合入之后再开**）；④ 每阶段复核冲突面是否变大。

## 附录 C —— 验收命令

```powershell
npm run build                      # 重建产物（多包后：多个产物）
npm run verify:all                 # 硬档 + 软档 + smoke；必须 exit 0
npm run verify:docs                # 文档侧五档（ADR 索引 / 生成物对账）
node test/verify-component-visibility.mjs    # D3 的可见面双向对账
node test/tools/host-route-index.mjs         # 路由与行清单（现算）
node test/tools/guard-targets.mjs --write    # 生成物重算（禁手改）
git status --porcelain             # 期望：只剩本阶段预期改动
```

## 附录 D —— 本手册的机制取证（复算入口）

- **asar 读取**：头 16 字节；`headerSize = uint32LE@12`；`base = 16 + headerSize`；按 JSON 的 `offset/size` 直读。
  条目总数 12967；`@deepseek-ai/*` 包 289 个（有 `dsh.client` 的 71 个）。
- **关键包**：`@deepseek-ai/dsh-app-boot`（profile / bundle / patch / 兼容性）、
  `@deepseek-ai/dsh-plugin-manager`（安装 / 开关 / `reconcile`）、
  `@deepseek-ai/dsh-client-modules`（客户端 graph / 物化 / prune）、
  `@deepseek-ai/dsh-client-hmr`（重建 / 级联）、`@deepseek-ai/cordis`（fiber / reflect 级联）。
- **本机真机事实**：`$DSH_HOME/profiles/<name>/{package.json,cordis.patch.yml,pnpm-workspace.yaml,node_modules}``；
  `dsh.profile.patchReload`（本机 `"live"`）；本插件的 4 行开关覆盖项已在 profile patch 里（证明行开关有效）。

## 附录 E —— 历史进度与度量口径（**旧 `BUNDLE-SPLIT.md` 的账本部分，原样保留**）

> 下面是本文件替换前那一版的**进度与度量**，仍有效：度量 M1–M10 的定义、复算命令、以及
> P0–P2-11 各阶段已完成的事实。**新的阶段计划在 §7**，两者编号体系不同（旧 P*, 新 P-A…P-E）。

**度量（成功判据，复算命令见旧文 §3 与本节末）**：M1 门面体量 · M2 门面非装配占比 · M3 浏览器半边体量 ·
M4 跨组件共享读改写路径的设置键数（目标 0）· M5 守卫硬编码路径/清单条数（**加一个组件行不改工具**）·
M6 一族的文件归属唯一性 · M7 新人定位成本 · **M8 边界可声明率（P2-7 后 100%）** ·
**M9 跨模块隐式共享面（P2-7 后 0）** · **M10 实现归属唯一性（P2-8 后 0）**。
**口径**：不改善 M1–M10 任何一项的工作一律不做（唯一例外 = ADR-0012 D3）；**可开关本身不加分**。

**已完成（旧编号 → 事实）**：
- **P0 库化**：门面纯搬移出 `lib/{routes,inventory,serve,faststart,...}`；门面 469 行、`apply()` 207 行。
- **P1 内核化 + 设置分区**：`lib/kernel/*`（host-kernel / host-session / component-session / config / data-dir）；
  设置引入 7 个组件簇 + `/settings/<ns>`（按段合并、单写者）。
- **P2-0…P2-6b 组件化**：`lib/components/{about-notice,mascot-avatar,media-bridge}` + 4 行 patch；
  拆环（`lib/host-boot.js`）、fiber teardown（`handOffTeardown`）、装载探针（`/diag-log` 的 `components`）。
- **P2-7 契约收紧（M8=100% / M9=0）**：路由族 `export const DEPS` + 组件视图面 `COMPONENT_VIEW_KEYS`；
  判据 `verify-inject-contracts.mjs` / `verify-component-face.mjs`。
- **P2-8 实现入包（M10=0）**：四个私有路由搬进组件目录；判据 `verify-route-ownership.mjs`。
- **P2-9 组件行清单数据驱动**：`host-route-index.mjs` 从 `package.json.main` + patch 行名 + 磁盘交叉派生（M5 两半达成）。
- **P2-10 媒体桥入包**：`lib/media/` 恰剩 6 个内核媒体文件（M6 成立）。
- **P2-11 行级开关的界面语义（D3 落地）**：`/inventory.components` 三态状态面（键集 = 代码内建面）、
  可见面声明单一真源 `lib/components/visibility.js`、gate 唯一实现 `weComponentVisible`、
  判据 `test/verify-component-visibility.mjs`（双向对账 + 失效口径真跑 + 负对照）。
- **ADR 合并**：`ADR-0012` 为唯一正本；旧 0013–0016 与旧版 0012 归档在 `docs/archive/adr/`。

**旧文的其余章节**（§2 的 J1–J7 入选判据、§4 宿主机制基线、§5 仓库侧硬约束、§6 三方案对比、
§7 候选清单、§9 守卫改造清单、§10 风险与撞车台账）在本手册中分别由
**§2/§4/§6/§9/§7/§10/§12 与附录 B** 承接 —— 需要旧表述时查 git 历史里的同名文件。

## 附录 F —— 追版本（catch-up）日志与丢包裁决表

> 本分支（下下版本开端）追到上游下版本（`origin/main`）的执行记录。起点：落后 123 / 领先 42，合并基 `0e7c806`。
> 纪律：每轮以 `verify:all` 全绿 + 本地提交收口；**严禁 push**。

### F.1 轮次结果

| 轮 | 提交 | 做了什么 | 状态 |
|---|---|---|---|
| 1 | `c43a936` | `git merge origin/main`：32 个冲突逐条裁决（上游治理 / CI / 配置 / **产物出库**全采纳；本地语义层保留；生成物重算） | **behind 0**；`npm run build` exit 0 |
| 1b | `ee4de37` | 新增叶子模块 `lib/fs-paths.js`（`extOf` / `normalizeUserDir` / `moveFileP` —— 上游放在门面**私有**位置，抽出来避免 `内核→门面` 环边）；`src/panel-tabs.js` 取上游版（上游已拆成 `panel-tabs-*.js`，本地单文件版撞名 ⇒ 构建硬失败） | 构建 exit 0 |
| 1c | `7bd0597` | 命名空间贴回上游 `settings-schema.js`（新键 `extraGlassSelectors` 归 `appearance`）；`verify-settings-namespaces` 的 7 处**硬编码计数**改成从 schema 现算；`verify-client` 三处变异锚点按上游重构后的源码形态重锚 | `verify-settings-namespaces` **exit 0** |
| 2 | 本轮 | `verify-client` 全绿（变异③ 与窗口边界自洽 ⇒ 改为"自旋即被拦下"的记账形态）；守卫链 `[2/57] → [6/57]` | 链到 `[6/57] verify-scene` |

### F.2 丢包裁决表

上游这轮把巨石拆成**域模块**，其中若干与本分支 P0 库化的产物**同责**。
口径：**上游更细且带新守卫者取上游**（判据是"谁有机械覆盖"）。

| 本分支模块 | 上游对应 | 裁决 |
|---|---|---|
| `lib/upload-store.js`（本分支在此搬出 `moveFileP` / `normalizeUserDir`） | 上游同名文件**只有** `createUploadStoreKit`；上传常量与文件解析搬到 `lib/asset-paths.js` | **取上游**（`moveFileP`/`normalizeUserDir` 已迁 `lib/fs-paths.js`） |
| `lib/we-discovery.js` | `lib/wallpaper-scan.js` + `lib/steam-discovery.js` | **取上游**（待接线；上游有 `verify-wallpaper-scan` / `verify-steam-discovery`） |
| `lib/media/transcode.js` | `lib/transcode.js` | **取上游**（待接线） |
| `lib/media/mp4-probe.js` | `lib/media-probe.js` | **取上游**（待接线） |
| `lib/media/scene-probe.js` | `lib/scene-probe.js` | **取上游**（待接线） |
| `lib/media/video-preview.js` | `lib/video-preview.js` | **取上游**（待接线） |
| `lib/diag-trace.js` | `lib/host-diag.js` | 待逐函数比对 |
| `lib/cache-dir.js` | `lib/cache-prune.js` | 待逐函数比对 |
| — | `lib/config-store.js` / `lib/asset-paths.js` | **新增接线** |

### F.3 轮 2 定位到的缺口（下一轮从这里接）

**缺口 1（解释 `verify-scene` 成片 404）**：门面从 `hostKernel` 解构 **65 个键**，其中 3 个取不到值：

```
resolveUploadFile · setUploadDir · UPLOAD_MAX_BYTES
```

成因：上游把「上传目录常量 + 上传文件解析」从 `upload-store.js` 搬到 **`lib/asset-paths.js`**（`createAssetPathsKit`），
而本分支的 `lib/kernel/host-kernel.js` 与 `lib/routes/upload.js` 仍从 `upload-store.js` 的 kit 里解构这三个名字。
⇒ **修法**：接线 `lib/asset-paths.js`；或按上游实现把这三个名字补进叶子模块（与 `fs-paths.js` 同款做法）。

**缺口 2**：`verify-scene` 其余红点（`inventory` 缺 fixture 场景 / 头像系列 404 / `GPU_FRAME_MAX_BYTES = 0`）
—— 逐条判"接线缺"还是"判据锚点漂"（**不许放宽判据**）。

**缺口 3（产物出库连带面）**：8 条读 `lib/client.js` 的守卫需"先 `npm run build`"；当前由链首
`verify-client-sync` 现场重建满足，逐条复核后决定是否显式前置。

### F.4 轮 3 结果（缺口 1 已修）

| 项 | 结果 |
|---|---|
| 轮 3 提交 | `5c372db` |
| 缺口 1 | **已修**：新增叶子模块 `lib/upload-dir.js`（`createUploadDirKit` 工厂 + `UPLOAD_MAX_BYTES` + `UPLOAD_FILE_RE`），内核在模块加载期建一次 ⇒ 那 3 个键全部有值；内核仍 **95 键**（`verify-component-face` 的冻结契约不变） |
| `verify-scene` 帧上限判据 | 改按**真源**解析（常量已随 P0 库化搬到 `lib/media/frame-store.js`；判据原先绑死 `lib/index.js` ⇒ 搬家后静默退化成 0） |
| 守卫链 | 仍在 `[6/57] verify-scene` |

**轮 4 的裁决点（新增，必须表态）**：`verify-scene` 的 `/avatar` 系列 404 与 inventory fixture 的根因是
**路由族归属**：`/avatar` 与 `/mascot` 在本分支归**组件行** `mascot-avatar`（P2-2 的成果，由 `verify-route-ownership` 的 M10 钉住），
而上游那条判据按"**门面 `apply()` 之后 `/avatar` 就可用**"写（它那边是单包单行）。两种处置：

- **(a) 判据连组件一起 boot**（`applyComponent(..., 'mascot-avatar')` 之后再断言）—— 保住组件边界，但要改上游判据的 boot 段；
- **(b) 门面补注册这两族** —— 判据不用改，但**破坏 M10**（实现归属唯一性）与组件行语义。

### F.5 轮 4 结果（按 (a) 落地）

| 项 | 结果 |
|---|---|
| 轮 4 提交 | `b3e210e` |
| `/avatar` 系列 404（7 条） | **已绿**：夹具连组件一起 boot（`applyComponent(mockCtx, {}, 'mascot-avatar')`），判据判什么未改 |
| 帧上限判据 | 已按真源解析（常量住 `lib/media/frame-store.js`） |
| 扫描面分层 | `readHostHalf`（锚点面，含 `lib/kernel/**` 与 `lib/media/**`）与 `readKeyDerivationSurface`（计数面）分开 —— 混成一份会把派生点计数带偏（实测 3→4） |
| `verify-scene` | **8 红 → 3 红**（69 passed / 3 failed） |

**剩余 3 红（需语义裁决，不是锚点漂）**：

1. `inventory exposes the fixture scene frameUrl` —— fixture 场景没进 inventory；
2. **`P1-6 每种缓存各只有一个键派生点`**：本分支实测 `base64url` 派生点**全仓 8 处**（门面 + routes + kernel + media 面 4 处），
   上游口径是 **3**（帧 / 场景音频 / 场景视频）。两种可能：本分支的媒体探测族存在**重复派生**（真回归），
   或该口径要按"每种缓存一个"重述 —— **必须逐点核对后裁决，不许直接改数**；
3. `G 去重账本只以引用进 c`（声明位置/生命周期断言）。

**顺带确认的"丢包"信号**：上游 `lib/routes/scene-frame.js` 的依赖面是
`GPU_FRAME_AREA_TOL` / `GPU_FRAME_MAX_BYTES` / `GPU_WRITE_INFLIGHT`（带**面积升级守卫**），
而本分支该族用 `sceneFrameSlot` / `gpuFrameFileFor`（无 `GPU_FRAME_AREA_TOL`）⇒ 这一族是
**上游更细且带新语义**的样本，按附录 F.2 口径应在轮 5 取上游（需连带接线 `lib/media/frame-store.js` 的新接口）。

⇒ **建议 (a)**：与 ADR-0012 D14（实现入包、主包不留注册点）一致；改的是"夹具怎么 boot"，不是"判据判什么"。

### F.6 轮 5–6 结果

| 轮 | 提交 | 结果 |
|---|---|---|
| 5 | `71c9424` | `verify-scene` **3 红 → 1 红**（71 passed）。删掉**未被引用**的重复模块 `lib/scene-probe.js`（上游版副本；本分支用 `lib/media/scene-probe.js`）⇒ `P1-6 每种缓存一个键派生点` 自动转绿（**真重复实现**，不是口径问题）；`G 去重账本` 改按声明处判定（`SCENE_VIDEO_INFLIGHT` 随 P0 库化搬进 `lib/kernel/host-session.js`） |
| 6 | 无代码提交 | 用**临时插桩**（已还原，工作树零残留）把最后 1 红的三层逐点量清 |

**轮 6 的实测trace（三层各自的结果）**：

```
[TRACE] steamRootsFromEnv raw="…\.test-cache\scene-fixture\steamlib"     ← ① env 读到了
[TRACE] probeDirs env=[fixture]  all=[fixture, C:\Program Files (x86)\Steam, …]  ← ② 候选中含 fixture
[TRACE] owningLibraries=[fixture, E:\SteamLibrary]                        ← ③ fixture 库**已被认定归属**
[TRACE] scanRoots installDir=E:\SteamLibrary\steamapps\common\wallpaper_engine   ← ④ installDir 是本机真实安装
```

**结论（把范围钉死在枚举层）**：`scanRootsP(installDir, libraryDirs)` 的实现里
`for (const lib of libraryDirs)` **确实会把** `fixture/steamapps/workshop/content/431960` 推成扫描根，
而 `owningLibrariesP()` 也把 fixture 库算进 `libraryDirs` ⇒ **根是对的、库是对的**
⇒ 剩下的可能只在**枚举/解析层**（`enumerateWallpapersAsync` 对该根的条目筛选），
或 `pathExistsP` 对该根的判定（跨 `DSH_WE_STEAM_ROOT` 的 wslPath 归一）。

**轮 7 的下一步（直接从这里接）**：在 `enumerateWallpapersAsync` 的根循环里按根打点（哪些根进了循环、
每个根产出几条、被哪个条件刷掉），再决定是修筛选条件还是修路径归一；
若两轮内仍不能定位，则**按附录 F.2 采纳上游两族拆分**（`steam-discovery` +
`wallpaper-scan`）—— 上游那套在同一层算清 installDir 与 owningLibraries，不存在本条的分叉。


### F.7 轮 7 结果：结论反转（发现族无罪）

用**最小复现脚本**照 verify-scene 的 fixture 建合成库、直接调发现族（`.test-cache/probe-discovery.cjs`）：

```
env root        : …\.test-cache\probe-fixture\steamlib
installDir      : E:\SteamLibrary\steamapps\common\wallpaper_engine
owningLibraries : [probe-fixture, E:\SteamLibrary]
fixture 在 libs : true
枚举条目数      : 48
含 990002       : true          ← **发现族完全正常**
project.json 可读: Probe Scene
```

⇒ **发现族（root 推导 / 库归属 / 根枚举 / `readProjectP`）无罪**。
"零命中"只能出在**清单装配层**（`lib/inventory.js` 的 `createInventoryBuilder` → 条目筛选与
`hasFrame`/`frameUrl` 生成），或出在 fixture 与探针的差异上（测试用 `buildPkg` 造**真 pkg**，
探针用的是 4 字节假 pkg）。

**轮 8 的唯一待办（照此顺序，别再回到发现族）**：

1. 用**测试同款 fixture**（真 `buildPkg`）跑最小复现，确认装配层是否丢条目；
2. 在装配的条目筛选与 `hasFrame` 分支各打一条 trace，看 990002 被哪一条刷掉；
3. 判据口径不变（**不许放宽**）：要么修装配筛选，要么修 pkg 探测 —— 两者都不是判据问题。

> 方法论备注（值得复用）：本轮先用真值 trace 排除了"实现同源的三层"，再用最小复现把嫌疑面
> 从"发现族整体"压到"装配层"。两次都没有改判据 —— 这正是"先定位、再动手"的收益。

### F.9 轮 18–20：GL 引擎依赖 + shim 注入归属

**轮 18（依赖）**：`verify-scene-live` 的红点里有一类是"依赖未安装"。上游树里也**没有** `lib/webwallgl/engine/`
⇒ 引擎产物是**依赖安装后的构建产物**（判据自己的提示即 `CI: npm install before verify`）。处置：`npm install`。

> ⚠️ 沙箱细节：直接 `npm install` 失败（exit −4048），因为 npm 默认缓存 `C:\Users\…\npm-cache\_logs` 在
> **工作区之外**。改用 `npm install --cache .npm-cache` 成功 —— 这是把写入**收进允许范围**的合法做法。
> `.npm-cache` 与 `node_modules` 均已被 .gitignore 覆盖（`git check-ignore` 命中），`package-lock.json` 无变化。

**轮 19–20（shim 注入归属）**：`/wallpaper-engine/scene-files` 的 HTML 入口被判据要求带四段注入：

```
data-we-site-root="host"  → window.__weSiteRoot（**必须早于 shim**：shim 首次解析 URL 前要读到）
data-we-shim="host"       → __weShimInstalled / __weSetPaused（正文从 webwallgl 包的 shimSource 提取）
data-we-focus-guard="host"→ __weFocusGuard（**必须早于 seed**，晚于作者脚本等于没装）
data-we-seed="host"       → __weSeedProps / color0（严格沙箱下渲染页读不到 iframe，属性只能随 HTML 注入）
```

现状核对（两侧都查过）：

| 位置 | 状态 |
|---|---|
| `lib/routes/scene-serve.js`（**门面**注册的 `/scene-files`） | **无注入**（`data-we-shim` 等命中 = 0） |
| 上游 `lib/routes/scene-serve.js` | **也无注入**（命中 = 0） |
| `lib/serve.js` 的 `createServeKit` HTML 分支（460–491 行） | **有完整注入**（site-root → shim → focus-guard → seed，顺序正确） |

⇒ 结论：注入能力在本分支被收进 **serve 套件**（组件会话消费），而门面那条路由不再注入 ——
与第 4 轮 `/avatar` **同族**（上游按"单包单行、门面即宿主"写判据，本分支把能力搬进了会话/组件）。

**裁决（轮 20，倾向 (b)）**：把 `lib/serve.js` 460–491 那段注入**抽成一个导出的共享函数**
（入参：`html` / `token` / `readWebShim` / `buildSeedScript` / `BASE`），
让 **kit 的 HTML 分支**与**门面的 `scene-serve.js` HTML 分支**共用同一份实现。理由：

1. 判据同组的另两条（`engine/*` 的 revalidate 缓存、`engine/` 下编码 `../` ⇒ **403**）明显是
   **宿主级文件服务**语义，而 `/scene-files` 本身就是宿主路由 —— 三者同源，放一处更内聚；
2. 抽成共享函数符合本分支"**同一不变量只有一处构造点**"的既有纪律（否则两处注入会漂）。

**轮 21 执行清单**：

1. `lib/serve.js`：抽 `injectEntryHtml(...)` 并让原分支调用它（纯重构，行为不变 ⇒ 现有判据应保持全绿）；
2. `lib/routes/scene-serve.js`：HTML 分支调用同一函数；`DEPS` 补 `readWebShim` / `buildSeedScript`，
   门面调用点同步补两个实参（`verify-inject-contracts` 三方对账）；
3. 同文件：引擎文件 `Cache-Control` 改 **revalidate**（文件名不带哈希但内容随 `webwallgl` 升级变）；
   `engine/` 下编码型 `../` 逃逸回 **403**（当前 404 ⇒ 围栏判定在"找不到"之后）；
4. 复跑 `node test/verify-scene-live.mjs`，再推链 `[9/57]` 起。

### F.10 轮 21–27：注入/引擎/契约三条线收口 + 新域模块依赖盘点

**已收口（提交序列）**

| 轮 | 提交 | 结果 |
|---|---|---|
| 21 | `6b66a41` | 入口 HTML 四段注入抽成导出函数 `injectEntryHtml`（纯重构，`verify-scene` 保持 132/0 ⇒ 行为不变） |
| 23 | `d7af89b` | `readWebShim` 改为从 **webwallgl 包 bundle** 提取（npm 包不发 `web-shim.js`）；补全 **`WEBWALLGL_PKG_DIR`** 整链（该键全仓从未定义）⇒ 四条注入判据转绿 |
| 24 | `fa639d4` | `registerSceneServeRoutes` **调用点**补 `WEBWALLGL_PKG_DIR` ⇒ 引擎 404/no-store 与逃逸 403 两条转绿 |
| 25 | `fa17b30` | scene-serve 的 **DEPS** 补该键 ⇒ `verify-inject-contracts` 93% → 98% |
| 26 | `eca482c` | **接线 occlusion 族**（本仓早有 `lib/occlusion/**`，只差挂载）⇒ M8 = **100%**（22/22 族、22/22 调用点） |
| 27 | 无代码提交 | `now-playing` 试接后**回退**（见下） |

**三条反复出现的"静默退化"形态（本轮追版本的主要敌人）**

1. **键在"DEPS 声明 ↔ 门面解构 ↔ 调用点实参"三者之一漏掉** ⇒ 路由拿到 `undefined` ⇒ 要么走错分支（`!WEBWALLGL_PKG_DIR` ⇒ 404），要么参与算术得 **NaN**（`1 - GPU_FRAME_AREA_TOL` ⇒ 守卫恒 false）。出现 **3 次**。
2. **解构遮蔽模块级常量**：同名键在"kit 不提供它"的解构列表里 ⇒ 外层 const 被盖成 `undefined`。出现 **2 次**（`GPU_FRAME_AREA_TOL`、`WEBWALLGL_PKG_DIR`）。
3. **取源方式过时 + 静默 catch**：`readWebShim` 读一个 npm 包根本不发的文件 ⇒ 每次静默返回 `''` ⇒ 整条注入通道消失。同类还有判据侧 `|| 'sf'` 的默认值回落。

> **纪律**：改"键集"（DEPS / 解构 / 调用点）后，**必须单跑 `node test/verify-inject-contracts.mjs`** —— 守卫链会在前面短路，等链跑到它等于没跑。
> **纪律**：模块级常量**不要**出现在"同名键可能不存在"的解构列表里（解构取不到即得 `undefined` 并遮蔽外层，不报错）。

**轮 27 的接口盘点（新域模块接线的前置依赖）**

| 待接线 | 上游实现位置 | 依赖（本仓状态） |
|---|---|---|
| `now-playing` | `lib/routes/now-playing.js`（172 行） | ⚠️ import `../media/index.js` 的 **`createMediaBackend`** —— 本仓**没有** `lib/media/index.js` 这个 barrel（只有 `frame-store/media-dirs/mp4-probe/scene-probe/transcode/video-preview`）⇒ **需先移植上游媒体子系统**，不可单点硬接（已试，套件因 `ERR_MODULE_NOT_FOUND` 整个崩溃，故回退） |
| `/media-control` | 上游 `lib/media/legacy.js` | 同属媒体子系统 |
| `scene-files` 双挂载 | `handleSceneFiles` ×2（应用源 + 媒体源） | 处理器已有，只差第二处挂载 |
| 视频字节布局（服务期合成） | 媒体子系统 | 同属媒体子系统 |

⇒ **结论**：第 8 步剩余的 4 条红**全部汇聚到"上游媒体子系统（`lib/media/**` + `createMediaBackend`）尚未移植"**这一个根因上。它不是单点接线，而是一次**成族移植**（对应手册 F.2 里 `lib/media/*` 与上游 `lib/media-probe.js` / `transcode.js` 的丢包裁决）。轮 28 起按"成族移植"规划，而不是逐个洞补。

### F.11 追版本方法论（轮 8–60 总结）与剩余工作清单

#### 一、这条链真正的敌人：**五类"静默退化"**

| # | 形态 | 代表案例 | 为什么难查 |
|---|---|---|---|
| 1 | **键集三处之一漏传**（DEPS 声明 / 门面解构 / 调用点实参） | `GPU_FRAME_AREA_TOL`（`1 - undefined` = **NaN** ⇒ 面积守卫恒不生效）、`WEBWALLGL_PKG_DIR` | 不抛错、不判红；守卫"在位"却不再工作 |
| 2 | **解构遮蔽模块级常量** | `GPU_FRAME_AREA_TOL`、`WEBWALLGL_PKG_DIR`（各踩一次） | 解构取不到即 `undefined` 并**遮蔽**外层同名绑定，不报错 |
| 3 | **取源/解析写死上游坐标** | 判据读 `lib/index.js` 抠 `const BASE`、`LIVE_FRAME_KEY_VERSION`、`traceMediaRequests`、`scene-manifest.js`、`http-body.js` 的 specifier 深度…… | 实现搬家后判据**静默失配**：要么假红，要么拿默认值**假绿**（`|| 'sf'` 最典型） |
| 4 | **辅助逻辑写死坐标**（不只读取面） | 判据把 `'./scene-manifest.js'` 改写成绝对 URL 的**补丁步骤**落空 | 症状伪装成"缺夹具" |
| 5 | **失败静默 / 永不 settle** | 路由对失败回**空体 200**；`promisify(fs.promises.rename)` ⇒ promise **永不 settle** ⇒ 迁移挂死 | 前者让客户端以为成功，后者让请求永不回包 |

> 判据侧的对照纪律：**不许有默认值回落**（缺锚即红）。本轮把 `|| 'sf'` 改成"解析不到就判红"，
> 并给多处判据加了"非空转自检"（例如 verify-contracts 的"宿主代码里确实用到了有版本要求的 API
> — 推导出的下限 = 0"）。判据自己会喊"我现在什么都没在看"，这是最有效的防护。

#### 二、**判据即接口契约**（本轮反复验证的一条）

判据不只断言行为，它同时是"这个模块对外承诺什么"的**书面形式**：

- `avatar-layer.js` 的**导出面被钉死为四项** ⇒ 我新增一个导出就红；
- 模块输入一律走 **`globalThis`**（`selection` / `apiUrl` 同款）⇒ 注入也必须走全局，且**缺省方向取 true**
  （"未知 ⇒ 按可用渲染"：注入缺失只可能是接线疏漏，那种情况下把整个面板藏掉是更坏的失败）；
- 页签函数的**首行必须从 `ctx` 解构**、接线语句的**换行位置**都被正则钉住 ⇒ 形态也是契约。

⇒ 我在轮 41 按自己的偏好定接口（加导出 + 裸引用拼接作用域），红；轮 42 **先读契约再定接口**，全绿。

#### 三、"搬家"是一类**多面操作**（删/移一个实现要连带检查四处）

| 处 | 案例 |
|---|---|
| 判据的 import / 读取面 | `lib/scene-probe.js`、`const BASE` |
| `package.json.files` | `lib/scene-probe.js` 残留（npm 会静默少发） |
| 代码/文档里的**相对路径深度** | 组件行文件的 `../log.js` 应为 `../../log.js` |
| 封装面登记表（`DEV_ONLY` 等） | `verify:bridge:strict` |

#### 四、基础设施（本轮新增，供后续复用）

- `test/tools/child-out.mjs`：**拿子进程输出的唯一方式**。本会话沙箱禁子进程管道 ⇒ 默认 `pipe` 抛
  `EPERM`（踩过三次：`readChain` / occlusion 语法检查 / package-files 的 runner 探测）。
  `runNodeCaptured`（stdout 落文件再读回）与 `runNodeStatus`（只要退出码，不产生管道）。
- `COMPONENT_GATE_ALIASES`（`lib/components/visibility.js`）：登记"可单独 import 的模块通过注入拿同一 gate"
  的别名；**词汇扩展必须连"验证该词汇的负对照"一起扩展**（否则负对照自己变假红）。
- `mediaSrcPath` / `readAnyOf`：判据侧的"真源解析"雏形（组件行优先、`lib/media` 兜底、缺失不 ENOENT）。

#### 五、★本轮唯一的**用户可见真 bug**（判据跑到真路径才暴露）

`lib/fs-paths.js` 的 `moveFileP`：

```js
import { copyFile, rename, unlink } from 'node:fs/promises';   // 已是 Promise API
const renameP = promisify(rename);   // ❌ promisify 是回调式适配器：调 rename(src,dst,cb)，
                                     //    promises 版忽略第三参 ⇒ cb 永不触发 ⇒ promise 永不 settle
```

⇒ **缓存根 `setCacheDir` 与上传目录 `setUploadDir` 共用这条迁移链** ⇒ 用户改缓存/上传目录时
**插件挂住不回包**。潜伏至今的原因：此前判据里的迁移场景**从未真的搬过文件**（都是 `same` 或空目录）。

#### 六、剩余工作清单（交接）

1. **守卫链位置**：`[34/58] verify-cache-dir`。该判据已修 5 项（迁移挂死、三处读点、容错解析），
   余 **D1/D3** 两条（媒体三处缓存根写法 + 中间件跟缓存根走）与一处 **ENOENT**：
   `lib/routes/now-playing.js` ⇒ 应映射到 `lib/components/media-bridge/now-playing.js`（`readAnyOf` 同款）。
2. **链的其余 24 步**（`[35/58]`–`[58/58]`）全部**未跑**：docs 组与 smoke 组。
   按本轮方法逐步骤处理：先读检查式 → 判"归属（改读取面/口径/生成物）vs 真缺（补实现）"。
3. **仍未全绿的判据面**：无（本轮结束时的已知红点集中在上面第 1 条）。
4. **上游新域模块**：`lib/media/**`（`createMediaBackend` 等约 1585 行）尚未移植 —— 但注意
   轮 28 的发现：**本分支的 `lib/components/media-bridge/` 已完整实现这些路由与后端**，
   因此"要不要移植"取决于**要不要与上游媒体子系统同构**，而不是"缺功能"。
5. **待办工具（治本）**：`test/tools/source-locator.mjs` —— 按符号名在全仓定位**唯一真源**，
   让判据写"我要 `BASE`"而不是写路径。本轮共 12+ 次手工修读取面，若该工具在场可省大半。
6. **纪律落地**：把上面五类静默退化与"判据即契约"补进 `docs/TRIAGE.md` 或贡献指南（目前只在 wip 手册）。

### F.12 第二期：智能体团队分工与验收标准（Lead 记录）

第一期（轮 1–60）把基底追平（`behind origin/main = 0`）并把守卫链从 `[2/58]` 推到 `[34/58]`。
第二期引入团队并行处理三条线，**写作用域按文件级互斥**，避免同文件并发写。

| 线 | 任务 | 写作用域（互斥） | 验收标准 |
|---|---|---|---|
| **追链（关键路径）** | `task-6` chain-runner | `test/verify-cache-dir.mjs`、`test/verify-scene-live*.mjs`、`test/verify-package-*.mjs`、`test/tools/child-out.mjs`、`test/tools/host-route-index.mjs`、`lib/routes/**`、`lib/kernel/**`、`lib/fs-paths.js`、`lib/cache-dir.js` | 每步：该判据 exit 0 + `node test/run-guards.mjs verify` 位置前移；链路不得回退 |
| **文档/注释同步** | `task-7` docs-comment-sync | `docs/**`（**除本手册**）、`README.md`、`lib/index.js`、`lib/components/**`（**注释 only**） | 不再有指向已不存在文件的路径陈述；`docs/ARCHITECTURE-SPLIT.md` 记录门面重写与迁移路径；`verify-logging` / `verify-inject-contracts` 无回归 |
| **测试系统锚定** | `task-8` test-audit | `test/verify-{component-visibility,inject-contracts,settings-namespaces,guard-map,component-face,route-ownership}.mjs`、`test/tools/{source-locator,guard-targets}.mjs`、`test/fixtures/**`、`docs/wip/TEST-ANCHORING.md` | 每个测试点能说出"守哪个不变量"；写死数字裁定为契约或改现算；静默回落到"缺锚即红"；新锚点各配负对照；`verify-guard-map` 全绿 |

**共同纪律**（第一期教训的固化，三人一体适用）：
1. 判据是**接口契约的书面形式** —— 改实现前先读判据检查式；改接口形状要服从既有契约（导出面 / globalThis 输入 / 首行解构 / 换行形态都可能被钉住）。
2. 五类静默退化：键集三处漏传、解构遮蔽模块级常量、取源写死上游坐标、辅助逻辑写死坐标、失败静默与永不 settle。
3. 归属类 vs 真缺：先判"能力搬到哪去了"（本分支 `lib/components/**`、`lib/kernel/**`），只有两侧都搜不到才判"需移植上游"。
4. 生成物一律用生成器重算；沙箱下子进程输出走 `test/tools/child-out.mjs`；`lib/**` 除 log/notice 外零 `console.*`。
5. 本地提交、**严禁 push**；每笔提交写清"现象 → 根因 → 修法 → 验证证据"。

**Lead 保留范围**：本手册、`package.json`、`docs/adr/**`、最终验收（跑全链 + 关键行为判据 + 复核他人 diff）。
