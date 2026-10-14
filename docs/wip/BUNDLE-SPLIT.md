# 插件包重构手册 —— 多包拆分（主包 + 核心子插件 + 边缘子插件）

> **哈希说明（这条线被重写过两次，旧哈希多半已不在现行 `main` 上）**：本文件里的短哈希是**当时那条线上的**历史哈希。
> 现行线 = 单笔 squash `6385b62e`（父 = 上游 merge `a86923b7`），本地工作树即该提交。
> 追版本第二期那一笔（108 笔压缩，父 = `c43a936`）以 tag `catchup-2nd` 标注，但**该 tag 只被
> `backup/main-pre-rebase-20261014` 包含，不是 `main` 的祖先**；`backup/pre-squash-20261014` 亦然。
> ⇒ **复核本文件的旧哈希前先切到对应备份分支**，不要在 `main` 上找。
> 复算：`git rev-parse --short HEAD catchup-2nd` · `git branch -a --contains catchup-2nd` ·
> `git merge-base --is-ancestor catchup-2nd HEAD`（预期非 0）。


> **本文是这条重构线的唯一执行口径**：目标架构、机制约束、包边界、通讯纪律、阶段计划、判据改造、发布流程。
> **决策正本** = [`adr/0013`](../adr/0013-bundle-multi-component-rows.md)（目标与判据、开关语义、明确不做的事）；
> 本文**只写"怎么做"**，与 ADR 重复的目标陈述一律改成指针。
> **写作纪律**（[`docs/README.md`](../README.md) §写作纪律）：不抄会漂的数值；证据锚点用**符号名 / 文件路径 / 复算命令**；
> 行号必漂，一律不写。**状态**：进行中（住 `docs/wip/`，收口后按 §11 归档）。

**基线**：现行 `main` 相对 `origin/main` **behind 0**（复算：`git rev-list --left-right --count origin/main...HEAD`）；
当前形态 = **单包 + 4 个插件行**（`dsh-plugin-wallpaper-engine`，即 `cordis.patch.yml` 的四条 `insert`）。
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
2. **第三方代码除外** —— 引擎**已经是 npm 依赖**（`package.json` 的 `dependencies` 里有 `webwallgl`），
   仓库内 `lib/webwallgl/**` 只剩自家模板/宿主桥文件（复算：`git ls-files lib/webwallgl`）：
   **"不搬"= 不随子包走**，由主包持有依赖，并以 `WEBWALLGL_PKG_DIR` / `WEBWALLGL_DIR` 作注入键交给需要它的包
   （见 §9.4 的两种做法与取舍）；
3. **所有子包版本一致**（不追求独立发布）—— 这条把"发布面 ×N"的成本消掉（见 §4.1）；
4. **组件之间明确的通讯纪律**（见 §6）。

### 1.2 与现行 ADR 的关系

- 现行形态（单包多行）与 D3（关掉一行 ⇒ 路由不注册 ＋ 界面不渲染）**已经落地**，是本手册的**起点**；
- 目标形态（多包）需要**修订 [`adr/0013`](../adr/0013-bundle-multi-component-rows.md) 的 D6 / D8 / D17**
  （"终态取单包多行" / "不做多包 monorepo" / "每组件一格客户端开关"三条的**前提**）。
  **2026-10-14 用户拍板：就地改写 ADR-0013 的 D6 与 D8 正文、D17 只改理由**（不新开 ADR）。修订理由**只有一条**：
  **降复杂度与解耦**（用户口径：独立发布不必要；版本一致更方便管理）。**"关掉即不下载"仍是非目标（D16）**，
  **每组件一格客户端开关仍不做**（理由改为"子包粒度 ≠ 组件行粒度"，见 ADR-0013 D17）。

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
| **浏览器半边** `exports["./client"]` + `dsh.client` | 界面/样式/槽贡献 | **可选**（in-box 多数包没有 `dsh.client`，占比复算见附录 D）；缺了不影响宿主半边 |
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
`peerDependencies`（`dsh-plugin-manager` 的 `bundleComponent*` 一族；`dsh-app-boot` 侧另有一道读取期兼容性校验）
—— 任一不匹配 ⇒ 整次安装被拒并回滚（含 `node_modules` 修复）。

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
   **可以开关**（真机实证：profile patch 里的行开关覆盖项形如 `- id: <行 id>` + `disabled: false`；
   本机 desktop profile 里就有 `wallpaper-engine` 那一条 —— 见附录 D 的复算命令）。

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
| S6 | `PROFILE_PRESET_KEYS` 横跨**全部设置簇**；预设资产段横跨字体 / 立绘 / 头像三族 | 预设是最硬的跨包面，见 §6.4 |

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
  代价 = 主包行从"纯插件"变成 provider，`verify-component-face` 的冻结契约（内核分级面的复算口径
  `KERNEL_STABLE_FACE` —— 该判据已改成**读真源现算**，不再写死数字）必须同步重算。
