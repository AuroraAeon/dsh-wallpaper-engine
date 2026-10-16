import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { assertPetVersion, hasSealedPetPatch, sealPetPatch } from '../lib/compatibility.js';

const ORIGINAL = 'cbb6edee55b9520b58a42df4981406a913e786d1be461f8ba2cd4d1a6a4b2714';
const PATCHED = 'fab68075a40c844d996c168f3b3109e00bc6e1cd1b7a16e2dd6e1ed1e20ab903';
const hash = data => createHash('sha256').update(data).digest('hex');

function applyHostEdits(source) {
  // 只提取动画扩展函数，绝不将旧宿主整文件覆盖到新版。
  const carrier = readFileSync(new URL('./patch-data/dsh-pet-0.3.6-index.txt', import.meta.url));
  if (hash(carrier) !== PATCHED) throw new Error('补丁载体指纹不符，拒绝写入。');
  const text = carrier.toString('utf8');
  const anchor = '/** animations 段完整性校验';
  const helpers = text.slice(text.indexOf('/** 扫描 animation-ext/'), text.indexOf(anchor));
  if (source.includes('function scanAnimExtFiles(') || source.includes('function applyAnimExtensions(')) {
    throw new Error('宿主已含未识别的扩展结构，保留现有代码。');
  }
  const config = '\tconst petConfigDir = join(userRoot, "pet");\n\tconst configPaths = {\n'
    + '\t\tdefaultFile: join(PACKAGE_ROOT, "assets", "config.jsonc"),\n'
    + '\t\tuserFile: userConfigPath,\n\t\tlegacyUserFile: legacyUserConfigPath,\n\t\tpetDir: petConfigDir\n\t};';
  const nextConfig = config.replace('\n\tconst configPaths', '\n\t// 动画池扩展目录（第三方插件追加动作用，见 applyAnimExtensions）；不存在 = 无扩展\n'
    + '\tconst animExtDir = join(userRoot, "animation-ext");\n\tconst configPaths')
    .replace('petDir: petConfigDir\n', 'petDir: petConfigDir,\n\t\textDir: animExtDir\n');
  const tail = '\treturn out;\n}\nfunction flattenPetList(merged) {';
  const edits = [
    [anchor, helpers + anchor],
    [tail, '\tapplyAnimExtensions(out, paths.extDir);\n' + tail],
    [config, nextConfig],
  ];
  for (const dependency of ['function readJsonc(', 'function warnOnce(', 'function animationsValid(', 'readdirSync']) {
    if (!source.includes(dependency)) throw new Error('宿主补丁依赖结构缺失：' + dependency);
  }
  let result = source;
  for (const [from, to] of edits) {
    const at = result.indexOf(from);
    if (at < 0 || result.indexOf(from, at + from.length) >= 0) throw new Error('宿主补丁锚点缺失或不唯一，保留现有代码。');
    result = result.slice(0, at) + to + result.slice(at + from.length);
  }
  return result;
}

/** 版本只设下限；不兼容结构或损坏补丁在写入前拒绝。 */
export function preparePetHost({ packageRoot } = {}) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const root = resolve(packageRoot || join(process.env.DSH_PROFILE_DIR || join(dshHome, 'profiles', 'desktop'), 'node_modules', 'dsh-pet'));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assertPetVersion(manifest.version);
  const target = join(root, 'lib', 'index.js');
  const original = readFileSync(target);
  const source = original.toString('utf8');
  const beforeHash = hash(original);
  if (beforeHash === PATCHED || hasSealedPetPatch(source, 'host')) {
    return { status: 'already-patched', target, original, patched: original, hash: beforeHash, version: manifest.version };
  }
  const result = applyHostEdits(source);
  const known = beforeHash === ORIGINAL;
  if (known && hash(result) !== PATCHED) throw new Error('宿主局部补丁指纹与已核对产物不符，拒绝写入。');
  const patched = Buffer.from(known ? result : sealPetPatch(result, 'host'), 'utf8');
  return { status: 'ready', target, original, patched, hash: hash(patched), version: manifest.version };
}

export function patchPet({ packageRoot, dryRun = false } = {}) {
  const plan = preparePetHost({ packageRoot });
  const { target, original, patched: replacement } = plan;
  if (plan.status === 'already-patched') return { status: 'already-patched', target };
  if (dryRun) return { status: 'ready', target };
  // 单文件操作；先备份，再写。完全不涉及删除目录或创建 junction。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = join(dirname(target), 'pet-link-backups', stamp, 'index.js');
  mkdirSync(dirname(backup), { recursive: true });
  writeFileSync(backup, original, { flag: 'wx' });
  writeFileSync(target, replacement);
  if (hash(readFileSync(target)) !== plan.hash) throw new Error('补丁写入后校验失败；备份：' + backup);
  return { status: 'patched', target, backup };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--pet-package');
  const result = patchPet({ packageRoot: at >= 0 ? args[at + 1] : undefined, dryRun: args.includes('--check') });
  console.log(JSON.stringify(result, null, 2));
}
