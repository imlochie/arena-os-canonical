import { gameShell, SFX_JS } from "./shell";

export interface PlatformerOpts {
  accent?: string;
}

export function buildPlatformer(options: PlatformerOpts = {}): string {
  const accent = options.accent ?? "#7dd3fc";
  const js =
    SFX_JS +
    "\n" +
    [
      "var cv=document.getElementById('game'),ctx=cv.getContext('2d'),W=cv.width,H=cv.height;",
      "var levels=[",
      "{goal:{x:438,y:250},platforms:[{x:0,y:292,w:480,h:28},{x:72,y:244,w:90,h:12},{x:192,y:202,w:86,h:12},{x:308,y:162,w:86,h:12},{x:382,y:276,w:44,h:16}],coins:[{x:112,y:218},{x:230,y:176},{x:346,y:136}]},",
      "{goal:{x:438,y:250},platforms:[{x:0,y:292,w:480,h:28},{x:48,y:258,w:80,h:12},{x:148,y:220,w:90,h:12},{x:264,y:184,w:78,h:12},{x:354,y:150,w:72,h:12},{x:382,y:276,w:44,h:16}],coins:[{x:86,y:232},{x:190,y:194},{x:302,y:158},{x:390,y:124}]},",
      "{goal:{x:438,y:250},platforms:[{x:0,y:292,w:480,h:28},{x:52,y:248,w:72,h:12},{x:148,y:206,w:70,h:12},{x:244,y:164,w:78,h:12},{x:340,y:210,w:72,h:12},{x:382,y:276,w:44,h:16}],coins:[{x:88,y:222},{x:182,y:180},{x:284,y:138},{x:374,y:184}]}];",
      "var player,coins,level=0,unlocked=__store.get('af_platform_unlocked',1),score=0,high=__store.get('af_platform_high',0),lives=3,state='title',keys={},last=0;",
      "function loadLevel(index){level=Math.max(0,Math.min(levels.length-1,index));var def=levels[level];player={x:24,y:252,w:18,h:24,vx:0,vy:0,ground:false};coins=def.coins.map(function(c){return {x:c.x,y:c.y,taken:false};});}",
      "function start(){score=0;lives=3;loadLevel(Math.max(0,Math.min(levels.length-1,unlocked-1)));state='play';__hud('SCORE '+score+'  ♥'+lives,'STAGE '+(level+1)+' / '+levels.length+' · BEST '+high);__hideOverlay();}",
      "function finishLevel(){unlocked=Math.max(unlocked,level+2);__store.set('af_platform_unlocked',Math.min(levels.length,unlocked));if(level>=levels.length-1){if(score>high){high=score;__store.set('af_platform_high',high);}state='over';__overlay('<div class=\"big\">🏆</div><h2>ADVENTURE COMPLETE</h2><p>Score '+score+' · Best '+high+'<br>All three stages unlocked.<br><br>Press R to play again</p>');return;}loadLevel(level+1);__sfx(880,0.18,'square',0.045);}",
      "function update(dt){var oldBottom=player.y+player.h;player.vx=0;if(keys.ArrowLeft||keys.a)player.vx=-190;if(keys.ArrowRight||keys.d)player.vx=190;player.x=Math.max(0,Math.min(W-player.w,player.x+player.vx*dt));player.vy=Math.min(520,player.vy+820*dt);player.y+=player.vy*dt;player.ground=false;var plats=levels[level].platforms;for(var i=0;i<plats.length;i++){var p=plats[i];if(player.vy>=0&&oldBottom<=p.y+2&&player.y+player.h>=p.y&&player.x+player.w>p.x&&player.x<p.x+p.w){player.y=p.y-player.h;player.vy=0;player.ground=true;}}",
      "if(player.y>H+40){lives--;if(lives<=0){state='over';if(score>high){high=score;__store.set('af_platform_high',high);}__overlay('<div class=\"big\">💫</div><h2>TRY AGAIN</h2><p>Score '+score+' · Best '+high+'<br>Press R to restart</p>');return;}loadLevel(level);}",
      "for(var c=0;c<coins.length;c++){var coin=coins[c];if(!coin.taken&&Math.abs(player.x+player.w/2-coin.x)<18&&Math.abs(player.y+player.h/2-coin.y)<22){coin.taken=true;score+=10;if(score>high){high=score;__store.set('af_platform_high',high);}__sfx(760,0.08,'triangle',0.04);}}",
      "var g=levels[level].goal;if(player.x+player.w>g.x&&player.x<g.x+20&&player.y+player.h>g.y-34&&player.y<g.y+34)finishLevel();__hud('SCORE '+score+'  ♥'+lives,'STAGE '+(level+1)+' / '+levels.length+' · BEST '+high);}",
      "function draw(){ctx.fillStyle='#081324';ctx.fillRect(0,0,W,H);for(var y=0;y<H;y+=32){ctx.fillStyle='rgba(255,255,255,.025)';ctx.fillRect(0,y,W,1);}var plats=levels[level].platforms;for(var i=0;i<plats.length;i++){var p=plats[i];ctx.fillStyle='#263953';ctx.fillRect(p.x,p.y,p.w,p.h);ctx.fillStyle='"+accent+"';ctx.fillRect(p.x,p.y,p.w,3);}for(var c=0;c<coins.length;c++){var coin=coins[c];if(coin.taken)continue;ctx.fillStyle='#fbbf24';ctx.beginPath();ctx.arc(coin.x,coin.y,7,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff3c4';ctx.fillRect(coin.x-1,coin.y-4,2,8);}var g=levels[level].goal;ctx.fillStyle='#f8fafc';ctx.fillRect(g.x,g.y-34,4,42);ctx.fillStyle='#fb7185';ctx.beginPath();ctx.moveTo(g.x+4,g.y-34);ctx.lineTo(g.x+30,g.y-25);ctx.lineTo(g.x+4,g.y-15);ctx.fill();ctx.fillStyle='"+accent+"';ctx.fillRect(player.x,player.y,player.w,player.h);ctx.fillStyle='#07111f';ctx.fillRect(player.x+11,player.y+6,3,3);}",
      "function loop(ts){requestAnimationFrame(loop);var dt=Math.min(0.033,(ts-last)/1000||0.016);last=ts;if(state==='play')update(dt);draw();}",
      "function jump(){if(state==='title'){start();return;}if(state==='play'&&player.ground){player.vy=-355;player.ground=false;__sfx(300,0.06,'square',0.025);}}",
      "window.__start=start;window.addEventListener('keydown',function(e){var key=e.key.length===1?e.key.toLowerCase():e.key;keys[key]=true;if(e.key===' '||e.key==='ArrowUp'||e.key==='w'||e.key==='W'){e.preventDefault();jump();}else if(key==='p'){if(state==='play'){state='pause';__overlay('<div class=\"big\">⏸</div><h2>PAUSED</h2><p>Press P to resume</p>');}else if(state==='pause'){state='play';__hideOverlay();}}else if(key==='m'){__muted=!__muted;}else if(key==='r'&&state!=='title'){start();}});",
      "window.addEventListener('keyup',function(e){var key=e.key.length===1?e.key.toLowerCase():e.key;keys[key]=false;});",
      "loadLevel(0);__hud('SCORE 0  ♥3','STAGE 1 / '+levels.length+' · BEST '+high);__overlay('<div class=\"big\">🏃</div><h2>PLATFORM ADVENTURE</h2><p>Run, jump, collect every coin, and reach the flag.<br>Arrows / A-D move · Space / W jumps.<br>Unlocked stages save in this browser.<br><br><button onclick=\"__start()\">▶ CONTINUE</button></p>');requestAnimationFrame(loop);",
    ].join("\n");
  return gameShell({
    title: "Platform Adventure",
    tagline: "three-stage side-scroller · saved locally",
    width: 480,
    height: 320,
    accent,
    js,
    help: ["← → / A-D — run · Space / W / ▲ — jump", "Collect coins and reach the flag to unlock stages", "P — pause · M — sound · R — continue"],
    actionLabel: "JUMP",
  });
}
