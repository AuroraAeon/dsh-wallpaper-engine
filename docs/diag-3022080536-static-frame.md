# 3022080536 静态帧 / 背景层渲染异常 — 排查记录

壁纸：`赛博color-宣纸国画-紫罗兰永恒花园`（`ls-1dde252a48a1`，`scene.pkg` 27.2MB，
scene 类型，`supportsaudioprocessing: true`）。投影 `6208×3520`，`clearcolor 0.7 0.7 0.7`。

## 1. 场景结构（4 个对象）

| 对象 | image | rect (size×scale) | origin | 类型 | 效果链 |
|---|---|---|---|---|---|
| `背景` | `models/背景.json` | 6208×3520 | 3104, 1760 | **puppet**（`背景_puppet.mdl`，7152B） | — |
| `Bars with gradient` | `models/util/composelayer.json` | 3840×2160 ×1.6926/1.3797 | 3148.8, 3112.0 | **画布 passthrough**（WE 内置模型，包内不含） | Simple_Audio_Bars + gradient_color ×2 |
| `主体` | `models/主体.json` | 2156×3291 | 3032.3, 1571.0 | **puppet**（`主体_puppet.mdl`，408KB，52B 布局） | waterwaves + shake |
| `Getsuga Tenshou Mouse Trail` | particle | — | — | 粒子（`mouseswitch` 属性控制） | — |

包内只有 2 张图集：`materials/背景.tex`（6208×3520，内嵌 **color-type 2 / RGB** PNG）、
`materials/主体.tex`（2156×3291）。两个 puppet MDL 的网格都与图集 **1:1**（见 §3）。

## 2. 排查出的三个独立缺陷

### 缺陷 A（本次修复）静态帧被 RGB PNG 载荷解码器毁掉：右侧 25% 纯黑 + 颜色串道

`lib/pkg-extract.js decodePngPayload()` 的逐行反滤直接在 **4B/px 的 RGBA 输出缓冲**
上做，却用 `channels`（ct=2 时 = 3）的步长寻址：左侧邻取 `x - channels`、上行取
`(y-1)*w*4 + x`，且循环只走到 `w*channels`（不写行尾）。只有 `channels === 4`
（ct=6）时两套寻址恰好等价，ct=2 载荷下：

* 每行只写 `w*3` 字节 → **行尾 25% 永不写入 = 纯黑竖带**（alpha 事后补 255，所以是黑不是透明）；
* 前缀区按错误步长混叠 → 像素横向串道（青/品红错位）。

实测（`3022080536` 走 0.8.9 拼合路径，`composite(2 layers)` 19,314,277B）：

```
采样(50×50 均值)   x=200        x=3000       x=4600       x=6000
旧输出            237,237,237  143,134,122  237,237,238  0,0,0      ← 黑带
修复后            252,245,217  143,134,122  251,243,214  251,245,217
独立参考(IM 手工拼合) 252,245,217  143,134,122  251,243,214  251,245,217
```

全库影响面（`lib/we-renderer/*` 之外的 25 个内嵌 PNG 载荷纹理，按 PNG color type 分组）：
**ct=6 12/12 逐字节不变（零回归）**，**ct=2 13/13 全部变化**（此前全部损坏）。
用户缓存里两张当场可见的坏帧就是这一类：`3344701858`（右侧 20% 均值 = 0）、
`3366882745`（同为 0）——拼合帧右侧整条黑带。

修复：先在 **紧凑源布局**（`w*channels`）行缓冲上按 PNG 规则反滤，再展开成 RGBA
（ct=6 走 `rgba.set(cur, o)`，与旧实现逐字节等价）。

### 缺陷 B（本次修复）puppet 图层被整组排除 → 静态帧只剩宣纸、人物消失

本壁纸的**两个**图像对象都是 puppet，而 puppet 图集有两种语义：