- **② 子包 `import` 主包的叶子模块**：形状最简单、今天就能做；代价 = 把内核内部面公开进 `files`，
  且撞 `verify-module-layout` 的"共享内核白名单只许一项"。
- **③ 把内核下沉成独立小包**（`dsh-plugin-we-core`）：边界最干净；代价 = 多一个发布面 + 新包名要进各守卫的顶层目录地板。

> **决策（2026-10-14，用户拍板 —— 见 §13 的 D-4 与 D-8）**：**先走 ②**（零新机制、可立即验证），
> 把 ① 作为"② 撞到白名单/耦合墙时"的升级路径；**跨包贡献/服务面**先走**宿主注入显式键集**
> （§5.2 允许清单第 2 条），P-A…P-B **不新开 Service**。

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

> **决策（2026-10-14，§13 D-8）**：P-A 的三个子包先走**宿主注入显式键集**（值由主包注入、子包只读），
> 不做长命对象跨包 `require`，也不新开 Service；§5.1 ① 仍是升级路径。

---

## 6. 需要产品/架构拍板的四个问题（**2026-10-14 复核：两条已定案，两条按阶段前置**）

| 问题 | 状态 | 决策 / 期限 |
|---|---|---|
| §6.1 配置项归属（代码 / 状态） | **阶段前置** | **P-C 之前必须表态**（§7.3 已把它列为前置） |
| §6.2 客户端半边怎么协作（服务面形状） | **已定案（2026-10-14）** | P-A…P-B 走**宿主注入显式键集**（§5.2 允许清单第 2 条）、不做长命对象跨包 `require`、**不新开 Service**（升级路径 = §5.1 ①）；"provider 缺席"的期望 = 注入键缺席，按 D3③「宁可显示、不可静默消失」 |
| §6.3 设置簇要不要按插件重画 | **阶段前置** | **P-C 之前必须表态**（与 §6.1 同批） |
| §6.4 预设怎么跨包 | **阶段前置** | **P-D 之前必须表态**（与 §7.4 同批） |

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

- **重画**（`core.library` / `core.playback` / `appearance.glass` / `appearance.ui`…）：分区的命名空间表与
  `SETTINGS_NAMESPACE_NAMES` 要按新簇重排，分区对账的**口径**（键集逐键相等）随之重述，
  老客户端与老存档要语义映射；⚠️ 该判据里的键数**已经是现算**（从 `sanitizeFromSchema` 派生，
  复算：`node test/verify-settings-namespaces.mjs`）⇒ 重画要改的是**分区表与口径**，不是硬编码计数；
- **不重画**（两个包共用一个簇）：**单写者（M4=0）不变量立刻破功**。

> **二选一，没有第三条。**

### 6.4 预设（`PROFILE_PRESET_KEYS`，键集横跨全部设置簇 + 三族资产）怎么跨包？

它是唯一"路由不写设置却必须理解所有包的键"的落点（`sanitizePresetValues` / `installAssets`）。
三选一：主包聚合（子包把键注册进主包）/ 每包自带片段 + 宿主装配 / 拆成多个预设。

### 6.5 （附带）主包被关掉时子包怎么办？

U5 说运行期是**安全 park**，但插件管理器会报 `failed`。若"停用主包"要当正常操作，需给它一个明确的用户可见语义。

---

## 7. 阶段计划

> **贯穿纪律**：① 每阶段先落**判据**、再改实现（ADR-0013 D12 的教训）；
> ② 每阶段独立提交、可单独 revert；③ 每阶段末跑 §7.7 的验收；④ **不许先放宽守卫再改**。

