import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSubpackageHost } from '../lib/subpackage-boot.js';
import { name, inject, apply } from '../packages/pet-link/lib/index.js';

const moduleUrl = process.env.PET_TEST_CORDIS_MODULE
  ? pathToFileURL(resolve(process.env.PET_TEST_CORDIS_MODULE)).href
  : import.meta.resolve('@deepseek-ai/cordis');
const { Context, Service } = await import(moduleUrl);
const routes = new Map();
class WebServer extends Service {
  constructor(ctx) { super(ctx, 'webServer'); }
  register(route) {
    assert.ok(!routes.has(route.path), '禁止重复注册 ' + route.path);
    routes.set(route.path, route);
    return () => { if (routes.get(route.path) === route) routes.delete(route.path); };
  }
}
const ctx = new Context();
const service = ctx.plugin(WebServer);
const plugin = { name, inject, apply };
const path = '/wallpaper-engine/pet-link/official/targets';
let fiber;
async function get(handler = routes.get(path)?.handler, method = 'GET') {
  assert.ok(handler, '正式官方路由必须在场');
  let body;
  await handler({ method }, { setHeader() {}, end(value) { body = JSON.parse(value); } });
  return body;
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await delay(10);
  if (fiber?.error) throw fiber.error;
  assert.ok(predicate(), '配置更新必须完成路由交接');
}
try {
  await service.await();
  ctx.provide('wallpaperEngineHost', createSubpackageHost());
  fiber = ctx.plugin(plugin, { linkEnabled: true });
  await fiber.await();
  assert.equal(routes.size, 3);
  assert.equal((await get(undefined, 'POST')).reason, 'method-not-allowed');
  const initial = routes.get(path).handler;
  fiber.update({ linkEnabled: false }, true);
  await until(() => routes.get(path)?.handler !== initial);
  assert.equal((await get()).reason, 'bridge-disabled');
  assert.equal((await get(initial)).reason, 'bridge-disabled', '旧处理器必须失效');
  const disabled = routes.get(path).handler;
  fiber.update({ linkEnabled: true }, true);
  await until(() => routes.get(path)?.handler !== disabled);
  assert.equal((await get(undefined, 'POST')).reason, 'method-not-allowed');
  await fiber.dispose(); fiber = null;
  assert.equal(routes.size, 0);
  for (let i = 0; i < 10; i++) {
    fiber = ctx.plugin(plugin, { linkEnabled: false });
    await fiber.await();
    assert.equal(routes.size, 3);
    assert.equal((await get()).reason, 'bridge-disabled');
    await fiber.dispose(); fiber = null;
    assert.equal(routes.size, 0);
  }
  console.log('PASS 真实 Cordis：正式路由、配置更新、旧处理器失效、十次启停及零路由残留');
  console.log('此检查不安装或修改官方 pet，不代表官方渲染器的完整演出验收。');
} finally {
  if (fiber) await fiber.dispose();
  await service.dispose();
}