| 语义 | 判据（实测） | 能否用平面 quad 等价拼合 |
|---|---|---|
| 图集 **1:1 拷贝**（网格 = 图集像素搬运） | `pos = (W·u − W/2, H/2 − H·v)`，残差 ≤ 0.0004 | **能**（绑定姿态 = 图集排版姿态） |
| **散件图集 (sheet)** | 残差 72~1050（3784528825 两 mesh 697/988、3463520581 asuna body 119/73） | **不能**（平铺 = 四肢飘带散一屏） |
| 共用图集的**子矩形**（零件只采 sheet 一块） | 仿射残差 ~0 但 uv 只覆盖局部（3735447194 的 16 个部件） | **不能**（会画出 sheet 上别人的零件） |

全库普查（39 个 puppet MDL / 12 个带 puppet 的场景）：**3 个场景全部图层属 1:1 族**
（`2686862510`、`3022080536`、`3344701858` → 按新规则重新进入拼合），**9 个场景含散件或
子矩形图集**（`3784528825`、`3463520581`、`3593194513`、`3735447194`、`3302695207`、
`3366882745` 等 → 保持整组跳过，行为与「一律跳过」一致）。
`3022080536` 的 `背景`（20B 布局，228v）与 `主体`（52B 布局，2954v）都属 1:1 族，
所以「一律跳过 puppet」会把整张人物层丢掉：

```
修复前（0.8.14 行为）: 0 层 → 单纹理兜底 → materials/背景.tex（只剩宣纸）
修复后              : composite(2 layers) 6208×3520 —— 与独立参考帧 RMSE 0.089%
                      差异包围盒 2116×3139+1994+381 = 主体 rect（人物确实画进去了）
```

修复策略 = **全有或全无**：场景内所有 puppet 图层都判为 1:1 才整组进入拼合；
出现任何一个散件/子矩形图集则整组跳过（拼一半会得到「有躯干没四肢」的中间态，
比退回单纹理更糟）。分类器见 `lib/we-renderer/puppet-atlas.js`。

### 缺陷 C（未修，文档化）GL/静态帧都拿不到 `Bars with gradient` 的画布 passthrough 层

`Bars with gradient` 的对象 image 是 **WE 内置模型** `models/util/composelayer.json`
（= `{"material":"materials/util/composelayer.json","passthrough":true}`，材质 pass 的
纹理是 `_rt_FullFrameBuffer`），**不随包分发**。两条渲染链都拿不到它：

* GL gate：模型只在包/目录里解析（纹理有 `readGlobalAsset` 兜底，模型没有），
  解析失败 → `mark(name,'model','模型无材质，已跳过该对象')` → `/scene-gl-meta` 只有
  **3 个对象**（scene.json 有 4 个）；
* 静态帧：`lib/pkg-extract.js tryCompositeSceneLayers` 显式 `!o.image.startsWith('models/util/')`；
* iframe player：`lib/scene-manifest.js` 4 处同样跳过 `models/util/*`。

后果（用户可见）：该层的 3 个效果（`Simple_Audio_Bars`、`gradient_color` ×2，透明度
0.35）负责画面**上部的灰褐色渐变背景**（作者 `preview.jpg` 上方 45% 均值
194,182,168；实拍 GL 渲染 247,239,212 —— 只剩宣纸的原色）。即「背景（画面上部
的底色层）压根没渲染」。

这属于 **TODO.md 已记录的未实现特性**（「passthrough 层：`models/util/fullscreenlayer.json`
等 `_rt_` 材质 = 读当前画布 → 效果链 → 全屏合成」），本次不动。实现要点（后续）：
gate 侧把 `models/util/*` 的 passthrough 模型解析成
`mainTexture: { passThrough: true }` + 对象自身 rect；client 侧在合成阶段
`copyTexImage2D(CW, CH)` 把当前画布拷成纹理当效果链输入，再按对象 rect 合成。
注意 `Simple_Audio_Bars` 属音频响应效果，按现行策略仍会跳过（无音频源），
这一层最多只能补回渐变色。

## 3. 附：`背景_puppet.mdl` 的 20B 静态顶点布局（原「另一类问题」）

`背景_puppet.mdl`（7152B，`MDLV0016`，无 MDLS/MDLA = 无骨骼静态网格）既不匹配
80B 主布局也不匹配 52B 紧凑布局 —— 实测其顶点记录是 **20B**：

