import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registerPetLinkRoutes } from '../packages/pet-link/lib/routes/pet-link.js';

mkdirSync(resolve('.artifacts'), { recursive: true });
const home = mkdtempSync(resolve('.artifacts/hotplug-host-'));
process.env.DSH_HOME = home;
process.env.DSH_PROFILE_DIR = join(home, 'profiles/desktop');
const routes = new Map();
const server = { register(route) { routes.set(route.path, route); return () => { if (routes.get(route.path) === route) routes.delete(route.path); }; } };
const config = { linkEnabled: true };
function mount() {
  const disposers = [];
  registerPetLinkRoutes(server, { disposers, base: '/wall' }, { isLinkEnabled: () => config.linkEnabled !== false });
  return () => disposers.splice(0).reverse().forEach(fn => fn());
}
function get(handler = routes.get('/wall/pet-link/capability').handler, method = 'GET') {
  let body; const headers = {};
  const res = { setHeader(k, v) { headers[k.toLowerCase()] = v; }, end(v) { body = v; } };
  handler({ method }, res);
  return { status: res.statusCode, data: body ? JSON.parse(String(body)) : null, headers };
}
const unmount = mount();
const firstHandler = routes.get('/wall/pet-link/capability').handler;
const first = get();
assert.equal(first.headers['cache-control'], 'no-store');
assert.equal(first.data.protocol, 1);
assert.equal(first.data.enabled, true);
assert.equal(first.data.linkEnabled, true);
// 2026-10-20：内置副本（`packages/pet`）已解耦 ⇒ 没有 provider 时**必须**如实报不可用。
// 这条不是"测试放宽"：它锁的正是解耦后的产品契约 —— 缺 provider ⇒ available:false + 稳定 reason，
// 浏览器半边据此保留吉祥物原生行为，绝不静默假装桌宠可用。
assert.equal(first.data.available, false);
assert.match(first.data.reason, /桌宠本体未安装/);
assert.equal(first.data.ttlMs, 1500);
assert.equal(typeof first.data.generation, 'string');
config.linkEnabled = false;
assert.equal(get().data.linkEnabled, false);
config.linkEnabled = true;
assert.equal(get().data.linkEnabled, true);
const nextUnmount = mount();
const next = get();
assert.notEqual(first.data.generation, next.data.generation);
unmount();
assert.equal(routes.size, 1, '旧会话不能移除新路由');
assert.equal(get(firstHandler).data.enabled, false, '迟到的旧处理器必须撤销资格');
assert.equal(get(firstHandler).data.available, false);
assert.equal(get().data.generation, next.data.generation);
assert.equal(get(undefined, 'POST').status, 405);
nextUnmount();
assert.equal(routes.size, 0);
console.log('PASS 协议、短期资格、无缓存、独立联动开关、代际和迟到退出');

// 解耦后同一条纪律仍然成立：外部 `dsh-pet` 目录里的东西**不参与**就绪判定。
// 写一份"外部链看起来都齐了"的假安装记录，就绪面必须仍然报不可用 —— 不是"恰好缺包"，
// 而是"外部残留不许冒充 provider"。
const data = join(home, 'dsh-pet');
mkdirSync(join(data, 'animation-ext'), { recursive: true });
writeFileSync(join(data, 'animation-ext/leash-bridge-ext.json'), JSON.stringify({ target: 'main', animations: { events: { DSHWE: ['通用-右侧螃蟹步-dshwe'] } } }));
const stop = mount();
assert.equal(get().data.available, false, '外部 dsh-pet 残留目录不得冒充 provider');
assert.match(get().data.reason, /桌宠本体未安装/);
stop();
console.log('PASS 外部 dsh-pet 残留目录不参与就绪判定（解耦后仍不冒充 provider）');
