import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../lib/settings-schema.js';
import { styleSources, cssBodyOf } from './tools/src-scope.mjs';
import { stripExportBlocks } from './tools/js-text.mjs';

// Serve the real source. Drive this fixture through the official browser-use API.
const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = process.argv.includes('--baseline');
const source = file => baseline
  ? execFileSync('git', ['-C', root, 'show', '5f87e698:' + file], { encoding: 'utf8' })
  : readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const css = new Function('READABILITY_FLOOR', 'READABILITY_FLOOR_DARK',
  'return `' + cssBodyOf(styleSources().map(source).join('\n')) + '`;')(0.45, 0.59);
const runtime = ['src/effects.js', 'src/glass.js', 'src/glass-extra.js'].map(file => stripExportBlocks(source(file))).join('\n');
const artifacts = new URL('../.artifacts/glass-' + (baseline ? 'baseline' : 'fixed') + '/', import.meta.url);
mkdirSync(artifacts, { recursive: true });
const fixtureCss = `
html{background:white}body{margin:0;font:14px sans-serif;--we-blur:14px;--we-saturate:1.3;--we-glass-alpha:.15;--we-glass-fidelity:1;--we-panel-color:#fff;--we-surface-tint-light:#fff;--we-surface-tint-dark:#0d1524}
#wall{position:fixed;inset:0;z-index:-2;background:repeating-linear-gradient(90deg,#244f46 0 4px,#e6b929 4px 8px)}
#fixture{display:flex;height:700px}#left{width:30%;height:100%}#left-slot{display:contents}
#center{flex:1;position:relative;z-index:1}#composer{position:fixed;left:38vw;top:150px;width:58vw;height:220px;background:#128a4d;z-index:10}
#modal{position:fixed;inset:0;z-index:1000}#modal-close{position:fixed;left:40vw;top:180px;width:90px;height:38px}
#right{position:absolute;right:0;top:480px;width:30%;height:180px;--dsh-dockkit-dock-layer:40}
#settings{position:fixed;z-index:1000;left:20vw;top:100px;width:60vw;height:400px;background:var(--dsw-alias-bg-layer-2)}
#fixed-child{position:fixed;left:7px;top:11px}#legacy{position:fixed;left:40vw;top:440px;width:45vw;height:160px;z-index:25}
#legacy-panel{position:absolute;inset:0;z-index:40;background:var(--dsw-alias-bg-layer-1)}#legacy-pane{background:var(--dsw-alias-bg-base);height:100%}.cm-editor{height:35px}
#controls,#results{position:fixed;left:0;bottom:0;padding:8px;background:white;z-index:10000}#results{top:0;bottom:auto;max-height:90px;overflow:auto;font:11px monospace}
`;
function browserTest(window, document, selection, applyGlass, syncExtraGlassCss, disposeExtraGlassCss, clearEffects) {
  const { requestAnimationFrame, getComputedStyle } = window;
  const target = document.getElementById('fixture');
  const frames = () => new Promise(resolve => { requestAnimationFrame(() => { requestAnimationFrame(resolve); }); });
  const styles = (id, pseudo) => getComputedStyle(document.getElementById(id), pseudo);
  const check = (name, ok, detail) => window.glassResults.push({ name, ok: !!ok, detail });
  function setup(html) {
    disposeExtraGlassCss(); target.innerHTML = html;
    Object.assign(selection, { leftSidebarGlass: true, sidebarGlass: true, sidebarFullClear: false, extraGlassSelectors: '' });
    applyGlass(selection, document.body.style);
    document.body.setAttribute('data-we-wallpaper', 'on'); syncExtraGlassCss(selection);
  }
  window.glassResults = [];
  document.getElementById('run').onclick = async () => {
    window.glassResults = [];
    setup('<div id="left"><div id="left-slot" data-slot="sidebar"><div id="modal" role="dialog" aria-modal="true"><button id="modal-close">Modal close</button></div></div></div><section id="center"><button id="composer">Composer</button></section>');
    await frames();
    const button = document.getElementById('modal-close');
    let rect = button.getBoundingClientRect();
    check('left modal remains above composer', document.elementFromPoint(rect.x + 10, rect.y + 10) === button,
      { hit: document.elementFromPoint(rect.x + 10, rect.y + 10)?.id });
    check('left host keeps native stacking', styles('left').zIndex === 'auto' && styles('left').backdropFilter === 'none',
      { z: styles('left').zIndex, blur: styles('left').backdropFilter });
    setup('<div id="settings" role="dialog"><div data-slot="settings.section"><button id="fixed-child">Fixed settings child</button></div></div>');
    await frames(); rect = document.getElementById('fixed-child').getBoundingClientRect();
    check('settings fixed child stays viewport anchored', Math.abs(rect.x - 7) < .5 && Math.abs(rect.y - 11) < .5,
      { x: rect.x, y: rect.y });
    check('settings host has no filter', styles('settings').backdropFilter === 'none', styles('settings').backdropFilter);
    check('settings recipe reaches real descendants', styles('fixed-child').getPropertyValue('--dsw-alias-bg-layer-2').includes('color'));
    setup('<section id="center"><button id="composer">Composer</button></section><aside id="right" data-sidebar-right-panel="fullscreen" data-sidebar-right-open><div data-dockkit-host="dock" style="position:relative;z-index:40"><button id="fixed-child">Fixed dock child</button></div></aside>');
    await frames(); rect = document.getElementById('fixed-child').getBoundingClientRect();
    check('fullscreen fixed child stays viewport anchored', Math.abs(rect.x - 7) < .5 && Math.abs(rect.y - 11) < .5,
      { x: rect.x, y: rect.y });
    check('fullscreen host retains native z-index', styles('right').zIndex === 'auto' && styles('right').backdropFilter === 'none',
      { z: styles('right').zIndex, blur: styles('right').backdropFilter });
    for (const mode of ['push', 'fullscreen']) {
      const panel = document.getElementById('right'); panel.setAttribute('data-sidebar-right-panel', mode);
      panel.style.top = '150px'; panel.style.left = '38vw'; panel.style.height = '220px'; await frames();
      const dock = panel.querySelector('[data-dockkit-host]');
      dock.style.height = '100%'; rect = dock.getBoundingClientRect();
      check(mode + ' dock remains above overlapping composer', document.elementFromPoint(rect.x + 20, rect.y + 100) === dock);
      document.body.setAttribute('data-we-glass-fallback', '1'); await frames();
      check(mode + ' software fallback disables decorative frost', styles('right', '::before').backdropFilter === 'none');
      document.body.removeAttribute('data-we-glass-fallback');
    }
    document.body.setAttribute('data-we-sidebar-fullclear', 'on'); await frames();
    const clearFill = value => value === 'rgba(0, 0, 0, 0)' || /\/\s*0\s*\)$/.test(value);
    check('fullclear clears the real right decorative plate', clearFill(styles('right', '::before').backgroundColor)
      && styles('right', '::before').backgroundImage === 'none', styles('right', '::before').backgroundColor);
    document.body.removeAttribute('data-we-sidebar-glass'); await frames();
    check('fullclear also clears root when sidebar glass is off', clearFill(styles('right').backgroundColor), styles('right').backgroundColor);
    document.body.setAttribute('data-we-sidebar-glass', 'on');
    document.body.setAttribute('data-we-glass-fallback', '1'); await frames();
    check('software fullclear keeps real plate clear and frost off', clearFill(styles('right', '::before').backgroundColor)
      && styles('right', '::before').backdropFilter === 'none');
    document.body.removeAttribute('data-we-glass-fallback'); document.body.removeAttribute('data-we-wallpaper'); await frames();
    check('fullclear without wallpaper retains readable plate', !clearFill(styles('right', '::before').backgroundColor));
    document.body.removeAttribute('data-we-sidebar-fullclear'); document.body.setAttribute('data-we-wallpaper', 'on');
    document.getElementById('right').removeAttribute('data-sidebar-right-open'); await frames();
    check('closed right sidebar has no plate', !document.querySelector('[data-we-glass-plate="right"]') && styles('right', '::before').content === 'none');
    setup('<div id="legacy" data-dsh-better-sidebar><section id="legacy-panel" class="test_panel_hash" data-dsh-panel><div class="test_pane_hash" id="legacy-pane"><div class="cm-editor" id="editor">Editor</div><div class="test_panelControls_hash" id="unknown-inner">Controls</div></div></section></div>');
    await frames();
    check('legacy panel frost is decorative only', styles('legacy-panel').backdropFilter === 'none'
      && styles('legacy-panel', '::before').backdropFilter.includes('blur('),
    { own: styles('legacy-panel').backdropFilter, pseudo: styles('legacy-panel', '::before').backdropFilter });
    check('legacy pane does not paint another glass floor', styles('legacy-pane').backgroundColor === 'rgba(0, 0, 0, 0)', styles('legacy-pane').backgroundColor);
    check('unknown legacy panel suffix is untouched', styles('unknown-inner').backdropFilter === 'none', styles('unknown-inner').backdropFilter);
    check('editor retains readable content plate', styles('editor').backgroundColor !== 'rgba(0, 0, 0, 0)', styles('editor').backgroundColor);
    document.getElementById('legacy-panel').style.contain = 'layout style'; await frames();
    check('legacy layout style containment does not remove frost', styles('legacy-panel', '::before').backdropFilter.includes('blur('));
    document.getElementById('legacy-panel').style.visibility = 'hidden'; await frames();
    check('hidden legacy decorative leaf follows native visibility', styles('legacy-panel', '::before').visibility === 'hidden');
    document.getElementById('legacy-panel').style.visibility = '';
    document.body.setAttribute('data-we-glass-fallback', '1'); await frames();
    check('legacy fallback disables decorative frost', styles('legacy-panel', '::before').backdropFilter === 'none');
    document.body.removeAttribute('data-we-glass-fallback');
    disposeExtraGlassCss(); clearEffects(); await frames();
    check('dispose leaves no ownership or plates', !document.querySelector('[data-we-glass-ready],[data-we-glass-plate]'));
    check('dispose restores native legacy panel and pane', styles('legacy-panel', '::before').content === 'none'
      && styles('legacy-pane').backgroundColor === 'rgba(0, 0, 0, 0)');
    await window.fetch('/report?name=' + (document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light') + '-' + window.innerWidth,
      { method: 'POST', body: JSON.stringify(window.glassResults, null, 2) });
    document.getElementById('results').textContent = window.glassResults.map(result => (result.ok ? 'PASS ' : 'FAIL ') + result.name).join(' | ');
  };
  document.getElementById('stripes').onclick = async () => {
    const probes = [
      '<div id="left"><div data-slot="sidebar">Left sidebar</div></div>',
      '<div id="settings" role="dialog"><div data-slot="settings.section">Settings</div></div>',
      '<aside id="right" data-sidebar-right-panel="push" data-sidebar-right-open><div data-dockkit-host="dock" style="position:relative;z-index:40">Dock push</div></aside>',
      '<aside id="right" data-sidebar-right-panel="fullscreen" data-sidebar-right-open><div data-dockkit-host="dock" style="position:relative;z-index:40">Dock fullscreen</div></aside>',
      '<div id="legacy" data-dsh-better-sidebar><section id="legacy-panel" data-dsh-panel class="test_panel_hash"><div id="legacy-pane" class="test_pane_hash">Legacy</div></section></div>',
    ];
    window.glassProbe = (window.glassProbe ?? -1) + 1;
    window.glassProbe %= probes.length;
    setup(probes[window.glassProbe]); await frames();
    window.glassProbeRegion = window.glassProbe === 0 ? { x: 8, y: 120, width: Math.floor(window.innerWidth * .25) - 16, height: 2 }
      : window.glassProbe === 1 ? { x: Math.floor(window.innerWidth * .25), y: 220, width: Math.floor(window.innerWidth * .4), height: 2 }
        : window.glassProbe < 4 ? { x: Math.floor(window.innerWidth * .75), y: 550, width: Math.floor(window.innerWidth * .2), height: 2 }
          : { x: Math.floor(window.innerWidth * .45), y: 530, width: Math.floor(window.innerWidth * .3), height: 2 };
    document.getElementById('results').textContent = 'Stripe probe frost on';
  };
  document.getElementById('blur').onclick = () => {
    let tag = document.getElementById('negative-blur');
    if (tag) tag.remove();
    else {
      tag = document.createElement('style'); tag.id = 'negative-blur';
      tag.textContent = '[data-we-glass-plate],#left,#left::before,#settings,#settings::before,#right,#right::before,#legacy-panel,#legacy-panel::before{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';
      document.head.append(tag);
    }
    document.getElementById('results').textContent = 'Stripe probe frost ' + (tag.isConnected ? 'off' : 'on');
  };
  document.getElementById('theme').onclick = () => document.body.toggleAttribute('data-ds-dark-theme');
}
const html = '<!doctype html><html><head><meta charset="utf-8"><title>Glass '+(baseline?'baseline':'working tree')+'</title><style>'+css+'</style><style>'+fixtureCss+'</style></head><body><div id="wall"></div><main id="fixture"></main><output id="results">Not run</output><nav id="controls"><button id="run">Run behavior checks</button><button id="stripes">Show stripe probe</button><button id="blur">Toggle probe frost</button><button id="theme">Toggle theme</button></nav><script>const selection='+JSON.stringify(DEFAULTS)+';const sanitizeExtraGlassSelectors=v=>typeof v==="string"?v:"";const removeFontStyles=()=>{},clearUnderlayColor=()=>{},syncSceneAudio=()=>{};const SCRIM_ID="unused";'+runtime+'\n('+browserTest.toString()+')(window,document,selection,applyGlass,syncExtraGlassCss,disposeExtraGlassCss,clearEffects);</script></body></html>';
const server = createServer(async (req, res) => {
  if (req.method === 'POST' && /^\/(report|capture)\?name=[a-z0-9-]+$/.test(req.url)) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const name = req.url.split('=')[1];
    const image = req.url.startsWith('/capture');
    writeFileSync(new URL(name + (image ? '.png' : '.json'), artifacts), image ? Buffer.from(body, 'base64') : body);
    res.writeHead(200); res.end('saved'); return;
  }
  if (req.url !== '/') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
});
server.listen(Number(process.env.WE_GLASS_TEST_PORT||0),'127.0.0.1',()=>console.log('Glass fixture: http://127.0.0.1:'+server.address().port+'/'));
