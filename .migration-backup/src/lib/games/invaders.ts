// Verified offline core: Space Invaders-classic.
// Player cannon, descending alien grid, destructible shields, UFO bonus,
// waves, score/lives/levels, sounds, keyboard + touch.

import { gameShell, SFX_JS } from "./shell";

export interface InvadersOpts {
  lives?: number;
  fireRate?: number; // player shots per second cap via cooldown ms
  invaderSpeed?: number;
  shields?: number;
  accent?: string;
}

export function buildInvaders(o: InvadersOpts = {}): string {
  const lives = o.lives ?? 3;
  const cooldown = o.fireRate ?? 260;
  const baseSpeed = o.invaderSpeed ?? 28;
  const shieldCount = Math.min(4, Math.max(0, o.shields ?? 3));

  const js =
    SFX_JS +
    "\n" +
    "var CONFIG={lives:" + lives + ",cooldown:" + cooldown + ",baseSpeed:" + baseSpeed + ",shields:" + shieldCount + "};\n" +
    [
      "var cv=document.getElementById('game'),ctx=cv.getContext('2d'),W=cv.width,H=cv.height;",
      "var player,aliens,bullets,bombs,shields,parts,ufo,score,lifeCount,level,high=__store.get('af_inv_high',0);",
      "var dir=1,dropT=0,stepT=0,bombT=1,cool=0,state='title',shake=0;",
      "var keys={};",
      "function newGame(){score=0;lifeCount=CONFIG.lives;level=1;startWave();state='play';__hideOverlay();}",
      "function startWave(){player={x:W/2,y:H-34,w:30,h:12,cd:0};aliens=[];bullets=[];bombs=[];parts=[];ufo=null;dir=1;bombT=1.2;var cols=9,rows=5;for(var r=0;r<rows;r++){for(var c=0;c<cols;c++){aliens.push({x:60+c*38,y:52+r*30,w:24,h:18,row:r,ph:Math.random()*6});}}shields=[];var n=CONFIG.shields;for(var s=0;s<n;s++){var sx=(s+1)*(W/(n+1));var cells=[];for(var yy=0;yy<6;yy++){cells[yy]=[];for(var xx=0;xx<9;xx++){cells[yy][xx]=(yy===5&&(xx<2||xx>6))?0:1;}}shields.push({x:sx-27,y:H-120,w:54,h:36,cells:cells});}}",
      "function boom(x,y,c,n,sp){for(var i=0;i<(n||14);i++){var a=Math.random()*6.28,s=(sp||120)*(0.4+Math.random());parts.push({x:x,y:y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,t:0.5+Math.random()*0.4,c:c||'#ffb347'});}}",
      "function shoot(){if(player.cd>0||bullets.length>=3)return;player.cd=CONFIG.cooldown/1000;bullets.push({x:player.x,y:player.y-12,vy:-380});__sfx(880,0.08,'square',0.035);}",
      "function alienShoot(){if(aliens.length===0)return;var shooters={};for(var i=0;i<aliens.length;i++){var a=aliens[i];var k=Math.round(a.x);if(!shooters[k]||shooters[k].y<a.y)shooters[k]=a;}var list=[];for(var key in shooters)list.push(shooters[key]);var s=list[Math.floor(Math.random()*list.length)];bombs.push({x:s.x,y:s.y+12,vy:150+level*14});}",
      "function hitShield(x,y,big){for(var s=0;s<shields.length;s++){var sh=shields[s];var lx=Math.floor((x-sh.x)/6),ly=Math.floor((y-sh.y)/6);if(lx>=0&&lx<9&&ly>=0&&ly<6&&sh.cells[ly][lx]){var R=big?2:1;for(var dy=-R;dy<=R;dy++){for(var dx=-R;dx<=R;dx++){var cx=lx+dx,cy=ly+dy;if(cx>=0&&cx<9&&cy>=0&&cy<6&&Math.abs(dx)+Math.abs(dy)<=R+1)sh.cells[cy][cx]=0;}}return true;}}return false;}",
      "function update(dt){",
      "if(keys['ArrowLeft']||keys['a'])player.x-=260*dt;if(keys['ArrowRight']||keys['d'])player.x+=260*dt;player.x=Math.max(18,Math.min(W-18,player.x));player.cd-=dt;",
      "if(keys[' '])shoot();",
      "var n=aliens.length;var sp=(CONFIG.baseSpeed+(45-n)*2.2+level*7);stepT+=dt;var step=sp*dt;dropT=0;",
      "for(var i=0;i<aliens.length;i++){var a=aliens[i];a.x+=dir*step;a.ph+=dt*6;if(a.x<20||a.x>W-20)dropT=1;}",
      "if(dropT){dir*=-1;for(var j=0;j<aliens.length;j++){aliens[j].y+=16;if(aliens[j].y>H-150){gameOver(false);return;}}}",
      "bombT-=dt;if(bombT<=0){bombT=Math.max(0.35,1.1-level*0.08-n*0.004);alienShoot();}",
      "if(!ufo&&Math.random()<dt*0.08){ufo={x:dir>0?-20:W+20,y:26,vx:(dir>0?1:-1)*90};}",
      "if(ufo){ufo.x+=ufo.vx*dt;if(ufo.x<-30||ufo.x>W+30)ufo=null;}",
      "for(var b=bullets.length-1;b>=0;b--){var bl=bullets[b];bl.y+=bl.vy*dt;if(bl.y<0){bullets.splice(b,1);continue;}if(hitShield(bl.x,bl.y,false)){bullets.splice(b,1);continue;}var hit=false;",
      "if(ufo&&Math.abs(bl.x-ufo.x)<20&&Math.abs(bl.y-ufo.y)<12){score+=150;boom(ufo.x,ufo.y,'#ff5df2',18,160);__sfx(1200,0.2,'square',0.05);ufo=null;bullets.splice(b,1);continue;}",
      "for(var k=aliens.length-1;k>=0;k--){var al=aliens[k];if(Math.abs(bl.x-al.x)<16&&Math.abs(bl.y-al.y)<13){score+=(5-al.row)*20;boom(al.x,al.y,al.row<2?'#7CFC00':'#ff5d5d',12,130);__sfx(220,0.12,'sawtooth',0.05);aliens.splice(k,1);bullets.splice(b,1);hit=true;break;}}if(hit)continue;}",
      "for(var m=bombs.length-1;m>=0;m--){var bo=bombs[m];bo.y+=bo.vy*dt;if(bo.y>H){bombs.splice(m,1);continue;}if(hitShield(bo.x,bo.y,true)){bombs.splice(m,1);continue;}if(Math.abs(bo.x-player.x)<17&&Math.abs(bo.y-player.y)<11){bombs.splice(m,1);loseLife();return;}}",
      "for(var q=bullets.length-1;q>=0;q--){for(var w=bombs.length-1;w>=0;w--){if(Math.abs(bullets[q].x-bombs[w].x)<6&&Math.abs(bullets[q].y-bombs[w].y)<10){boom(bullets[q].x,bullets[q].y,'#fff',8,100);bullets.splice(q,1);bombs.splice(w,1);break;}}}",
      "for(var p=parts.length-1;p>=0;p--){var pt=parts[p];pt.t-=dt;pt.x+=pt.vx*dt;pt.y+=pt.vy*dt;pt.vy+=160*dt;if(pt.t<=0)parts.splice(p,1);}",
      "if(aliens.length===0){score+=250*level;level++;startWave();__sfx(660,0.1,'square',0.05);__sfx(990,0.15,'square',0.05);}",
      "__hud('SCORE '+score+'  ×'+lifeCount,'WAVE '+level+' · BEST '+Math.max(high,score));}",
      "function loseLife(){lifeCount--;boom(player.x,player.y,'#5df2ff',22,180);shake=0.3;__sfx(300,0.4,'sawtooth',0.06,50);if(lifeCount<=0){gameOver(true);}else{bullets=[];bombs=[];player.x=W/2;}}",
      "function gameOver(dead){if(score>high){high=score;__store.set('af_inv_high',high);}state='over';__overlay('<div class=\"big\">🛸</div><h2>'+(dead?'GAME OVER':'INVASION!')+'</h2><p>Score '+score+' · Wave '+level+'<br>Best '+high+'<br><br>Press R or tap Restart</p>');}",
      "function drawAlien(a){var wob=Math.sin(a.ph)*2;ctx.fillStyle=a.row<1?'#ff5df2':a.row<3?'#7CFC00':'#5df2ff';var x=a.x,y=a.y;ctx.fillRect(x-11+wob*0.3,y-8,22,14);ctx.fillRect(x-7,y-11,14,4);ctx.fillStyle='#05070f';ctx.fillRect(x-6,y-4,5,5);ctx.fillRect(x+1,y-4,5,5);ctx.fillStyle=a.row<1?'#ff5df2':a.row<3?'#7CFC00':'#5df2ff';ctx.fillRect(x-9,y+6,6,4);ctx.fillRect(x+3,y+6,6,4);}",
      "function draw(){ctx.save();if(shake>0){ctx.translate((Math.random()-0.5)*6,(Math.random()-0.5)*6);}ctx.fillStyle='#05070f';ctx.fillRect(-8,-8,W+16,H+16);",
      "ctx.fillStyle='#1a2340';for(var s=0;s<40;s++){var sx=(s*97)%W,sy=(s*57)%H;ctx.fillRect(sx,sy,2,2);}",
      "for(var i=0;i<aliens.length;i++)drawAlien(aliens[i]);",
      "for(var h=0;h<shields.length;h++){var sh=shields[h];ctx.fillStyle='#29e07c';for(var yy=0;yy<6;yy++){for(var xx=0;xx<9;xx++){if(sh.cells[yy][xx])ctx.fillRect(sh.x+xx*6,sh.y+yy*6,6,6);}}}",
      "if(ufo){ctx.fillStyle='#ff5df2';ctx.beginPath();ctx.ellipse(ufo.x,ufo.y,18,8,0,0,7);ctx.fill();ctx.fillStyle='#ffd7fb';ctx.fillRect(ufo.x-6,ufo.y-12,12,6);}",
      "ctx.fillStyle='#5df2ff';ctx.fillRect(player.x-15,player.y-6,30,12);ctx.fillRect(player.x-3,player.y-14,6,9);ctx.fillStyle='#0e7490';ctx.fillRect(player.x-15,player.y+4,30,2);",
      "ctx.fillStyle='#fff';for(var b=0;b<bullets.length;b++){ctx.fillRect(bullets[b].x-2,bullets[b].y-8,4,10);}",
      "ctx.fillStyle='#ffb347';for(var m=0;m<bombs.length;m++){var bo=bombs[m];ctx.fillRect(bo.x-2,bo.y-5,4,10);ctx.fillRect(bo.x-4,bo.y-2,8,4);}",
      "for(var p=0;p<parts.length;p++){var pt=parts[p];ctx.globalAlpha=Math.max(0,pt.t*2);ctx.fillStyle=pt.c;ctx.fillRect(pt.x-2,pt.y-2,4,4);}ctx.globalAlpha=1;ctx.restore();}",
      "var last=0;",
      "function loop(ts){requestAnimationFrame(loop);var dt=Math.min(0.033,(ts-last)/1000||0.016);last=ts;if(shake>0)shake-=dt;if(state==='play')update(dt);if(state!=='title')draw();}",
      "window.__start=function(){newGame();};",
      "window.addEventListener('keydown',function(e){keys[e.key.length===1?e.key.toLowerCase():e.key]=true;var k=e.key;if(k==='p'||k==='P'){if(state==='play'){state='pause';__overlay('<div class=\"big\">⏸</div><h2>PAUSED</h2><p>Press P to resume</p>');}else if(state==='pause'){state='play';__hideOverlay();}}else if(k==='m'||k==='M'){__muted=!__muted;}else if(k==='r'||k==='R'){if(state!=='title')newGame();}else if((k===' '||k==='Enter')&&state==='title'){newGame();}});",
      "window.addEventListener('keyup',function(e){keys[e.key.length===1?e.key.toLowerCase():e.key]=false;});",
      "startWave();state='title';__overlay('<div class=\"big\">👾</div><h2>SPACE INVADERS</h2><p>Hold the line. Shields crumble. UFO = bonus.<br>◀ ▶ / A D to move · Space / tap to fire.<br><br><button onclick=\"__start()\">▶ START</button></p>');__hud('SCORE 0  ×'+CONFIG.lives,'WAVE 1 · BEST '+high);requestAnimationFrame(loop);",
    ].join("\n");

  return gameShell({
    title: "Space Invaders",
    tagline: "arcade-classic · generated fully offline · no internet used",
    width: 480,
    height: 560,
    accent: "#7CFC00",
    js,
    help: ["◀ ▶ / A D — move · Space / tap — fire", "Bombs destroy bullets mid-air · UFO = 150", "P — pause · M — sound · R — restart"],
    actionLabel: "FIRE",
  });
}