### 7.0 起步态（已达成，作为基线）

单包 + 4 行；D3 的界面级开关语义已落地（状态面 `/inventory.components`、可见面声明 `lib/components/visibility.js`、
判据 `test/verify-component-visibility.mjs`）；守卫链 `node test/run-guards.mjs all` **全绿**
（步数与地板以 `test/run-guards.mjs` 与 `test/verify-package-files.mjs` 的 `CHAIN_FLOOR` 为准，本文不抄数）。
**度量口径见本文件末的附录 E；历史进度与追版本日志见 `CHANGELOG.md` 与 git 历史。**

### 7.1 P-A 试点：三个小子包（**建议从这里开始**）

**目标**：把"多包 + 一次装 + 启动自检 + 跨包服务"这条链走通，**不动 `selection` / 设置面板**。

| 子包 | 搬什么 | 占哪几个半边 |
|---|---|---|
| 点击与拖尾效果 | `src/fx-layer.js`、`src/ext-fx.js`（`FX_EXTENSION_MODULE`） | 宿主空壳 + 浏览器半边 + 一条行 |
| 3D 效果 | `src/parallax-layer.js`、`src/ext-parallax.js`（`PARALLAX_EXTENSION_MODULE`） | 同上 |
| 字体系统 | `src/font/**`、`src/fontset-store.js`、`src/fontset-editor.js`、`src/system-fonts.js`；宿主侧 `lib/routes/{fontsets,system-fonts}.js` | 宿主实现 + 浏览器半边 + 一条行 |

**动作**：① 建三包，落点 = **同仓 `packages/<pkg>/`**（§8.1，2026-10-14 定案）；② 主包 `dependencies` 精确依赖三者；
③ 主包 patch 里 `insert` 三行；④ 加启动自检与"行在 patch 里"的判据（§7.6）；
⑤ 把 `extensionModules()` 从**静态数组**改成"读注册表"（**首个跨包贡献点**，通道 = **宿主注入显式键集**，见 §6.2 / §13 D-8）。
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
**注意**：引擎已是 npm 依赖（§9.4 定案 = 主包持有、不随子包）；`lib/webwallgl/**` 如今只剩自家模板/桥文件。

### 7.5 P-E 收尾

文档（`CODE-STRUCTURE` / `HOW-IT-WORKS` / 三份 README / `CONTRIBUTING` / CHANGELOG 四段式）、生成物重算、本文件归档。

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

### 8.1 目录与包布局（**2026-10-14 定案：同仓 `packages/<pkg>/`**）

| 选项 | 形态 | 结论 |
|---|---|---|
| **同仓 `packages/<pkg>/`**（**采纳**） | 各自 `package.json` + `cordis.patch.yml`（若自己带行）+ `lib/` | 需要新的目录纪律；`host-route-index` / `guard-targets` / `verify-retired-lines` 的顶层目录假设都要登记（§10.1 #7/#8） |
| 同仓但不在 `packages/`（如 `sub/<pkg>/`） | 同上，换个名字 | 不采纳：私有名字只增加解释成本，换不来任何机制收益 |
| 多仓 | 每包独立仓库 | 不采纳：发布/同步成本高；**版本一致**靠人工对齐，与"方便管理"相反 |

