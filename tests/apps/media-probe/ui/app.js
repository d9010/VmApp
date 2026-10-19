'use strict';
// The page's code does ordinary web things: it sets src, sets styles, inserts rules, makes shadow roots. It never mentions the bridge.
// window.probe is only a handle for the test to do those ordinary things at the moments it chooses.
const $ = (id) => document.getElementById(id);

// a picture with the page's own fallback, as real apps have: onerror shows a placeholder. It must NOT run for a picture that is fine.
const fallback = new Image();
fallback.id = 'fallback';
fallback.addEventListener('error', () => window.__events.fallbackError++);
fallback.addEventListener('load', () => window.__events.fallbackLoad++);
fallback.src = '/assets/pixel.png';
document.getElementById('dynamic').append(fallback);

// a picture that really is missing: its onerror must run exactly once
$('missing').addEventListener('error', () => window.__events.missingError++);

// an icon set the way a toolbar does it: from script, on an element's style
$('inline-two').style.backgroundImage = 'url(/assets/pixel2.png)';

window.probe = {
  addImg(id, src) {
    const i = new Image();
    i.id = id;
    i.src = src;
    $('dynamic').append(i);
    return id;
  },
  setSrc(id, src) {
    $(id).src = src;
  },
  addDiv(id) {
    const d = document.createElement('div');
    d.id = id;
    d.className = 'box';
    d.textContent = id;
    $('dynamic').append(d);
    return id;
  },
  setStyle(id, prop, value) {
    $(id).style.setProperty(prop, value);
  },
  setStyleAttr(id, css) {
    $(id).style.cssText = css;
  },
  insertRule(selector, body) {
    let style = document.getElementById('runtime-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'runtime-style';
      document.head.append(style);
    }
    style.sheet.insertRule(`${selector} { ${body} }`, style.sheet.cssRules.length);
  },
  styleText(css) {
    const s = document.createElement('style');
    s.textContent = css;
    document.head.append(s);
  },
  constructable(css) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  },
  async constructableAsync(css) {
    const sheet = new CSSStyleSheet();
    await sheet.replace(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  },
  shadow(id) {
    const host = document.createElement('div');
    host.id = id;
    $('dynamic').append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>.sx { width: 40px; height: 20px; background-image: url(/assets/pixel.png); display: inline-block; }</style>
      <div class="sx" id="sx"></div><img id="simg" src="/assets/icon.svg" alt="in a shadow root"><div id="sinline" style="width:20px;height:20px;background-image:url(/assets/pixel2.png)"></div>`;
    return id;
  },
  addLink(href) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    $('dynamic').append(l);
  },
  addAudio(id, src) {
    const a = document.createElement('audio');
    a.id = id;
    a.preload = 'auto';
    a.src = src;
    $('dynamic').append(a);
  },
  stats: () => fetch('/assets/stats').then((r) => r.json()),
  // everything below only reads
  imgInfo(id) {
    const i = $(id) || (document.getElementById('shadow-host') && document.getElementById('shadow-host').shadowRoot.getElementById(id));
    if (!i) return null;
    return { src: (i.getAttribute('src') || '').slice(0, 24), srcset: (i.getAttribute('srcset') || '').slice(0, 40), complete: i.complete, w: i.naturalWidth, h: i.naturalHeight };
  },
};
