import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * prepared.js —— 桌宠联动的**就绪面**（2026-10-20 起：provider 待接入）。
 *
 * 历史：本文件先后服务过两条链 —— ① 外部 `dsh-pet` 补丁安装（读 `$DSH_HOME/dsh-pet/pet-link-install.json`
 * 的补丁指纹）；② 内置受控副本 `dsh-we-pet-builtin`（`packages/pet`）。
 *
 * **2026-10-20：内置副本已从本包解耦。** 它把 `electron`（optional）带进安装树，而 electron 42+
 * 在缺 `dist/` 时会在 `require('electron')` 里**同步**下载约 140MB 二进制 ⇒ 宿主启动被堵到
 * 60 秒超时、整个 profile 起不来。桌宠本体不值得承担这个风险，故整体移除；本联动子包保留，
 * 作为上游 dsh-pet 提供正式联动接口后的**唯一接入点**。
 *
 * 因此当前的就绪面只有一个诚实答案：**不可用**（`available:false` + 稳定 reason），
 * 直到外部 provider 被显式接上。这条降级路径是产品行为的一部分，不是错误：
 * 浏览器半边据此保留吉祥物原生行为，绝不静默假装桌宠可用。
 *
 * 就绪判据（provider 存在时才继续）：① 包在位且身份/版本对；② 两半产物字节与
 * `client.build.json` 登记的锚点逐字相等；③ 联动资源（九动画 + 五气泡）在资源面齐全。
 * 返形 `{ available, reason }` 不变，reason 文案逐字稳定（浏览器降级文案与负控按它取。
 */

export const PET_NAMES = Object.freeze([
  '通用-右侧螃蟹步-dshwe', '通用-左侧螃蟹步-dshwe',
  '侧边栏-蓄力准备往后拉-dshwe', '侧边栏-后拉接疲态结束-dshwe',
  '吉祥物-跳抓眩晕落地起身-dshwe', '彩蛋-侧边栏-半身转向踢腿-dshwe',
  '彩蛋-侧边栏-被弹飞-dshwe', '彩蛋-侧边栏-落地-dshwe', '彩蛋-吉祥物-哈气-dshwe',
]);
const MEMES = ['累瘫鲸鱼的两碗饭', '蓝发鲸尾女仆拒绝换壁纸', '暴怒鲸尾女仆贴纸', '吓哭了', '？！欺负一只肥鱼！？'];
/** 表情素材名（导出给 provision.js 用同一份真源，避免两处各抄一遍）。 */
export const MEME_NAMES = Object.freeze(MEMES);

/** 内置桌宠的固定派生身份与版本（与 `test/tools/subpackage-shapes.mjs` 的登记同值）。 */
export const PET_PACKAGE_NAME = 'dsh-we-pet-builtin';
export const PET_PACKAGE_VERSION = '0.3.7';
/** 内置桌宠的独立数据根（不与外部 `dsh-pet` 共享，见 P1 身份隔离）。 */
export const PET_DATA_DIR = PET_PACKAGE_NAME;
/** 浏览器半边使用的桥接基址（与 `src/pet-link.js` 的 PET_BASE 同一真源）。 */
export const PET_BASE_PATH = '/dsh-we-pet-builtin';

const hashes = new Map();
function fileHash(path) {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile()) throw new Error('不是文件');
  const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const cached = hashes.get(path);
  if (cached && cached.key === key) return cached.hash;
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (hashes.size > 128) hashes.clear();
  hashes.set(path, { key, hash });
  return hash;
}

/**
 * 解析内置桌宠包根。**与宿主同一落脚处**（宿主按裸包名解析行，P1 在 `<profile>/node_modules`），
 * 解析不到时退回本仓 `packages/pet`（开发期自链）—— 两条路都指向同一份字节。
 * @param {string} [profile] profile 目录（宿主解析根）
 * @returns {string|null}
 */
export function resolvePetPackageRoot(profile) {
  const tries = [];
  if (profile) tries.push(() => createRequire(join(profile, 'cordis.yml')).resolve(`${PET_PACKAGE_NAME}/package.json`));
  tries.push(() => createRequire(import.meta.url).resolve(`${PET_PACKAGE_NAME}/package.json`));
  for (const attempt of tries) {
    try {
      const manifestPath = attempt();
      return join(manifestPath, '..');
    } catch { /* 下一条腿 */ }
  }
  return null;
}