> **注意**：`workspace:` / `bundledDependencies` / monorepo 的**安装语义不被 DSH 支持**（I3），
> 但"同仓多包 + 各自发布"在 npm 层是可行的 —— 我们要的只是**同仓开发**，不是 workspace 协议。
>
> ⚠️ **开发期解析：未验证，P-A 开工前必须做一次 spike**。本机两个 profile 都按
> `link:D:/dsh-wallpaper-engine/` 安装（复算：`$DSH_HOME/profiles/<p>/package.json` 的 `dependencies`），
> 而 **`link:` 不会把被 link 包的 `dependencies` 装进 profile** —— 实测 profile 顶层有 `js-yaml` / `undici`，
> 但**没有** `webwallgl` / `x11`（它们只在本仓自己的 `node_modules` 里）。
> 行名走 loader：**裸包名 → `internal.import(name, bareModuleBaseUrl)`**（installed-host base），
> **只有相对名（`./…`）才 "resolve beside the configuration file"**。
> ⇒ **发布路径**（用户 `pnpm add` 主包、子包作为传递依赖被 hoist 到 profile 顶层）成立；
> **开发路径**下 §8.3 那个**裸真名**能不能解析到子包，必须先 spike 证伪或改口径
> （备选：开发期行名写相对 patch 的 `./packages/<pkg>/lib/index.js` —— I4 明列支持相对名）。
> **在 spike 出结论之前，不要把 P-A 的"三行都在场"当成已成立。**

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
    # 新子包：行名 = 真实包名（**发布形态**；开发期若 profile 是 `link:` 安装，
    # 见 §8.1 的待验项 —— 可能要用相对 patch 的 `./packages/<pkg>/lib/index.js`）
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
| `lib/webwallgl/**` | **不再是 vendored 引擎**：引擎 = npm 依赖 `webwallgl`；仓库内只剩自家模板/桥文件，零 import，由 `WEBWALLGL_PKG_DIR` / `WEBWALLGL_DIR` 指向 | 见 §9.4 |
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

### 9.4 第三方代码（引擎 = npm 依赖 `webwallgl`）

**形态已变（2026-10 上游 npm 化）**：引擎不再是 vendored 副本 —— `package.json` 的 `dependencies` 里有 `webwallgl`，
仓库内 `lib/webwallgl/**` 只剩自家模板/宿主桥文件（复算：`git ls-files lib/webwallgl`；
取舍记录见 [`ARCHITECTURE-SPLIT.md`](../ARCHITECTURE-SPLIT.md) §5）。

| 做法 | 好处 | 代价 |
|---|---|---|
| **主包持有依赖、不随子包走**（**2026-10-14 定案**） | 依赖声明单点；CI 与守卫零改动；上游撞车面不变 | 装壁纸子包的人必装主包（体积不省） |
| 让壁纸子包自己声明 `dependencies: webwallgl` | 语义归属正确 | 引擎出现两个持有者 ⇒ 版本漂移与双实例风险（与 §11 纪律 7 同源） |

> **决策**：**留主包**（用户口径"第三方代码除外"已经允许；且它如今已不是"随包代码"而是**依赖**）。

---

## 10. 判据与工具改造（**按包循环这一步是主成本**）

### 10.1 单包硬假设的清单（按影响排序）

| # | 文件 / 判据 | 现假设 | 要改成 |
|---|---|---|---|
| 1 | `test/tools/host-route-index.mjs` | `PKG_MAIN` = 本包 `main`；**单份** patch；`<pkg>/<sub>` → `lib/components/<sub>/index.js` | **包清单 → 每包的 main + patch + 行**；**全部下游守卫的根，改它要最后验收** |
| 2 | `test/verify-bundle-rows.mjs` ⚠️ **不在守卫链上**（有意脱链，两条理由都在该守卫自己的注释里：① 它 import 宿主 peer 包 `@deepseek-ai/cordis`，而 CI 是 `npm ci --omit=peer`；② `verify-package-files` 的 P5 明令链上脚本不许有裸包依赖） | 仓库根**恰好一份** patch；恰好一行裸包名；其余行 `startsWith(BARE + '/')` | 按包枚举；行命名空间断言按包重写；组件的"图标与包根字节相同"对独立包不成立。**改它时 CI 不会拦 ⇒ 每阶段必须手动跑 `node test/verify-bundle-rows.mjs`** |
| 3 | `test/verify-inject-contracts.mjs` | 扫描面按磁盘枚举派生；三条哨兵地板 = 模块数 / 声明键数 / 调用点数（**具体数字以该文件为准，本文不抄**） | 扫描面按包派生；三条哨兵按新结构重算（**最容易假绿的一处**） |
| 4 | `test/verify-component-face.mjs` | 组件目录固定在 `lib/components/`；内核分级面已**读真源现算**（`KERNEL_STABLE_FACE` / `lib/kernel/*`），数字不写死 | 目录集合按包；若走 §5.1 ①（Service）则分级面复算口径同步 |
| 5 | `test/verify-route-ownership.mjs` | `lib/components/<sub>/index.js` 硬路径；地板 `>=2` | 行→入口的解析改成"读各包 `exports`/`files`" |
| 6 | `test/verify-package-files.mjs` / `verify-package-publish.mjs` | **单份** `files` / `main` / `scripts`；链步地板 = `CHAIN_FLOOR`（`verify` / `docs` / `smoke` / `all` 四组，数字以该文件为准）；入口清单写死 | 参数化成"每包跑一次"或拆两套；地板表按包组重算 |
| 7 | `test/verify-retired-lines.mjs` | 扫描面地板按**顶层目录**计数（`lib`/`src`/`test`/`scripts`） | 新顶层目录要登记 |
| 8 | `test/tools/guard-targets.mjs` | `walk(src)+walk(lib)`；`ARTIFACT='lib/client.js'` | 按包；产物 N 个 |
| 9 | `test/verify-module-layout.mjs` | 共享内核白名单**只许一项** | 若走 §5.1 出路 ② 要放宽并写理由 |
| 10 | 三份生成物（`ROUTE-INDEX` / `GUARD-MAP` / `TOKEN-CONTRACT`） | 逐字节对账、单份 | 决定"每包一份还是仓库一份" |
| 11 | `scripts/prepare.mjs`（`prepack`） | 源码与产物同包根、只有一份 | 按包循环或只挂主包 |
| 12 | 读 `package.json` 的 `test/` + `scripts/` 文件（复算：`Select-String -Path test\*.mjs,scripts\*.mjs -Pattern package\.json`） | 单包 | 同 #1（先做"包发现"层） |

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

