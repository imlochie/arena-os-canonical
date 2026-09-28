// Shared offline game shell: wraps every generated game in a complete
// single-file HTML doc. No external assets, no network. Canvas + HUD +
// overlays + keyboard/touch/dpad controls + safe storage helpers.

export interface ShellOpts {
  title: string;
  tagline?: string;
  width: number;
  height: number;
  accent?: string;
  js: string; // game javascript (plain quotes only: no backticks, no ${})
  help?: string[];
  actionLabel?: string;
}

export function gameShell(o: ShellOpts): string {
  const accent = o.accent ?? "#8b5cf6";
  const help = (o.help ?? ["Arrows / WASD — move", "P — pause · M — sound · R — restart"]).join(" · ");
  const actionLabel = o.actionLabel ?? "●";

  return (
    "<!DOCTYPE html>\n" +
    '<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">\n' +
    "<title>" + o.title + "</title>\n<style>\n" +
    "*{box-sizing:border-box;margin:0;padding:0}\n" +
    "body{background:#05070f;color:#e8edf7;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;flex-direction:column;align-items:center;min-height:100vh;padding:10px;-webkit-user-select:none;user-select:none}\n" +
    ".wrap{width:100%;max-width:" + o.width + "px}\n" +
    "h1{font-size:17px;font-weight:800;text-align:center;letter-spacing:.3px}\n" +
    "h1 .dot{color:" + accent + "}\n" +
    ".tag{text-align:center;font-size:11px;color:#8b93a9;margin:2px 0 8px}\n" +
    "#hud{display:flex;justify-content:space-between;align-items:center;background:#0b1120;border:1px solid #232c47;border-radius:10px;padding:7px 12px;font-size:12px;font-weight:700;margin-bottom:8px;font-variant-numeric:tabular-nums}\n" +
    "#hud .lv{color:" + accent + "}\n" +
    "#stage{position:relative;border-radius:12px;overflow:hidden;border:1px solid #232c47;background:#000;touch-action:none}\n" +
    "canvas{display:block;width:100%;height:auto}\n" +
    "#overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;background:rgba(3,6,15,.82);backdrop-filter:blur(2px);padding:16px;z-index:5}\n" +
    "#overlay.hidden{display:none}\n" +
    "#overlay h2{font-size:24px;margin-bottom:6px}\n" +
    "#overlay p{font-size:13px;color:#aeb6cc;line-height:1.55;max-width:340px}\n" +
    "#overlay .big{font-size:40px;margin-bottom:8px}\n" +
    "#overlay button{margin-top:12px;background:" + accent + ";border:0;color:#fff;font-weight:800;font-size:14px;padding:10px 26px;border-radius:10px;cursor:pointer}\n" +
    ".ctl{display:flex;gap:8px;justify-content:center;margin-top:10px}\n" +
    ".ctl button{background:#141c33;border:1px solid #2a3557;color:#dbe3f3;border-radius:10px;font-size:12px;font-weight:700;padding:7px 12px;cursor:pointer}\n" +
    ".dpad{display:none;grid-template-columns:repeat(3,64px);grid-template-rows:repeat(2,56px);gap:6px;justify-content:center;margin-top:10px}\n" +
    ".dpad button{background:#141c33;border:1px solid #2a3557;color:#fff;border-radius:12px;font-size:20px;touch-action:none}\n" +
    ".dpad .act{background:" + accent + ";border-color:" + accent + ";font-size:15px;font-weight:800}\n" +
    "@media (pointer:coarse){.dpad{display:grid}}\n" +
    ".help{text-align:center;font-size:10.5px;color:#69718c;margin-top:8px;line-height:1.5}\n" +
    ".foot{text-align:center;font-size:10px;color:#4a5370;margin-top:6px}\n" +
    "</style>\n</head>\n<body>\n" +
    '<div class="wrap">\n<h1><span class="dot">●</span> ' + o.title + "</h1>\n" +
    '<div class="tag">' + (o.tagline ?? "generated fully offline · no internet used") + "</div>\n" +
    '<div id="hud"><span id="hL">SCORE 0</span><span class="lv" id="hR">LV 1</span></div>\n' +
    '<div id="stage"><canvas id="game" width="' + o.width + '" height="' + o.height + '"></canvas><div id="overlay"></div></div>\n' +
    '<div class="ctl"><button data-k="p">⏸ Pause</button><button data-k="m">🔊 Sound</button><button data-k="r">↻ Restart</button></div>\n' +
    '<div class="dpad"><span></span><button data-k="ArrowUp">▲</button><span></span><button data-k="ArrowLeft">◀</button><button data-k="ArrowDown">▼</button><button data-k="ArrowRight">▶</button></div>\n' +
    '<div class="dpad" style="grid-template-rows:56px"><span></span><button class="act" data-k=" "> ' + actionLabel + "</button><span></span></div>\n" +
    '<div class="help">' + help + "</div>\n" +
    '<div class="foot">🔒 built offline · ArenaForge Arcade · never trained on</div>\n' +
    "</div>\n<script>\n" +
    '"use strict";\n' +
    "if(typeof CanvasRenderingContext2D!=='undefined'&&!CanvasRenderingContext2D.prototype.roundRect){CanvasRenderingContext2D.prototype.roundRect=function(x,y,w,h){this.rect(x,y,w,h);return this;};}\n" +
    "function __hud(l,r){document.getElementById('hL').textContent=l;document.getElementById('hR').textContent=r;}\n" +
    "function __overlay(html){var el=document.getElementById('overlay');el.innerHTML=html;el.classList.remove('hidden');}\n" +
    "function __hideOverlay(){document.getElementById('overlay').classList.add('hidden');}\n" +
    "var __store={get:function(k,d){try{var v=localStorage.getItem(k);return v==null?d:JSON.parse(v);}catch(e){return d;}},set:function(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}}};\n" +
    "function __press(key){window.dispatchEvent(new KeyboardEvent('keydown',{key:key}));}\n" +
    "function __release(key){window.dispatchEvent(new KeyboardEvent('keyup',{key:key}));}\n" +
    "document.querySelectorAll('[data-k]').forEach(function(b){var k=b.getAttribute('data-k');b.addEventListener('pointerdown',function(e){e.preventDefault();__press(k);});b.addEventListener('pointerup',function(){__release(k);});b.addEventListener('pointerleave',function(){__release(k);});b.addEventListener('pointercancel',function(){__release(k);});});\n" +
    "(function(){var cv=document.getElementById('game');var sx=0,sy=0;cv.addEventListener('touchstart',function(e){var t=e.changedTouches[0];sx=t.clientX;sy=t.clientY;},{passive:true});cv.addEventListener('touchend',function(e){var t=e.changedTouches[0];var dx=t.clientX-sx,dy=t.clientY-sy;if(Math.max(Math.abs(dx),Math.abs(dy))<24){__press(' ');__release(' ');return;}var k=Math.abs(dx)>Math.abs(dy)?(dx>0?'ArrowRight':'ArrowLeft'):(dy>0?'ArrowDown':'ArrowUp');__press(k);setTimeout(function(){__release(k);},90);},{passive:true});cv.addEventListener('mousedown',function(){__press(' ');__release(' ');});})();\n" +
    "window.addEventListener('keydown',function(e){if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].indexOf(e.key)>=0){e.preventDefault();}});\n" +
    o.js +
    "\n</script>\n</body>\n</html>"
  );
}

// Tiny WebAudio bleeper shared by cores (offline-safe, init on first input).
export const SFX_JS = [
  "var __ac=null,__muted=false;",
  "function __sfx(f,d,type,v,slide){if(__muted)return;try{if(!__ac){var AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;__ac=new AC();}if(__ac.state==='suspended'){__ac.resume();}var o=__ac.createOscillator(),g=__ac.createGain();o.type=type||'square';o.frequency.setValueAtTime(f,__ac.currentTime);if(slide){o.frequency.exponentialRampToValueAtTime(Math.max(30,slide),__ac.currentTime+(d||0.1));}g.gain.setValueAtTime(v||0.04,__ac.currentTime);g.gain.exponentialRampToValueAtTime(0.0001,__ac.currentTime+(d||0.1));o.connect(g);g.connect(__ac.destination);o.start();o.stop(__ac.currentTime+(d||0.1));}catch(e){}}",
].join("\n");