/**
 * 内置联动的资源面根：**发行包自带**（`packages/pet-link/assets`），不是用户目录。
 * 用户目录只承载"用户自己加的东西"，不是"我们承诺在的东西"。
 */
const ASSETS_ROOT = fileURLToPath(new URL('../assets/', import.meta.url));

/**
 * 就绪判据（纯函数式：只读盘，不写盘、不改用户数据）。
 *
 * @param {string} home `$DSH_HOME`（调用方按宿主同口径算出）
 * @param {string} [profile] profile 目录（宿主解析根；缺省只走本仓解析）
 * @returns {{available: boolean, reason: string}}
 */
export function checkPetPrepared(home, profile) {
  try {
    const pkgRoot = resolvePetPackageRoot(profile);
    // 2026-10-20：内置副本已解耦 ⇒ 全新安装必然落到这里。文案要说清"这是预期状态"，
    // 而不是让用户以为装坏了、去反复重装一个不存在的包。
    if (!pkgRoot) {
      return { available: false, reason: '桌宠本体未安装（内置副本已解耦，等待上游 dsh-pet 联动接口接入）' };
    }
    const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    // 身份与版本分开报：这两类故障的修法不同（装错包 vs 装了别的版本），合成一句会让人查错方向。
    if (manifest.name !== PET_PACKAGE_NAME) {
      return { available: false, reason: '内置桌宠身份不符：期望 ' + PET_PACKAGE_NAME + '，实际 ' + String(manifest.name) };
    }
    if (manifest.version !== PET_PACKAGE_VERSION) {
      return { available: false, reason: '内置桌宠版本不符：期望 ' + PET_PACKAGE_VERSION + '，实际 ' + String(manifest.version) };
    }
    // ② 两半产物的字节锚点：读内置包自己的登记（同一份锚点喂构建期与运行期，不另抄一份）。
    let anchors = null;
    try { anchors = JSON.parse(readFileSync(join(pkgRoot, 'client.build.json'), 'utf8')).prebuilt || null; }
    catch { anchors = null; }
    if (!anchors) return { available: false, reason: '内置桌宠缺少产物登记（client.build.json），安装不完整' };
    const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const pairs = [
      [anchors.entry, anchors.sha256],
      [anchors.hostEntry, anchors.hostSha256],
    ];
    for (const [rel, want] of pairs) {
      if (typeof rel !== 'string' || !rel || !validHash(want)) {
        return { available: false, reason: '内置桌宠产物登记不完整，请重新安装插件包' };
      }
      const abs = join(pkgRoot, rel);
      if (!existsSync(abs)) return { available: false, reason: '内置桌宠产物缺失：' + rel };
      if (fileHash(abs) !== want) return { available: false, reason: '内置桌宠产物字节与登记锚点不符' };
    }
    // ③ 九动画 + 五气泡：必须在**内置资源面**齐全（发行包自带，不依赖用户准备）。
    for (const name of PET_NAMES) {
      if (!existsSync(join(ASSETS_ROOT, 'webm', name + '.webm'))) {
        return { available: false, reason: '桌宠联动资源缺失或已改变' };
      }
    }
    for (const name of MEMES) {
      if (!existsSync(join(ASSETS_ROOT, 'memes', name + '.png'))) {
        return { available: false, reason: '桌宠联动资源缺失或已改变' };
      }
    }
    // ④ 用户数据根的动画扩展**若存在**，它的目标与池必须覆盖九个名字（用户可能自己加过东西）；
    //    不存在是正常态（首次运行还没合并），不构成不可用。
    const extPath = join(home, PET_DATA_DIR, 'animation-ext', 'leash-bridge-ext.json');
    if (existsSync(extPath)) {
      const ext = JSON.parse(readFileSync(extPath, 'utf8'));
      if (ext.target !== 'main' || !PET_NAMES.every((name) => ext.animations?.events?.DSHWE?.includes(name))) {
        return { available: false, reason: '目标宠物动画池不完整' };
      }
    }
    return { available: true, reason: '' };
  } catch {
    return { available: false, reason: '内置桌宠就绪检查失败（安装或数据面异常）' };
  }
}
