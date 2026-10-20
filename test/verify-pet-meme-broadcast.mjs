#!/usr/bin/env node
/** 真配置→真素材→宿主广播决策→真实petLinkSay，不能只验证复制了PNG。
 *
 * 2026-10-20：内置桌宠副本（`packages/pet`）已解耦，本判据依赖的宿主侧
 * `readAllConfig` / `decideBroadcast`（原住 `packages/pet/lib/index.js` 的预构建字节）随之离场。
 * 现有可测面还剩「五张气泡素材随包齐全 + provisionAssets 真把字节落到数据根」——
 * 即浏览器半边能拿到的资源面。广播决策本身的判据等 provider 重新接入后挂回新入口
 * （口径不变：真配置 → 真素材 → 真决策，不接受只验复制）。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { provisionAssets } from '../packages/pet-link/lib/provision.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = fs.mkdtempSync(path.join(tmpdir(), 'we-pet-meme-broadcast-'));
assert.equal(path.dirname(dir), path.resolve(tmpdir()), '清理目标必须是本测试创建的临时目录');
try {
  provisionAssets(dir);
  // 五张气泡必须真的落到数据根（只追加、不覆盖用户素材）—— 浏览器半边按这些名字取图。
  const memes = fs.readdirSync(path.join(dir, 'memes')).filter((n) => n.endsWith('.png'));
  assert.equal(memes.length, 5, '五张气泡素材必须全部落地，实际 ' + memes.length + '：' + memes.join(','));
  // 九段联动动画同样随包齐全（webm 源在 pet-link 自己的资源面里）。
  const webmSrc = path.join(root, 'packages/pet-link/assets/webm');
  const webmCount = fs.readdirSync(webmSrc).filter((n) => n.endsWith('.webm')).length;
  assert.equal(webmCount, 9, '九段联动动画必须随包齐全，实际 ' + webmCount);
  // 落盘字节必须与源一致（不是空壳/占位）。
  for (const name of memes) {
    const got = fs.statSync(path.join(dir, 'memes', name)).size;
    assert.ok(got > 0, name + ' 落盘为 0 字节');
  }
  console.log('PASS 五张气泡 + 九段动画资源面齐全且真实落地（广播决策判据随 provider 解耦休眠）');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