## 13. 待决策清单（**2026-10-14 复核：开工闸门项已定案，其余标了阶段前置**）

| # | 决策 | 状态 |
|---|---|---|
| D-1 | 目标形态 | **多包**（主包 + 子包，版本一致）。**已就地改写 ADR-0013 的 D6 / D8**（§1.2） |
| D-2 | 行标识兼容 | **保留老行 id 与 name**（零迁移，§3） |
| D-3 | "一次安装"语义 | **A：主包 patch 引用子包**（三通道可用，§2.3） |
| D-4 | 共享内核怎么给子包 | ② 叶子 import（先）→ ① Service（升级路径），§5.1 |
| D-5 | 第三方代码 | **主包持有 npm 依赖 `webwallgl`、不随子包**（§9.4；形态已随上游 npm 化更新） |
| D-6 | 配置项 = 代码归属还是状态归属 | **阶段前置：P-C 之前必须表态**（§6.1 / §7.3） |
| D-7 | 设置簇要不要按插件重画 | **阶段前置：P-C 之前必须表态**（§6.3 / §7.3，与 D-6 同批） |
| D-8 | 跨包贡献 / 服务面形状 | **定案（2026-10-14）：宿主注入显式键集**（§5.2 允许清单第 2 条）；不开新 Service，升级路径 = §5.1 ① |
| D-9 | 预设怎么跨包 | **阶段前置：P-D 之前必须表态**（§6.4 / §7.4） |
| D-10 | 目录布局 | **定案（2026-10-14）：同仓 `packages/<pkg>/`**（§8.1；不用 workspace 协议） |
| D-11 | 从哪个子包开始 | **建议三个小包试点**（§7.1） |

---

## 附录 A —— 现行形态的资产清单（拆包时要逐项归属）

> **不抄条数**：每一项的规模都以**符号名 + 复算命令**给（`docs/README.md` §写作纪律 4）——
> 这份清单在 2026-10-14 复核时已有若干条漂了（路由族数 / `files` 条数 / 内联模块数），
> 故本节只留符号名与类别。

- **宿主半边**：`lib/index.js`（门面）、`lib/kernel/*`（内核 / 会话 / 组件视图）、`lib/routes/*`（路由族，
  条数以生成物 `docs/ROUTE-INDEX.md` 为准）、`lib/media/*`（内核媒体文件）、
  `lib/*.js`（serve / inventory / faststart / upload-store / upload-dir / cache-dir / fs-paths / pkg-read /
  scene-manifest / shim-seed / diag-trace / http-lifecycle / http-body / json-response / wallpaper-scan /
  steam-discovery / we-assets / we-props / we-focus-guard / media-origin / mp4-vfs / startup-sweep / host-boot /
  log / notice …）、`lib/components/*`（组件行）、`lib/webwallgl/*`（自家模板 / 宿主桥，**不是引擎**）。
