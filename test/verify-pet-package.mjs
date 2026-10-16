import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('packages/pet-link/package.json', root), 'utf8'));
assert.equal(pkg.name, 'dsh-plugin-wallpaper-engine-pet-link');
assert.ok(!Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).includes('dsh-pet'));
for (const path of ['lib/index.js', 'lib/routes/pet-link.js', 'lib/prepared.js', 'tools/install-bridge.mjs', 'tools/patch-data/dsh-pet-0.3.6-index.txt', 'tools/patch-data/LICENSE.dsh-pet', 'src/pet-link.js', 'src/pet-link-tuner.js']) {
  assert.ok(existsSync(new URL('packages/pet-link/' + path, root)), path);
}
const mod = await import('../packages/pet-link/lib/index.js');
assert.deepEqual(mod.inject, ['webServer', 'wallpaperEngineHost']);
const routes = new Map(); let cleanup;
const { createSubpackageHost } = await import('../lib/subpackage-boot.js');
const off = mod.apply({ wallpaperEngineHost: createSubpackageHost(), webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } }, effect(fn) { cleanup = fn(); } }, { linkEnabled: false });
assert.equal(routes.size, 1);
let body;
routes.values().next().value.handler({ method: 'GET' }, { setHeader() {}, end(value) { body = JSON.parse(value); } });
assert.equal(body.available, false);
assert.equal(body.linkEnabled, false);
off(); cleanup(); assert.equal(routes.size, 0);
const side = readFileSync(new URL('src/sidebar-right.js', root), 'utf8');
const sideEnd = side.indexOf('// 定时器一律走 window.');
const drawerCalls = [];
const native = new Function('drawer', side.slice(0, sideEnd) + ';ropeDrawerControl=drawer;return [wallSidebarOpen(),wallSidebarClose(),wallSidebarToggle()];')({
  open() { drawerCalls.push('open'); }, close() { drawerCalls.push('close'); }, toggle() { drawerCalls.push('toggle'); },
});
assert.deepEqual(native, [true, true, true], '无桌宠时必须保留上游抽屉回退');
assert.deepEqual(drawerCalls, ['open', 'close', 'toggle']);
console.log('PASS 完整子包可独立加载、无dsh-pet硬依赖、禁用回退及幂等卸载');
