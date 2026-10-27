// Verified offline core: Neon Arena (parametric survival).
// The "no boundaries" guarantee: ANY prompt becomes a playable game —
// theme, title, enemy flavor and tuning derive from the user's words.

import { gameShell, SFX_JS } from "./shell";

export interface ArenaOpts {
  title?: string;
  enemyName?: string;
  orbName?: string;
  accent?: string;
  enemyColor?: string;
  bg?: string;
  playerSpeed?: number;
  enemyRate?: number;
  lives?: number;
}

const THEMES: { keys: string[]; accent: string; enemy: string; bg: string }[] = [
  { keys: ["neon", "cyber", "synth", "tron", "laser"], accent: "#22d3ee", enemy: "#f0f", bg: "#05070f" },
  { keys: ["lava", "fire", "volcano", "hell", "inferno"], accent: "#fb923c", enemy: "#ef4444", bg: "#0f0505" },
  { keys: ["ocean", "sea", "water", "deep", "atlantis"], accent: "#38bdf8", enemy: "#0ea5e9", bg: "#020617" },
  { keys: ["forest", "jungle", "nature", "moss"], accent: "#4ade80", enemy: "#a16207", bg: "#04120a" },
  { keys: ["space", "star", "galaxy", "cosmos", "alien"], accent: "#a78bfa", enemy: "#7CFC00", bg: "#070312" },
  { keys: ["gold", "desert", "sand", "egypt"], accent: "#fbbf24", enemy: "#b45309", bg: "#120b02" },
  { keys: ["ice", "frost", "snow", "arctic"], accent: "#bae6fd", enemy: "#818cf8", bg: "#04070f" },
  { keys: ["candy", "pink", "cute", "love"], accent: "#f9a8d4", enemy: "#e879f9", bg: "#12040c" },
];

export function themeFromPrompt(prompt: string): { accent: string; enemy: string; bg: string; title: string } {
  const p = prompt.toLowerCase();
  const t = THEMES.find((th) => th.keys.some((k) => p.includes(k))) ?? THEMES[0];
  const words = prompt.replace(/[^a-zA-Z0-9 ]/g, "").split(/\s+/).filter((w) => w.length > 2).slice(0, 3);
  const title = words.length ? words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") + " Arena" : "Neon Arena";
  return { accent: t.accent, enemy: t.enemy, bg: t.bg, title: title.slice(0, 28) };
}