- **浏览器半边**：`src/**` 的构建期内联模块（清单的**唯一真源** = `scripts/build-client.mjs` 的 `INLINE_MODULES`）
  → 单产物 `lib/client.js`（生成物，不入库）。
- **资产**：`lib/about/**`、`lib/fontsets/**`、`lib/glass-presets/**`、`lib/types/**`；仓库根 `assets/**`（不进包）。
- **发布面**：`package.json` 的 `files`（逐文件白名单）/ `exports`（主入口 + 每个组件三连 + patch + package.json）/
  `peerDependencies`（宿主 `@deepseek-ai/*` 的兼容锚）—— 逐条以该文件为准。

## 附录 B —— 上游撞车面（复算：`git merge-tree --write-tree --name-only HEAD <PR>`）

| PR | 触面 | 状态（2026-10-14 复核） |
|---|---|---|
| #195 | `lib/index.js` / `lib/routes/scene-serve.js` / `package.json` / `lib/client.js` / `src/client.js` / 引擎侧曝光打点 / 新增 `lib/occlusion/**` | **已落地**（`93594227`，是 HEAD 的祖先）⇒ 撞车面已收进本线 |
| #196 | 同上 + **删 `lib/webwallgl/**`**（引擎 vendored 副本）+ 生成物 + 多条守卫 | **已落地**（`b8174983`，是 HEAD 的祖先）⇒ 引擎已 npm 化，见 §9.4 |

**纪律**：① 不碰 PR 独占面；② 生成物一律重算；③ `package.json` 只做并集（多包化会重排 `files`/`exports`，
与"不重排"冲突）；④ 每阶段复核冲突面是否变大。

**⑤ 开工闸门（原纪律 ③）已解除**：原定"多包化必须在 #195 / #196 落地合入之后再开"，两笔现已合入。
复算：`git merge-base --is-ancestor 93594227 HEAD` 与 `git merge-base --is-ancestor b8174983 HEAD`（均 exit 0）。

## 附录 C —— 验收命令

```powershell
npm run build                      # 重建产物（多包后：多个产物）
npm run verify:all                 # 硬档 + 软档 + docs + smoke；必须 exit 0
node test/run-guards.mjs all       # 上面那条的真源（分组与步数以 test/run-guards.mjs 为准）
node test/run-guards.mjs docs      # 文档档单独跑（**全部 soft，经 warn-only 降级 ⇒ 红不拦 PR，必须自己看输出**）
node test/verify-component-visibility.mjs    # D3 的可见面双向对账
node test/verify-bundle-rows.mjs   # ⚠️ 脱链判据：行命名空间 / 路由账对账（CI 不跑，必须手动）
node test/tools/host-route-index.mjs         # 路由与行清单（现算）
node test/tools/guard-targets.mjs --write    # 生成物重算（禁手改）
git status --porcelain             # 期望：只剩本阶段预期改动
```

## 附录 D —— 本手册的机制取证（复算入口）

- **asar 读取**：头 16 字节；`headerSize = uint32LE@12`；`base = 16 + headerSize`；按 JSON 的 `offset/size` 直读。
  条目总数 / 包数 / 有 `dsh.client` 的包数**都随上游漂** ⇒ 不抄数，读出来现算（条目数 = 目录树叶节点数；
  `@deepseek-ai/*` 包数 = 这些叶节点 path 去重后的**父包**个数；有 `dsh.client` 的 = 其 `package.json` 里
  `dsh.client` 非空。2026-10-14 复核时它们是 12967 / 297 / 72，本行只是**当时的读数**，不是不变量）。
- **关键包**：`@deepseek-ai/dsh-app-boot`（profile / bundle / patch / 兼容性）、
  `@deepseek-ai/dsh-plugin-manager`（安装 / 开关 / `reconcile`；`ambiguous-install` 与 `bundleComponent*` 都住这里）、
  `@deepseek-ai/dsh-client-modules`（客户端 graph / 物化 / prune）、
  `@deepseek-ai/dsh-client-hmr`（重建 / 级联）、`@deepseek-ai/cordis`（fiber / reflect 级联）。
