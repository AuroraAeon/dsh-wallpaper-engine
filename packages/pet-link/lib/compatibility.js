import { createHash } from 'node:crypto';

export const MIN_PET_VERSION = '0.3.6';

/** 只接受 >=0.3.6 的稳定 SemVer；构建元数据不影响版本排序。 */
export function isSupportedPetVersion(version) {
  if (typeof version !== 'string' || version.length > 128) return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1, 4).map(BigInt);
  return major > 0n || minor > 3n || (minor === 3n && patch >= 6n);
}

export function assertPetVersion(version) {
  if (!isSupportedPetVersion(version)) throw new Error('不支持该桌宠版本：' + version + '；需要 >=' + MIN_PET_VERSION + ' 稳定版本。');
}

const sha = source => createHash('sha256').update(source).digest('hex');

/** 本地完整性摘要用于重复安装和损坏检测，不是第三方代码的安全签名。 */
export function sealPetPatch(source, kind) {
  return source + '\n// pet-link-' + kind + '-v1 sha256:' + sha(source) + '\n';
}

export function hasSealedPetPatch(source, kind) {
  const prefix = '\n// pet-link-' + kind + '-v1 sha256:';
  const at = source.indexOf(prefix);
  if (at < 0) return false;
  const checksum = source.slice(at + prefix.length);
  if (!/^[a-f0-9]{64}\n$/.test(checksum) || sha(source.slice(0, at)) !== checksum.trim()) {
    throw new Error('桌宠补丁摘要不匹配，保留现有代码；请核对备份或重新安装官方原版。');
  }
  return true;
}