```
[9B 段头][u32 vertexBytes=4560][顶点 ×228][u32 indexBytes=2532][索引 ×1266][EOF]
顶点记录 = [pos f32×3][uv f32×2]（z 恒 0，无 blend/weights）
pos.x = 6208·u − 3104（残差 0.0004）  pos.y = 1760 − 3520·v（残差 0.0002）
索引全部 < 228
```

网格与对象 rect 完全重合（bbox ±3109/±1765 vs 投影半宽 3104/1760），因此**按静态
贴图渲染与网格渲染像素等价** —— 这也解释了为什么这条「解析失败」在画面上看不出来。
`puppet-atlas.js` 已支持该布局（读 pos/uv 做分类）；GL 网格路径若要一并支持
（消掉 `degraded` 条目），需在 `lib/we-renderer/puppet.js` 的顶点块扫描里加第三个
候选（判据：`vertexBytes % 20 === 0`、z 恒 0、uv ∈ [−1.05,1.05]、索引范围合法，
且**最后**尝试 —— 80/20 与 52/20 是整数倍关系，宽松匹配会在 80B 文件上误命中）。
本次不改 `puppet.js`（该文件正在被未提交的 0.8.14 WIP 大改），只在分类器里落地。

## 4. 复现 / 验证

```sh
# 全库审计：每个 puppet MDL 是 1:1 图集还是散件（残差 + 布局）
node scripts/verify-static-frame-fixes.mjs        # 25 项断言（A/B/C/D 四级）

# 单张壁纸：修复前后静态帧 + 区域均值
node -e 'import("./lib/pkg-extract.js").then(async m=>{
  const {readFileSync}=await import("node:fs");
  const r=m.extractSceneMainImage(new Uint8Array(readFileSync(process.env.HOME+"/Pictures/WallpaperEngine/3022080536/scene.pkg")));
  console.log(r.texturePath, r.width+"x"+r.height, r.bytes.length);})'
# → composite(2 layers) 6208x3520 20392433
```

修复前（0.8.9 基线 + 旧解码器）该命令给出 `composite(2 layers) … 19314277`（含黑带）；
0.8.14 WIP 的「puppet 一律跳过」给出 `materials/背景.tex … 11490075`（只剩宣纸）。

## 5. 回归证据（全库 185 张场景，清空帧缓存各跑一遍同一基线）

| 指标 | 改动前 (HEAD `40664aa` = 0.8.9) | 改动后 | 差异 |
|---|---|---|---|
| `/scene-gl-meta` supported | 175 / 185 | 175 / 185 | 逐条 `degraded` 数量 **0 处差异** |
| `/scene-frame` 产出帧 | 64 | 64 | — |
| 帧内容 | — | — | **57 张逐字节相同**，7 张变化 |

7 张变化帧全部可归因：

| 壁纸 | 原因 |
|---|---|
| `ls-1dde252a48a1` 赛博color-宣纸国画（本壁纸） | 人物层回归拼合 + RGB 黑带修复 |
| `ls-84f9e669a813` Shorekeeper. | ct=2 RGB 载荷黑带/串道修复 |
| `ls-e57396237811` 鸣潮 椿 Camellya | 同上（其 `bar_puppet.mdl` 布局未识别 → 木偶层跳过，与 WIP 一致） |
| `ls-19729e2cd0a3` Kirito x Asuna 4K | 散件图集整组跳过（与其 WIP 意图一致） |
| `ls-21d33ae38c23` 卡提希娅 Cartethyia | 同上（`手`/`腿` 是共用图集子矩形） |
| `ls-7fda094b100c` 达妮娅 Denia | 同上（18 个共用图集部件不再被整图铺上） |
| `ls-b7a37b70851a` Jinhsi Peach Blossom | 同上（Girl/Dragon Head 散件） |

与现场 0.8.14 WIP 帧对比（其 `.verify-all/` 2026-09-02 产物）：64 张里 **52 张逐字节相同**；
本壁纸现场帧 = `materials/背景.tex` 11,490,075B（只剩宣纸），本次 = `composite(2 layers)`
20,392,433B（宣纸 + 人物）。其余差异来自 0.8.14 WIP 自身的提取器改动
（`frameQuality` alpha 口径、`cropToImageRect`、旧容器首帧烘焙等），与本次改动无关。