export function buildArena(o: ArenaOpts = {}): string {
  const accent = o.accent ?? "#22d3ee";
  const enemyColor = o.enemyColor ?? "#f0f";
  const bg = o.bg ?? "#05070f";
  const title = (o.title ?? "Neon Arena").replace(/[<>&"]/g, "");
  const enemyName = (o.enemyName ?? "chasers").replace(/[<>&"]/g, "");
  const orbName = (o.orbName ?? "orbs").replace(/[<>&"]/g, "");
  const playerSpeed = o.playerSpeed ?? 250;
  const enemyRate = o.enemyRate ?? 1;
  const lives = o.lives ?? 3;

  const js =
    SFX_JS +
    "\n" +
    "var CONFIG={ps:" + playerSpeed + ",rate:" + enemyRate + ",lives:" + lives + ",accent:'" + accent + "',enemy:'" + enemyColor + "',bg:'" + bg + "'};\n" +
    [
      "var cv=document.getElementById('game'),ctx=cv.getContext('2d'),W=cv.width,H=cv.height;",
      "var px,py,enemies,shots,orbs,parts,score,hp,wave,waveT,spawnT,high=__store.get('af_arena_high',0),state='title',fireT=0,inv=0;",
      "var keys={};",
      "function reset(){px=W/2;py=H/2;enemies=[];shots=[];orbs=[];parts=[];score=0;hp=CONFIG.lives*2;wave=1;waveT=0;spawnT=0;inv=0;for(var i=0;i<4;i++)spawnOrb();}",
      "function spawnOrb(){orbs.push({x:30+Math.random()*(W-60),y:60+Math.random()*(H-100),ph:Math.random()*6});}",
      "function spawnEnemy(){var edge=Math.floor(Math.random()*4);var x=edge===0?-16:edge===1?W+16:Math.random()*W;var y=edge===2?-16:edge===3?H+16:Math.random()*H;var fast=Math.random()<0.2+wave*0.02;enemies.push({x:x,y:y,r:fast?9:13,sp:(55+wave*9)*(fast?1.7:1)*(0.85+Math.random()*0.3),wob:Math.random()*6,hp:fast?1:(wave>3&&Math.random()<0.3?2:1)});}",
      "function boom(x,y,c,n){for(var i=0;i<(n||12);i++){var a=Math.random()*6.28,s=60+Math.random()*140;parts.push({x:x,y:y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,t:0.5,c:c});}}",
      "function newGame(){reset();state='play';__hideOverlay();}",
      "function nearest(){var best=null,bd=1e12;for(var i=0;i<enemies.length;i++){var e=enemies[i];var dx=e.x-px,dy=e.y-py;var d=dx*dx+dy*dy;if(d<bd){bd=d;best=e;}}return best;}",
      "function update(dt){var mx=0,my=0;if(keys['ArrowLeft']||keys['a'])mx-=1;if(keys['ArrowRight']||keys['d'])mx+=1;if(keys['ArrowUp']||keys['w'])my-=1;if(keys['ArrowDown']||keys['s'])my+=1;if(mx&&my){mx*=0.707;my*=0.707;}px=Math.max(14,Math.min(W-14,px+mx*CONFIG.ps*dt));py=Math.max(30,Math.min(H-14,py+my*CONFIG.ps*dt));if(inv>0)inv-=dt;",
      "fireT-=dt;var tgt=nearest();if(tgt&&fireT<=0){fireT=0.22;var dx=tgt.x-px,dy=tgt.y-py;var d=Math.sqrt(dx*dx+dy*dy)||1;shots.push({x:px,y:py,vx:dx/d*460,vy:dy/d*460});__sfx(700+Math.random()*200,0.05,'square',0.025);}",
      "waveT+=dt;if(waveT>14){waveT=0;wave++;__sfx(880,0.15,'square',0.05);spawnOrb();}",
      "spawnT-=dt;if(spawnT<=0){spawnT=Math.max(0.3,1.15-wave*0.08)/CONFIG.rate;spawnEnemy();if(wave>2&&Math.random()<0.4)spawnEnemy();}",
      "for(var i=enemies.length-1;i>=0;i--){var e=enemies[i];e.wob+=dt*4;var dx=px-e.x,dy=py-e.y;var d=Math.sqrt(dx*dx+dy*dy)||1;e.x+=dx/d*e.sp*dt+Math.cos(e.wob)*20*dt;e.y+=dy/d*e.sp*dt+Math.sin(e.wob)*20*dt;}",
      "for(var s=shots.length-1;s>=0;s--){var sh=shots[s];sh.x+=sh.vx*dt;sh.y+=sh.vy*dt;if(sh.x<-10||sh.x>W+10||sh.y<-10||sh.y>H+10){shots.splice(s,1);continue;}for(var k=enemies.length-1;k>=0;k--){var en=enemies[k];var ddx=sh.x-en.x,ddy=sh.y-en.y;if(ddx*ddx+ddy*ddy<(en.r+4)*(en.r+4)){shots.splice(s,1);en.hp--;if(en.hp<=0){enemies.splice(k,1);score+=10+wave*2;boom(en.x,en.y,CONFIG.enemy,12);__sfx(240,0.1,'sawtooth',0.04);if(Math.random()<0.25)spawnOrb();}break;}}}",
      "for(var q=orbs.length-1;q>=0;q--){var ob=orbs[q];ob.ph+=dt*3;var odx=px-ob.x,ody=py-ob.y;if(odx*odx+ody*ody<22*22){orbs.splice(q,1);score+=25;if(hp<CONFIG.lives*2)hp++;boom(ob.x,ob.y,CONFIG.accent,8);__sfx(990,0.1,'square',0.04);spawnOrb();}}",
      "if(inv<=0){for(var h=enemies.length-1;h>=0;h--){var he=enemies[h];var hdx=px-he.x,hdy=py-he.y;if(hdx*hdx+hdy*hdy<(he.r+10)*(he.r+10)){enemies.splice(h,1);hp--;inv=1.2;boom(px,py,'#fff',16);__sfx(150,0.3,'sawtooth',0.06,60);if(hp<=0){if(score>high){high=score;__store.set('af_arena_high',high);}state='over';__overlay('<div class=\"big\">💥</div><h2>OVERRUN</h2><p>Score '+score+' · Wave '+wave+'<br>Best '+high+'<br><br>Press R or tap Restart</p>');return;}break;}}}",
      "for(var p=parts.length-1;p>=0;p--){var pt=parts[p];pt.t-=dt;pt.x+=pt.vx*dt;pt.y+=pt.vy*dt;if(pt.t<=0)parts.splice(p,1);}",
      "__hud('SCORE '+score+'  ♥'+hp,'WAVE '+wave+' · BEST '+Math.max(high,score));}",
      "function draw(){ctx.fillStyle=CONFIG.bg;ctx.fillRect(0,0,W,H);ctx.strokeStyle='rgba(255,255,255,.05)';ctx.lineWidth=1;for(var g=0;g<W;g+=32){ctx.beginPath();ctx.moveTo(g,0);ctx.lineTo(g,H);ctx.stroke();}for(var g2=0;g2<H;g2+=32){ctx.beginPath();ctx.moveTo(0,g2);ctx.lineTo(W,g2);ctx.stroke();}",
      "for(var i=0;i<orbs.length;i++){var ob=orbs[i];ctx.fillStyle=CONFIG.accent;ctx.globalAlpha=0.85;ctx.beginPath();ctx.arc(ob.x,ob.y,7+Math.sin(ob.ph)*1.5,0,7);ctx.fill();ctx.globalAlpha=1;}",
      "for(var k=0;k<enemies.length;k++){var e=enemies[k];ctx.fillStyle=CONFIG.enemy;ctx.beginPath();var n=6;for(var v=0;v<=n;v++){var a=v/n*6.28+e.wob*0.2;var rr=e.r*(v%2?0.78:1);var vx=e.x+Math.cos(a)*rr,vy=e.y+Math.sin(a)*rr;if(v===0)ctx.moveTo(vx,vy);else ctx.lineTo(vx,vy);}ctx.closePath();ctx.fill();ctx.fillStyle='rgba(0,0,0,.5)';ctx.beginPath();ctx.arc(e.x,e.y,e.r*0.4,0,7);ctx.fill();}",
      "for(var s=0;s<shots.length;s++){ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(shots[s].x,shots[s].y,3,0,7);ctx.fill();}",
      "ctx.save();ctx.translate(px,py);var tgt2=nearest();if(tgt2)ctx.rotate(Math.atan2(tgt2.y-py,tgt2.x-px));if(inv>0&&Math.floor(Date.now()/120)%2)ctx.globalAlpha=0.35;ctx.fillStyle=CONFIG.accent;ctx.beginPath();ctx.moveTo(12,0);ctx.lineTo(-8,-9);ctx.lineTo(-4,0);ctx.lineTo(-8,9);ctx.closePath();ctx.fill();ctx.restore();ctx.globalAlpha=1;",
      "for(var p=0;p<parts.length;p++){var pt=parts[p];ctx.globalAlpha=Math.max(0,pt.t*2);ctx.fillStyle=pt.c;ctx.fillRect(pt.x-2,pt.y-2,4,4);}ctx.globalAlpha=1;}",
      "var last=0;",
      "function loop(ts){requestAnimationFrame(loop);var dt=Math.min(0.033,(ts-last)/1000||0.016);last=ts;if(state==='play')update(dt);if(state!=='title')draw();}",
      "cv.addEventListener('pointermove',function(e){if(state!=='play')return;if(e.pointerType==='mouse'&&e.buttons!==1)return;var r=cv.getBoundingClientRect();px=(e.clientX-r.left)/r.width*W;py=(e.clientY-r.top)/r.height*H;});",
      "window.__start=function(){newGame();};",
      "window.addEventListener('keydown',function(e){keys[e.key.length===1?e.key.toLowerCase():e.key]=true;var k=e.key;if(k==='p'||k==='P'){if(state==='play'){state='pause';__overlay('<div class=\"big\">⏸</div><h2>PAUSED</h2><p>Press P to resume</p>');}else if(state==='pause'){state='play';__hideOverlay();}}else if(k==='m'||k==='M'){__muted=!__muted;}else if(k==='r'||k==='R'){if(state!=='title')newGame();}else if((k===' '||k==='Enter')&&state==='title'){newGame();}});",
      "window.addEventListener('keyup',function(e){keys[e.key.length===1?e.key.toLowerCase():e.key]=false;});",
      "reset();state='title';__overlay('<div class=\"big\">🚀</div><h2>" + title.toUpperCase() + "</h2><p>Survive the " + enemyName + ". Auto-blaster armed.<br>Grab " + orbName + " to score + heal.<br>WASD / arrows / drag to move.<br><br><button onclick=\"__start()\">▶ START</button></p>');__hud('SCORE 0  ♥'+(CONFIG.lives*2),'WAVE 1 · BEST '+high);requestAnimationFrame(loop);",
    ].join("\n");

  return gameShell({
    title,
    tagline: "parametric survival · forged fully offline from your words",
    width: 520,
    height: 420,
    accent,
    js,
    help: ["WASD / arrows / drag — move · blaster fires automatically", "Orbs score + heal · waves get harder", "P — pause · M — sound · R — restart"],
    actionLabel: "⏸",
  });
}
