import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import * as patcher from '../tools/patch-pet-client.mjs';
import { sealPetPatch } from '../lib/compatibility.js';
const { applyEdits } = patcher;

const fallback = new URL('../../../.artifacts/pet-0.3.7/package/lib/client.js', import.meta.url);
const originalSource = readFileSync(process.argv[2] || fallback, 'utf8');
const source = applyEdits(originalSource);
let legacySource = patcher.EDITS.reduce((text, edit) => edit.all ? text.split(edit.from).join(edit.to) : text.replace(edit.from, edit.to), originalSource);
for (const name of ['applyControlEdits', 'applyBubbleTimingEdits', 'applyAssetCacheEdits', 'applyLifecycleEdits', 'applyThrowEdits', 'applyRuntimeOwnerEdits']) legacySource = patcher[name](legacySource);
test('重新准备升级已安装旧补丁，新补丁幂等且篡改仍拒绝', () => {
  const cache = new URL('../../../.artifacts/', import.meta.url);
  const dir = mkdtempSync(new URL('pet-multi-upgrade-', cache));
  mkdirSync(dir + '/lib');
  writeFileSync(dir + '/package.json', JSON.stringify({ version: '0.3.7' }));
  const cases = [sealPetPatch(legacySource, 'client')];
  if (createHash('sha256').update(legacySource).digest('hex') === patcher.PREVIOUS_RUNTIME_PATCHED) cases.push(legacySource);
  for (const legacy of cases) {
    writeFileSync(dir + '/lib/client.js', legacy);
    const plan = patcher.preparePetClient({ packageRoot: dir });
    assert.equal(plan.status, 'ready', '旧安装必须升级，不能误报already-patched');
    assert.notEqual(plan.patched.toString(), legacy);
    assert.match(plan.patched.toString(), /pet-link multi-instance-v1/);
    assert.equal(readFileSync(dir + '/lib/client.js', 'utf8'), legacy, '准备只读不覆盖旧安装');
    writeFileSync(dir + '/lib/client.js', plan.patched);
    assert.equal(patcher.preparePetClient({ packageRoot: dir }).status, 'already-patched');
    writeFileSync(dir + '/lib/client.js', sealPetPatch(legacySource, 'client').replace('pet-link', 'pet-tampered'));
    assert.throws(() => patcher.preparePetClient({ packageRoot: dir }), /摘要|指纹|锚点|结构/);
  }
});
const marker = source.indexOf('// ── pet-link 补丁：页内控制面');
const start = source.indexOf('\t\tuseEffect(() => {', marker);
const end = source.indexOf('\n\t\t}, []);', start) + '\n\t\t}, []);'.length;
assert.ok(marker >= 0 && start > marker && end > start, '抽取实际控制面 effect');
const effect = source.slice(start, end);
function reader(from, to, name, env) {
  const begin = source.indexOf(from), finish = source.indexOf(to, begin);
  assert.ok(begin >= 0 && finish > begin, '抽取实际锁读取器');
  return new Function('env', 'with(env){' + source.slice(begin, finish) + ';return ' + name + ';}')(env);
}
function harness() {
  const window = {};
  function mount(id) {
    let cleanup;
    const root = { id, style: {} }, cfg = { id };
    const selfLockRef = { current: { name: null, until: 0 } };
    const readLock = reader('const readLock = () => {', 'const lockedNow =', 'readLock', { window, cfg, selfLockRef, Date, console });
    const bubbleLockedNow = reader('const bubbleLockedNow = () => {', 'const selfPool =', 'bubbleLockedNow', { window, cfg, Date });
    const env = {
      window, cfg, rootRef: { current: root }, Date,
      useEffect(callback) { cleanup = callback(); },
      bubbleAllowUntilRef: { current: 0 }, allowBubbleWindow() {}, statePoller: { now() {} },
      linkPlaybackRef: { current: {} }, frontRef: { current: 0 }, videoARef: { current: {} }, videoBRef: { current: {} },
      bubbleLockedNow, setWhisperBubbleOnRaw() {}, setBubbleOnRaw() {}, setWorkBubbleOnRaw() {},
      readLock, selfLockRef, stopMove() {}, petAnims: { idle: [] }, setOnce() {}, setSeqRaw() {},
    };
    new Function('env', 'with(env){let bubbleDurationMs=1000;' + effect + '}')(env);
    return { root, cleanup, ctl: window.__dshPetCtrls?.[id] || window.__dshPetCtl, readLock, bubbleLockedNow };
  }
  return { window, mount };
}