- **本机真机事实**：`$DSH_HOME/profiles/<name>/{package.json,cordis.patch.yml,pnpm-workspace.yaml,node_modules}`；
  profile 用 `nodeLinker: hoisted`；行开关的覆盖项形如 `- id: <行 id>` + `disabled: false`
  （本机 desktop profile 里能看到 `wallpaper-engine` 那一条 ⇒ 行开关有效；
  **具体哪条随用户的开关操作变，别当不变量**）。
  复算：`Get-Content "$env:USERPROFILE\.dsh\profiles\<p>\cordis.patch.yml" | Select-String 'wallpaper-engine'`。

## 附录 E —— 度量口径 M1–M10（**现行契约**）

**度量（成功判据）**：M1 门面体量 · M2 门面非装配占比 · M3 浏览器半边体量 ·
M4 跨组件共享读改写路径的设置键数（目标 0）· M5 守卫硬编码路径 / 清单条数（**加一个组件行不改工具**）·
M6 一族的文件归属唯一性 · M7 新人定位成本 · **M8 边界可声明率**（目标 100%）·
**M9 跨模块隐式共享面**（目标 0）· **M10 实现归属唯一性**（目标 0）——
**目标值是契约；"当时是多少"属历史**（见 `CHANGELOG.md` 与 git 历史）。

**口径**：不改善 M1–M10 任何一项的工作一律不做（唯一例外 = ADR-0013 D3）；**可开关本身不加分**。

**复算入口**：M1 / M2 = `node test/tools/m2-facade-code-share.mjs`；M5 = `test/verify-bundle-rows.mjs`；
M8 = `test/verify-inject-contracts.mjs`；M9 = `test/verify-component-face.mjs`；M10 = `test/verify-route-ownership.mjs`；
M3 = 构建产物 `lib/client.js` 的体积（`npm run build` 后量）。
## 附录 G —— 候选入选判据 J1–J7（**从旧文原文恢复**）

> **用途**：判定"一个功能族凭什么独立成包 / 独立成行"。本手册改写时漏带这七条，
> 导致 §7 的候选讨论（以及本仓 `TODO.md` 的"J1–J7 全过者"）引用了一个没有定义的记号 —— 现原文补回。
> 历史原件：`git show 5707d358:docs/wip/BUNDLE-SPLIT.md`。**J6 的前提（设置分区）与 J7 的前提（契约收紧）
> 都已由已完成的 P1 / P2-7 兑现**，判据本身照旧。

| # | 判据 | 反例（为什么不独立） |
|---|---|---|
| J1 | **贡献面自洽**：有自己的 HTTP 路由族（或完全不占路由）与自己的设置键簇 | `/media` 挂在媒体字节实现上（跨簇） |
| J2 | **状态自持**：自己的磁盘载体（目录 / 文件）或自己的 `config.json` 根字段 | 只有 `settings` 段里的一堆键 ⇒ 见 J6 |
| J3 | **无同进程强耦合**：不依赖别的簇的内存注册表、不共享单例缓冲 | `/diag` 环形缓冲必须与媒体源同进程（只有一个 `/diag-log`） |
| J4 | **可缺省**：关掉它，其余功能**没有可见缺失**（不是"降级"而是"不存在"） | `/inventory` 是所有簇的真源 ⇒ 关不掉 |
| J5 | **出入边少**：`import` 面自足（理想：≤ 2 个内核模块） | `lib/routes/presets.js` 需要一批注入点，横跨三簇 |
| J6 | **设置可切分**：它的键能整簇搬进自己的命名空间，且不与别的簇共享同一个**读改写**路径 | 全部键同段、`PUT /settings` 整段覆盖 ⇒ **P1 之前对谁都不成立**（P1 已兑现） |
| J7 | **依赖面可声明**：它需要的东西能写成一份**显式键集**（注入面），不靠共享可变状态、不靠直接解构内核对象 | 只有靠门面的会话状态 / `const { … } = hostKernel` 的隐式共享才跑得起来 ⇒ 先做契约收紧（P2-7，已完成） |
