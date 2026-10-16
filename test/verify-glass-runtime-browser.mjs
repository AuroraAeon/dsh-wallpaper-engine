import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { cssBodyOf } from './tools/src-scope.mjs';

const bundle = readFileSync(resolve('lib/client.js'), 'utf8');
const css = new Function('READABILITY_FLOOR', 'READABILITY_FLOOR_DARK', 'return `' + cssBodyOf(bundle) + '`;')(0.45, 0.59);
function moduleText(name) {
  const start = bundle.indexOf('// ── 内联模块：src/' + name + '.js');
  if (start < 0) return '';
  const end = bundle.indexOf('// ── 内联模块：', start + 10);
  return bundle.slice(bundle.indexOf('\n', start), end < 0 ? bundle.length : end);
}
const runtime = moduleText('glass-surfaces');
const extra = moduleText('glass-extra');
const out = resolve('.artifacts/glass-runtime');
mkdirSync(out, { recursive: true });
const browsers = process.platform === 'win32'
  ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
  : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const browser = process.env.WE_TEST_BROWSER || browsers.find(existsSync);
assert.ok(browser && existsSync(browser), '缺少 Chromium 浏览器；请用 WE_TEST_BROWSER 指定可执行文件，浏览器回归不会跳过。');
const profile = mkdtempSync(join(out, 'profile-'));
const child = spawn(browser, [
  '--headless=new', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' });
let socket, launchError, counter = 0;
const pending = new Map(), failures = [], report = [];
child.on('error', error => { launchError = error; });
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++counter;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await delay(25);
  }
  throw Error('等待条件失败: ' + expression);
}
function check(name, passed, detail) {
  report.push({ name, passed, detail });
  if (!passed) failures.push(name + ': ' + JSON.stringify(detail));
  console.log((passed ? 'PASS' : 'FAIL') + ' | ' + name);
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(out, name + '.png'), Buffer.from(data, 'base64'));
  return data;
}
try {
  let port;
  const deadline = Date.now() + 20000;
  while (!port && Date.now() < deadline) {
    if (launchError) throw launchError;
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); }
    catch (error) { if (!['ENOENT', 'EBUSY'].includes(error.code)) throw error; }
    if (!port) await delay(100);
  }
  assert.ok(port, '浏览器调试端口未就绪');
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const event = JSON.parse(data), item = pending.get(event.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(event.id);
    if (event.error) item.reject(Error(JSON.stringify(event.error))); else item.resolve(event.result);
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  for (const width of [320, 375, 414, 768, 1280]) for (const dark of [false, true]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 820, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'about:blank' });
    await until('document.readyState === "complete"');
    await evaluate(`(() => {
      document.documentElement.style.cssText='background:white';
      document.body.innerHTML='<div id="wall"></div><main id="app"><div id="left"><div data-slot="sidebar"><span>Sidebar</span><div id="modal" role="dialog" aria-modal="true"><section id="dialog-panel"><button id="modal-close">Close</button></section></div></div></div><section id="main"><button id="composer">Composer</button></section></main><aside id="right" data-sidebar-right-panel="push" data-sidebar-right-open><div data-dockkit-host="dock">Dock</div></aside><div id="unknown" class="extra"></div>';
      const fixture=document.createElement('style');fixture.textContent=
        'body{margin:0;font:16px sans-serif;--we-readability-base:${dark ? '#151515' : '#ffffff'};--we-readability-floor:${dark ? '0.59' : '0.45'};--we-left-sidebar-alpha:.12;--we-left-sidebar-blur:14px;--we-sidebar-blur:14px;--we-sidebar-saturate:1.3;--we-sidebar-color:${dark ? '#151515' : '#ffffff'};--we-sidebar-tint:20%;--we-panel-color:${dark ? '#151515' : '#ffffff'};--we-panel-sheen-a:.1;--we-panel-sheen-b:.03;--we-panel-sheen-c:.05;--we-sidebar-sheen-a:.1;--we-sidebar-sheen-b:.03;--we-sidebar-sheen-c:.05;--we-sidebar-sheen:1;--we-blur:14px}' +
        '#wall{position:fixed;inset:0;z-index:-2;background:repeating-linear-gradient(90deg,#244f46 0 4px,#e6b929 4px 8px)}#app{display:flex;height:820px}#left{width:30%;height:100%;background:transparent}#main{flex:1;position:relative;z-index:1}#composer{position:fixed;left:38vw;top:150px;width:58vw;height:220px;background:#128a4d;border:0;z-index:10}#modal{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.25)}#dialog-panel{position:fixed;left:38vw;top:150px;width:58vw;height:220px;background:#b32235}#modal-close{position:absolute;left:12px;top:12px;width:90px;height:38px}#right{position:fixed;right:0;bottom:0;width:25%;height:180px}#unknown{position:fixed;left:10px;bottom:10px;width:30px;height:30px;z-index:20;background:#57a0e0}';
      document.head.append(fixture);
      const style=document.createElement('style');style.dataset.testBundle='on';style.textContent=${JSON.stringify(css)};document.head.append(style);
      document.body.setAttribute('data-we-glass-page','on');document.body.setAttribute('data-we-left-sidebar','on');document.body.setAttribute('data-we-sidebar-glass','on');
      ${dark ? "document.body.setAttribute('data-ds-dark-theme','');" : ''}
      window.__selection={leftSidebarGlass:true,sidebarGlass:true,extraGlassSelectors:'.extra'};
      window.__clicks={modal:0,composer:0};document.querySelector('#modal-close').onclick=()=>__clicks.modal++;document.querySelector('#composer').onclick=()=>__clicks.composer++;
      window.__frames=0;const raf=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=(callback)=>{__frames++;return raf(callback);};
      const sanitizeExtraGlassSelectors=value=>typeof value==='string' && /^\.[a-z]+$/.test(value)?value:'';
      ${runtime}\n${extra}
      window.__glass={sync:()=>syncExtraGlassCss(__selection),dispose:()=>disposeExtraGlassCss(),status:()=>typeof weGlassSurfaceStatus==='function'?weGlassSurfaceStatus():[]};
      __glass.sync();
      return true;
    })()`);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const tag = (dark ? 'dark-' : 'light-') + width;
    const state = await evaluate(`(() => {
      const el=document.querySelector('#modal-close'), rect=el.getBoundingClientRect(), left=getComputedStyle(document.querySelector('#left'));
      el.focus();return {hit:document.elementFromPoint(rect.x+20,rect.y+20)?.id,rect:rect.toJSON(),focus:document.activeElement.id,left:{z:left.zIndex,position:left.position,blur:left.backdropFilter},plates:document.querySelectorAll('[data-we-surface-plate]').length,status:__glass.status(),x:rect.x+20,y:rect.y+20};
    })()`);
    check(tag + ' 模态命中与fixed包含块', state.hit === 'modal-close' && state.left.z === 'auto' && state.left.blur === 'none' && Math.abs(state.rect.x - (width * .38 + 12)) < 1 && state.focus === 'modal-close', state);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: state.x, y: state.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: state.x, y: state.y, button: 'left', clickCount: 1 });
    check(tag + ' 点击未穿透到composer', await evaluate('__clicks.modal===1 && __clicks.composer===0'), await evaluate('__clicks'));
    const shot = await screenshot(tag);
    const pixel = await evaluate(`(async()=>{const image=new Image();image.src='data:image/png;base64,${shot}';await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return [...ctx.getImageData(Math.round(innerWidth*.65),300,1,1).data];})()`);
    check(tag + ' 模态像素未被底层输入区覆盖', pixel[0] > 120 && pixel[0] > pixel[1] * 2, pixel);
    if (runtime) {
      await evaluate("document.querySelector('#modal').remove();__glass.sync()");
      await until('document.querySelectorAll("[data-we-surface-plate]").length>=1');
      check(tag + ' 安全侧栏玻璃实际载体存在', await evaluate(`(()=>{const plate=document.querySelector('[data-we-surface-plate="left-sidebar"]');return !!plate && getComputedStyle(plate).backdropFilter.includes('blur(') && plate.children.length===0 && plate.getBoundingClientRect().width>20;})()`));
      await evaluate("document.querySelector('#left').style.width='25%'");
      await until('Math.abs(document.querySelector("[data-we-surface-plate=left-sidebar]").getBoundingClientRect().width-document.querySelector("#left").getBoundingClientRect().width)<1');
      await evaluate("document.querySelector('#right').removeAttribute('data-sidebar-right-open')");
      await until('!document.querySelector("[data-we-surface-plate=right-sidebar]")');
      check(tag + ' 收起右栏无残板', true);
      await evaluate("document.body.setAttribute('data-we-glass-fallback','on')");
      await until('getComputedStyle(document.querySelector("[data-we-surface-plate=left-sidebar]")).backdropFilter==="none"');
      check(tag + ' 软件回退不留下模糊', true);
      await evaluate("document.body.removeAttribute('data-we-glass-fallback');document.querySelector('#unknown').setAttribute('data-we-surface-preserve','')");
      await until('!document.querySelector("#unknown").hasAttribute("data-we-surface-runtime")');
      check(tag + ' preserve声明撤销额外载体', await evaluate('getComputedStyle(document.querySelector("#unknown")).backgroundColor==="rgb(87, 160, 224)"'));
      await evaluate("document.querySelector('#unknown').removeAttribute('data-we-surface-preserve');__glass.sync();__glass.sync()");
      check(tag + ' 额外载体重复同步仍由同一所有者管理', await evaluate(`document.querySelector('#unknown').getAttribute('data-we-surface-runtime')==='extra' && getComputedStyle(document.querySelector('#unknown'),'::before').backdropFilter.includes('blur(')`));
      await evaluate("document.querySelector('#unknown').style.zIndex='auto';__glass.sync()");
      check(tag + ' 未知且无安全上下文目标完整保留原生', await evaluate(`!document.querySelector('#unknown').hasAttribute('data-we-surface-runtime') && getComputedStyle(document.querySelector('#unknown'),'::before').content==='none' && getComputedStyle(document.querySelector('#unknown')).backgroundColor==='rgb(87, 160, 224)'`));
      await evaluate("document.querySelector('#unknown').style.zIndex='20';document.querySelector('#unknown').style.setProperty('--occupied-content','1');const tag=document.createElement('style');tag.id='occupied';tag.textContent='#unknown::before{content:\"native\"}';document.head.append(tag);__glass.sync()");
      check(tag + ' 已有伪元素不被额外雾化覆盖', await evaluate(`!document.querySelector('#unknown').hasAttribute('data-we-surface-runtime') && getComputedStyle(document.querySelector('#unknown'),'::before').content==='"native"'`));
      await evaluate("document.querySelector('#occupied').remove();__selection.glassSurfacePolicy={'left-sidebar':'native'};__glass.sync()");
      check(tag + ' 单面原生策略撤销绘制和所有权', await evaluate(`!document.querySelector('[data-we-surface-plate="left-sidebar"]') && !document.querySelector('#left').hasAttribute('data-we-surface-runtime')`));
      await evaluate("__selection.glassSurfacePolicy={};document.querySelector('#app').style.transform='translateX(1px)';__glass.sync()");
      check(tag + ' 变换祖先回退原生不在错误坐标画底板', await evaluate(`!document.querySelector('[data-we-surface-plate="left-sidebar"]') && !document.querySelector('#left').hasAttribute('data-we-surface-runtime')`));
      await evaluate("document.querySelector('#app').style.transform='none';document.querySelector('#app').setAttribute('data-we-surface-preserve','');__glass.sync()");
      check(tag + ' 祖先preserve声明优先于内建适配器', await evaluate(`!document.querySelector('#left').hasAttribute('data-we-surface-runtime')`));
      await evaluate("document.querySelector('#app').removeAttribute('data-we-surface-preserve');__glass.sync()");
      await until('!!document.querySelector("[data-we-surface-plate=left-sidebar]")');
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
      await evaluate('window.__steadyFrames=__frames');
      await delay(150);
      check(tag + ' 静止不持续安排帧扫描', await evaluate('__frames===__steadyFrames'), await evaluate('({frames:__frames,steady:__steadyFrames})'));
      await evaluate(`document.querySelector('#left').style.zIndex='0';document.querySelector('#left').style.position='relative';document.querySelector('#left').innerHTML='<div data-slot="sidebar"><div id="negative" style="position:fixed;inset:0;z-index:1000;background:#b32235"></div></div>'`);
      check(tag + ' 种回旧围栏的负对照能失败', await evaluate('document.elementFromPoint(innerWidth*.65,300).id==="composer"'));
      await evaluate('__glass.dispose()');
      check(tag + ' 卸载成对清理', await evaluate('document.querySelectorAll("[data-we-surface-plate],[data-we-surface-runtime],[data-we-surface-root]").length===0'));
      await evaluate('window.__endFrames=__frames;document.body.append(document.createElement("section"))');
      await delay(100);
      check(tag + ' 卸载后无监听残留更新', await evaluate('__frames===__endFrames'));
    }
    await evaluate(`(() => {
      document.body.innerHTML='<div id="wall"></div><section id="settings" role="dialog" aria-modal="true"><div data-slot="settings.section" id="settings-layout"><section id="plugin-native"><button id="native-button">Native</button><div id="warning">Warning</div></section><section id="declared" data-we-surface="v1"><div data-we-surface-layout id="layout">Layout<div data-we-surface-preserve id="keep">Preserve<div data-we-surface-layout id="preserve-child">Keep</div></div><section data-we-surface="v1" id="nested"><div data-we-surface-layout id="nested-layout">Nested</div></section></div></section><button id="nested-modal" style="position:fixed;left:10px;top:20px;z-index:1001">Nested</button></div></section><aside data-sidebar-right-panel="push" data-sidebar-right-open id="content-dock"><div class="cm-editor" id="editor"><span id="syntax" style="color:rgb(197,104,228)">Syntax</span><div class="cm-selectionBackground" id="selection"></div></div><div id="preview" data-we-surface="v1"><div data-we-surface-layout>Preview</div></div></aside><button class="we-rope" id="rope">Rope</button><div class="we-update-notice" id="notice">Notice</div><div class="we-preset-intro" id="intro">Intro</div>';
      const fixture=document.createElement('style');fixture.id='compat-fixture';fixture.textContent=
        'body{--dsw-alias-bg-layer-1:rgb(246,246,246);--dsw-alias-bg-layer-2:rgb(241,242,243);--dsw-alias-bg-layer-3:rgb(225,226,227);--dsw-alias-label-primary:#151515;--we-settings-window-blur:14px;--we-settings-window-alpha:.15}' +
        '#settings{position:fixed;z-index:1000;left:5vw;top:100px;width:90vw;height:500px;overflow:auto;background:var(--dsw-alias-bg-layer-2)}#settings-layout{background:var(--dsw-alias-bg-layer-1)}#plugin-native{background:#fff}#native-button{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}#warning{background:rgb(244,180,40)}#declared{position:relative;z-index:1;background:white}#layout,#keep,#preserve-child,#nested-layout{background:rgb(222,223,224)}#content-dock{position:fixed;bottom:0;right:0;width:40vw;height:150px}#editor{background:#fff;height:80px}#selection{background:rgb(60,80,160);height:8px}#rope{left:10px;top:20px}#notice{bottom:30px;left:40px}#intro{bottom:100px;left:10px}';
      document.head.append(fixture);document.body.setAttribute('data-we-glass-window','on');document.body.setAttribute('data-we-glass-floaters','on');
      document.querySelector('#plugin-native').className='thirdparty_root';document.querySelector('#warning').className='thirdparty_frame';
      const host=document.createElement('div');host.id='root';host.innerHTML='<div class="host_frame" id="host-frame"><div class="host_root" id="host-root"></div></div>';document.body.append(host);
      document.querySelector('#host-frame').style.background='rgb(20,30,40)';document.querySelector('#host-root').style.background='rgb(30,40,50)';
      document.body.setAttribute('data-we-wallpaper','on');document.body.setAttribute('data-we-adapter','browser');
      __selection={sidebarGlass:true};__glass.sync();return true;
    })()`);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const compat = await evaluate(`(()=>{const s=id=>getComputedStyle(document.getElementById(id));const r=document.querySelector('#nested-modal').getBoundingClientRect();return {blur:s('settings').backdropFilter,rect:r.toJSON(),token:s('native-button').color,unknown:s('plugin-native').backgroundColor,warning:s('warning').backgroundColor,mark:document.querySelector('#settings').getAttribute('data-we-surface-runtime'),layout:s('layout').backgroundColor,keep:s('keep').backgroundColor,child:s('preserve-child').backgroundColor,syntax:s('syntax').color,selection:s('selection').backgroundColor,editor:s('editor').backgroundColor,rope:s('rope').visibility,notice:s('notice').visibility,intro:s('intro').visibility,status:__glass.status()};})()`);
    check(tag+' 设置本体不再建立fixed包含块', compat.blur==='none' && compat.rect.x===10 && compat.rect.y===20, compat);
    check(tag+' 未知设置控件令牌与状态填充保留原生',compat.token==='rgb(225, 226, 227)' && compat.unknown==='rgb(255, 255, 255)' && compat.warning==='rgb(244, 180, 40)',compat);
    check(tag+' 壁纸仅清宿主外壳而非任意root和frame',await evaluate(`getComputedStyle(document.querySelector('#host-frame')).backgroundColor==='rgba(0, 0, 0, 0)' && getComputedStyle(document.querySelector('#host-root')).backgroundColor==='rgba(0, 0, 0, 0)'`));
    check(tag+' 已知设置面与显式布局接管且preserve优先',compat.mark==='settings-window' && compat.layout==='rgba(0, 0, 0, 0)' && compat.keep==='rgb(222, 223, 224)' && compat.child==='rgb(222, 223, 224)',compat);
    check(tag+' 编辑内容底板受控且语法选区不改',compat.editor!=='rgb(255, 255, 255)' && compat.syntax==='rgb(197, 104, 228)' && compat.selection==='rgb(60, 80, 160)',compat);
    check(tag+' 可见外部模态时自有装饰和自动提示让路',compat.rope==='hidden' && compat.notice==='hidden' && compat.intro==='hidden',compat);
    await evaluate("document.querySelector('#keep').removeAttribute('data-we-surface-preserve')");
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    check(tag+' 移除非布局preserve包装自动接管子布局',await evaluate("getComputedStyle(document.querySelector('#preserve-child')).backgroundColor==='rgba(0, 0, 0, 0)'"));
    await evaluate("document.querySelector('#keep').setAttribute('data-we-surface-preserve','')");
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    check(tag+' 恢复preserve包装自动撤回子布局',await evaluate("getComputedStyle(document.querySelector('#preserve-child')).backgroundColor==='rgb(222, 223, 224)'"));
    await evaluate("document.querySelector('#settings-layout').style.minHeight='1000px';document.querySelector('#settings').scrollTop=120;document.querySelector('#settings').style.width='80vw'");
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    check(tag+' 滚动缩放设置窗不拖动fixed子弹层',await evaluate("(()=>{const r=document.querySelector('#nested-modal').getBoundingClientRect();return document.querySelector('#settings').scrollTop===120 && r.x===10 && r.y===20 && getComputedStyle(document.querySelector('#settings')).backdropFilter==='none';})()"));
    await evaluate("document.querySelector('#nested-modal').focus();window.__modalClicks=0;document.querySelector('#nested-modal').onclick=()=>window.__modalClicks++");
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:20,y:30,button:'left',clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:20,y:30,button:'left',clickCount:1});
    check(tag+' 设置子弹层保持焦点和真实点击',await evaluate("document.activeElement.id==='nested-modal' && document.elementFromPoint(20,30).id==='nested-modal' && __modalClicks===1"));
    await evaluate("document.querySelector('#settings').scrollTop=0;document.querySelector('#settings-layout').style.minHeight='';document.querySelector('#settings').style.width='90vw'");
    await screenshot(tag+'-settings-owned');
    await evaluate("__selection.glassSurfacePolicy={'settings-window':'native',content:'native',declared:'native'};__glass.sync()");
    check(tag+' 逐面原生撤销设置布局和内容接管',await evaluate(`!document.querySelector('#settings').hasAttribute('data-we-surface-runtime') && getComputedStyle(document.querySelector('#settings')).backgroundColor==='rgb(241, 242, 243)' && getComputedStyle(document.querySelector('#editor')).backgroundColor==='rgb(255, 255, 255)' && getComputedStyle(document.querySelector('#layout')).backgroundColor==='rgb(222, 223, 224)'`));
    await evaluate("__selection.glassSurfacePolicy={};document.querySelector('#settings').remove();__glass.sync()");
    check(tag+' 模态卸载后浮层恢复',await evaluate("getComputedStyle(document.querySelector('#rope')).visibility==='visible'"));
    await evaluate("const el=document.createElement('div');el.setAttribute('role','dialog');el.style.cssText='width:20px;height:20px';document.body.append(el);__glass.sync()");
    check(tag+' 无模态语义的普通dialog不压制WE',await evaluate("getComputedStyle(document.querySelector('#rope')).visibility==='visible'"));
    await evaluate("document.querySelector('#editor').setAttribute('data-we-surface-preserve','');__glass.sync()");
    check(tag+' 内容preserve恢复原生画布',await evaluate("getComputedStyle(document.querySelector('#editor')).backgroundColor==='rgb(255, 255, 255)'"));
    await screenshot(tag+'-settings');
    await evaluate('__glass.dispose()');
    check(tag+' 第二阶段卸载清理',await evaluate('document.querySelectorAll("[data-we-surface-runtime],[data-we-layout-runtime],[data-we-modal-blocked]").length===0'));
  }
  writeFileSync(join(out, 'report.json'), JSON.stringify({ bundleBytes: Buffer.byteLength(bundle), report, failures }, null, 2));
  assert.equal(failures.length, 0, failures.join('\n'));
} finally {
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('browser closing')); }
  pending.clear();
  if (socket?.readyState===WebSocket.OPEN) { try { await send('Browser.close'); } catch { /* 关闭连接亦视为结束 */ } }
  socket?.close();
  if (child.exitCode===null) {
    const exit = new Promise(resolve=>{ child.once('exit',resolve); });
    child.kill(); await exit;
  }
}