test('附加桌宠不能覆盖主控制面，挂载顺序不影响主目标', () => {
  for (const ids of [['main', 'pet-2'], ['pet-2', 'main']]) {
    const { window, mount } = harness(), instances = ids.map(mount);
    const main = instances.find(pet => pet.root.id === 'main');
    assert.equal(window.__dshPetCtl, main.ctl, '兼容入口始终指向main');
    for (const pet of instances) assert.equal(window.__dshPetCtrls[pet.root.id], pet.ctl);
    for (const pet of instances) pet.cleanup();
    assert.equal(window.__dshPetCtl, null);
    assert.equal(window.__dshPetCtrls, undefined, '最后一个实例卸载后撤销登记');
  }
});
test('附加桌宠卸载不能撤回主控制面、动作锁或气泡锁', () => {
  const { window, mount } = harness(), main = mount('main'), extra = mount('pet-2');
  main.ctl.lock('main-animation'); main.ctl.lockBubbles();
  extra.cleanup();
  assert.equal(window.__dshPetCtl, main.ctl);
  assert.equal(window.__dshPetLock?.owner, main.ctl);
  assert.equal(window.__dshPetBubbleLock?.owner, main.ctl);
  main.cleanup();
  assert.equal(window.__dshPetLock, null); assert.equal(window.__dshPetBubbleLock, null);
});
test('主桌宠卸载不降级操控副桌宠；旧实例清理不删除替换后的主实例', () => {
  const { window, mount } = harness(), old = mount('main'), extra = mount('pet-2'), current = mount('main');
  current.ctl.lock('current'); current.ctl.lockBubbles(); old.cleanup();
  assert.equal(window.__dshPetCtl, current.ctl);
  assert.equal(window.__dshPetCtrls.main, current.ctl);
  assert.equal(window.__dshPetLock?.owner, current.ctl);
  assert.equal(window.__dshPetBubbleLock?.owner, current.ctl);
  current.cleanup(); assert.equal(window.__dshPetCtl, null);
  assert.equal(window.__dshPetCtrls['pet-2'], extra.ctl);
  extra.cleanup(); assert.equal(window.__dshPetCtrls, undefined);
});
test('主桌宠动作锁和气泡锁不能阻塞副桌宠的原生入口', () => {
  const { window, mount } = harness(), main = mount('main'), extra = mount('pet-2');
  main.ctl.lock('main-animation'); main.ctl.lockBubbles();
  assert.ok(main.readLock()); assert.equal(main.bubbleLockedNow(), true);
  assert.equal(extra.readLock(), null, '副桌宠不能消费主桌宠动作锁');
  assert.equal(extra.bubbleLockedNow(), false, '副桌宠不能消费主桌宠气泡锁');
  window.__dshPetLock.expiresAt = 0; window.__dshPetBubbleLock.expiresAt = 0;
  extra.readLock(); extra.bubbleLockedNow();
  assert.equal(window.__dshPetLock?.owner, main.ctl, '副实例不能清除其他目标的过期锁');
  assert.equal(window.__dshPetBubbleLock?.owner, main.ctl);
  assert.equal(main.readLock(), null); assert.equal(main.bubbleLockedNow(), false);
  extra.cleanup(); main.cleanup();
});

const link = readFileSync(new URL('../src/pet-link.js', import.meta.url), 'utf8');
function functionOf(name) {
  const begin = link.indexOf('function ' + name + '('), finish = link.indexOf('\n}', begin) + 2;
  assert.ok(begin >= 0 && finish > begin, '抽取真实联动函数 ' + name);
  return link.slice(begin, finish);
}
test('朝向和身体量测仅使用已绑定桌宠的子节点', () => {
  const mainVideo = { style: { transform: 'scaleX(-1) scaleY(.8)' } };
  const extraVideo = { style: { transform: 'scaleX(-1) scaleY(.6)' } };
  const mainRect = { left: 100, right: 140, width: 40 }, extraRect = { left: 700, right: 740, width: 40 };
  const root = {
    getAttribute: () => 'left',
    querySelectorAll: () => [mainVideo],
    querySelector: () => ({ getBoundingClientRect: () => mainRect }),
  };
  const env = {
    document: { querySelector() { return { getBoundingClientRect: () => extraRect }; }, querySelectorAll: () => [extraVideo, mainVideo] },
    petLinkPetEl: () => root, petLinkPetRect: () => ({ left: 80, width: 100, height: 100, top: 0 }),
    PET_BODY_LEFT_RATIO: .2, PET_BODY_RIGHT_RATIO: .8,
  };
  const api = new Function('env', 'with(env){' + functionOf('petLinkArmFacing') + functionOf('petLinkBodyRect') + ';return {arm:petLinkArmFacing,body:petLinkBodyRect};}')(env);
  const stop = api.arm();
  assert.equal(mainVideo.style.transform, 'scaleY(.8)');
  assert.equal(extraVideo.style.transform, 'scaleX(-1) scaleY(.6)', '副桌宠视频不能被改写');
  assert.equal(api.body(), mainRect, '身体框必须来自当前桌宠');
  stop(); assert.equal(extraVideo.style.transform, 'scaleX(-1) scaleY(.6)');
});
