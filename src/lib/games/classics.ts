// Verified offline cores: Snake, Breakout, Pong.
// Complete playable single-file games, zero network.

import { gameShell, SFX_JS } from "./shell";

// ---------------- SNAKE ----------------
export interface SnakeOpts {
  speed?: number; // moves per second
  wrap?: boolean;
  goal?: number;
  accent?: string;
}
export function buildSnake(o: SnakeOpts = {}): string {
  const speed = o.speed ?? 9;
  const wrap = o.wrap ?? false;
  const goal = o.goal ?? 25;
  const js =
    SFX_JS +
    "\n" +
    "var CONFIG={speed:" + speed + ",wrap:" + (wrap ? "true" : "false") + ",goal:" + goal + "};\n" +
    [
      "var cv=document.getElementById('game'),ctx=cv.getContext('2d'),N=21,T=cv.width/N;",
      "var snake,dir,want,food,special,score,level,high=__store.get('af_snake_high',0),state='title',acc=0,specialT=0;",
      "function placeFood(){while(true){var x=Math.floor(Math.random()*N),y=Math.floor(Math.random()*N);var ok=true;for(var i=0;i<snake.length;i++){if(snake[i].x===x&&snake[i].y===y){ok=false;break;}}if(ok){food={x:x,y:y};return;}}}",
      "function reset(){snake=[{x:10,y:10},{x:9,y:10},{x:8,y:10}];dir={x:1,y:0};want={x:1,y:0};score=0;level=1;special=null;specialT=6;placeFood();}",
      "function newGame(){reset();state='play';__hideOverlay();}",
      "function step(){if(want.x!==-dir.x||want.y!==-dir.y){if(!(want.x===dir.x&&want.y===dir.y)||true){if(snake.length<2||true){dir={x:want.x,y:want.y};}}}",
      "var h={x:snake[0].x+dir.x,y:snake[0].y+dir.y};",
      "if(CONFIG.wrap){h.x=(h.x+N)%N;h.y=(h.y+N)%N;}else if(h.x<0||h.y<0||h.x>=N||h.y>=N){return die();}",
      "for(var i=0;i<snake.length;i++){if(snake[i].x===h.x&&snake[i].y===h.y)return die();}",
      "snake.unshift(h);",
      "if(h.x===food.x&&h.y===food.y){score+=10;__sfx(520+score,0.07,'square',0.035);if(score/10%5===0){level++;__sfx(780,0.12,'square',0.04);}placeFood();if(score/10>=CONFIG.goal){return win();}}",
      "else if(special&&h.x===special.x&&h.y===special.y){score+=50;special=null;specialT=8;__sfx(990,0.15,'square',0.05);}",
      "else snake.pop();",
      "__hud('SCORE '+score+' / '+(CONFIG.goal*10),'LV '+level+' · BEST '+Math.max(high,score));}",
      "function die(){if(score>high){high=score;__store.set('af_snake_high',high);}state='over';__sfx(200,0.4,'sawtooth',0.06,60);__overlay('<div class=\"big\">🐍</div><h2>GAME OVER</h2><p>Score '+score+' · Level '+level+'<br>Best '+high+'<br><br>Press R or tap Restart</p>');}",
      "function win(){if(score>high){high=score;__store.set('af_snake_high',high);}state='over';__overlay('<div class=\"big\">🏆</div><h2>YOU WIN!</h2><p>Score '+score+'<br>Best '+high+'<br><br>Press R to play again</p>');}",
      "function draw(){ctx.fillStyle='#05070f';ctx.fillRect(0,0,cv.width,cv.height);ctx.strokeStyle='#1a2340';ctx.lineWidth=1;for(var g=0;g<=N;g++){ctx.beginPath();ctx.moveTo(g*T,0);ctx.lineTo(g*T,cv.height);ctx.stroke();ctx.beginPath();ctx.moveTo(0,g*T);ctx.lineTo(cv.width,g*T);ctx.stroke();}",
      "ctx.fillStyle='#ff4d6d';ctx.beginPath();ctx.arc(food.x*T+T/2,food.y*T+T/2,T*0.32,0,7);ctx.fill();ctx.fillStyle='#7CFC00';ctx.fillRect(food.x*T+T/2-1,food.y*T+2,3,5);",
      "if(special){ctx.fillStyle='#ffd700';ctx.beginPath();ctx.arc(special.x*T+T/2,special.y*T+T/2,T*0.4,0,7);ctx.fill();ctx.fillStyle='#05070f';ctx.font='bold 11px system-ui';ctx.textAlign='center';ctx.fillText('★',special.x*T+T/2,special.y*T+T/2+4);}",
      "for(var i=snake.length-1;i>=0;i--){var s=snake[i];var t=i/snake.length;ctx.fillStyle=i===0?'#a3ff5e':'rgb('+(60+Math.floor((1-t)*60))+','+(200-Math.floor(t*70))+',60)';ctx.beginPath();ctx.roundRect(s.x*T+1.5,s.y*T+1.5,T-3,T-3,i===0?6:4);ctx.fill();if(i===0){ctx.fillStyle='#05070f';var ex=dir.x*3,ey=dir.y*3;ctx.beginPath();ctx.arc(s.x*T+T/2-4+ex,s.y*T+T/2-3+ey,2,0,7);ctx.arc(s.x*T+T/2+4+ex,s.y*T+T/2-3+ey,2,0,7);ctx.fill();}}}",
      "var last=0;",
      "function loop(ts){requestAnimationFrame(loop);var dt=Math.min(0.05,(ts-last)/1000||0.016);last=ts;if(state==='play'){acc+=dt;var rate=1/(CONFIG.speed+ (level-1)*0.9);while(acc>rate){acc-=rate;step();if(state!=='play')break;}specialT-=dt;if(specialT<=0&&!special){special={x:2+Math.floor(Math.random()*(N-4)),y:2+Math.floor(Math.random()*(N-4))};specialT=10;}if(special&&specialT<-6){special=null;specialT=8;}}draw();}",
      "window.__start=function(){newGame();};",
      "window.addEventListener('keydown',function(e){var k=e.key;if(k==='ArrowUp'||k==='w'||k==='W'){if(dir.y!==1)want={x:0,y:-1};}else if(k==='ArrowDown'||k==='s'||k==='S'){if(dir.y!==-1)want={x:0,y:1};}else if(k==='ArrowLeft'||k==='a'||k==='A'){if(dir.x!==1)want={x:-1,y:0};}else if(k==='ArrowRight'||k==='d'||k==='D'){if(dir.x!==-1)want={x:1,y:0};}else if(k==='p'||k==='P'){if(state==='play'){state='pause';__overlay('<div class=\"big\">⏸</div><h2>PAUSED</h2><p>Press P to resume</p>');}else if(state==='pause'){state='play';__hideOverlay();}}else if(k==='m'||k==='M'){__muted=!__muted;}else if(k==='r'||k==='R'){newGame();}else if((k===' '||k==='Enter')&&state==='title'){newGame();}});",
      "reset();state='title';__overlay('<div class=\"big\">🐍</div><h2>SNAKE</h2><p>Eat '+CONFIG.goal+' to win. Stars = 50.<br>Arrows / WASD / swipe / dpad.<br><br><button onclick=\"__start()\">▶ START</button></p>');__hud('SCORE 0 / '+(CONFIG.goal*10),'LV 1 · BEST '+high);requestAnimationFrame(loop);",
    ].join("\n");
  return gameShell({ title: "Snake", tagline: "arcade-classic · generated fully offline", width: 441, height: 441, accent: o.accent ?? "#7CFC00", js, help: ["Arrows / WASD / swipe — steer", "Red = 10 · ★ = 50", "P — pause · M — sound · R — restart"], actionLabel: "⏸" });
}

// ---------------- BREAKOUT ----------------
export interface BreakoutOpts {
  lives?: number;
  ballSpeed?: number;
  rows?: number;
  accent?: string;
}
export function buildBreakout(o: BreakoutOpts = {}): string {
  const lives = o.lives ?? 3;
  const ballSpeed = o.ballSpeed ?? 340;
  const rows = Math.min(8, Math.max(3, o.rows ?? 5));
  const js =
    SFX_JS +
    "\n" +
    "var CONFIG={lives:" + lives + ",ballSpeed:" + ballSpeed + ",rows:" + rows + "};\n" +
    [
      "var cv=document.getElementById('game'),ctx=cv.getContext('2d'),W=cv.width,H=cv.height;",
      "var pad,ball,bricks,parts,score,lifeCount,level,high=__store.get('af_brk_high',0),state='title',stuck=true;",
      "var keys={};var COLORS=['#ff5d5d','#ff9f43','#ffd32a','#7CFC00','#5df2ff','#b45dff','#ff5df2','#8b9dff'];",
      "function buildBricks(){bricks=[];var cols=9,gap=6,mw=8;var bw=(W-mw*2-gap*(cols-1))/cols;for(var r=0;r<CONFIG.rows;r++){for(var c=0;c<cols;c++){bricks.push({x:mw+c*(bw+gap),y:56+r*24,w:bw,h:18,hp:r===0&&level>2?2:1,c:COLORS[r%COLORS.length]});}}}",
      "function resetBall(){ball={x:pad.x,y:pad.y-10,vx:0,vy:0,r:6};stuck=true;}",
      "function newGame(){score=0;lifeCount=CONFIG.lives;level=1;pad={x:W/2,y:H-30,w:78,h:12};parts=[];buildBricks();resetBall();state='play';__hideOverlay();}",
      "function launch(){if(!stuck)return;stuck=false;var a=-Math.PI/2+(Math.random()*0.6-0.3);ball.vx=Math.cos(a)*CONFIG.ballSpeed;ball.vy=Math.sin(a)*CONFIG.ballSpeed;__sfx(500,0.08,'square',0.04);}",
      "function boom(x,y,c){for(var i=0;i<10;i++){var a=Math.random()*6.28,s=60+Math.random()*120;parts.push({x:x,y:y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,t:0.5,c:c});}}",
      "function update(dt){var spd=380;if(keys['ArrowLeft']||keys['a'])pad.x-=spd*dt;if(keys['ArrowRight']||keys['d'])pad.x+=spd*dt;pad.x=Math.max(pad.w/2+4,Math.min(W-pad.w/2-4,pad.x));",
      "if(stuck){ball.x=pad.x;__hud('SCORE '+score+'  ×'+lifeCount,'LV '+level+' · BEST '+Math.max(high,score));return;}",
      "ball.x+=ball.vx*dt;ball.y+=ball.vy*dt;",
      "if(ball.x<ball.r){ball.x=ball.r;ball.vx=Math.abs(ball.vx);__sfx(300,0.05,'square',0.03);}if(ball.x>W-ball.r){ball.x=W-ball.r;ball.vx=-Math.abs(ball.vx);__sfx(300,0.05,'square',0.03);}if(ball.y<ball.r){ball.y=ball.r;ball.vy=Math.abs(ball.vy);__sfx(300,0.05,'square',0.03);}",
      "if(ball.vy>0&&ball.y+ball.r>=pad.y-6&&ball.y+ball.r<=pad.y+10&&Math.abs(ball.x-pad.x)<=pad.w/2+ball.r){var rel=(ball.x-pad.x)/(pad.w/2);var sp=Math.sqrt(ball.vx*ball.vx+ball.vy*ball.vy);var ang=-Math.PI/2+rel*1.05;ball.vx=Math.cos(ang)*sp;ball.vy=Math.sin(ang)*sp;ball.y=pad.y-7-ball.r;__sfx(440+rel*160,0.06,'square',0.035);}",
      "for(var i=bricks.length-1;i>=0;i--){var b=bricks[i];if(ball.x+ball.r>b.x&&ball.x-ball.r<b.x+b.w&&ball.y+ball.r>b.y&&ball.y-ball.r<b.y+b.h){var ox=Math.min(ball.x+ball.r-b.x,b.x+b.w-(ball.x-ball.r));var oy=Math.min(ball.y+ball.r-b.y,b.y+b.h-(ball.y-ball.r));if(ox<oy){ball.vx*=-1;ball.x+=ball.vx>0?ox:-ox;}else{ball.vy*=-1;ball.y+=ball.vy>0?oy:-oy;}b.hp--;if(b.hp<=0){bricks.splice(i,1);score+=50;boom(b.x+b.w/2,b.y+b.h/2,b.c);__sfx(660+Math.random()*220,0.07,'square',0.04);}else{__sfx(240,0.06,'square',0.04);}break;}}",
      "for(var p=parts.length-1;p>=0;p--){var pt=parts[p];pt.t-=dt;pt.x+=pt.vx*dt;pt.y+=pt.vy*dt;if(pt.t<=0)parts.splice(p,1);}",
      "if(bricks.length===0){score+=200*level;level++;buildBricks();resetBall();pad.w=Math.max(56,78-level*4);__sfx(880,0.15,'square',0.05);}",
      "if(ball.y>H+20){lifeCount--;__sfx(180,0.35,'sawtooth',0.06,50);if(lifeCount<=0){if(score>high){high=score;__store.set('af_brk_high',high);}state='over';__overlay('<div class=\"big\">🧱</div><h2>GAME OVER</h2><p>Score '+score+' · Level '+level+'<br>Best '+high+'<br><br>Press R or tap Restart</p>');}else{resetBall();pad.w=78;}}",
      "__hud('SCORE '+score+'  ×'+lifeCount,'LV '+level+' · BEST '+Math.max(high,score));}",
      "function draw(){ctx.fillStyle='#05070f';ctx.fillRect(0,0,W,H);for(var i=0;i<bricks.length;i++){var b=bricks[i];ctx.fillStyle=b.c;ctx.beginPath();ctx.roundRect(b.x,b.y,b.w,b.h,5);ctx.fill();if(b.hp>1){ctx.fillStyle='rgba(255,255,255,.45)';ctx.fillRect(b.x+4,b.y+4,b.w-8,3);}ctx.fillStyle='rgba(255,255,255,.25)';ctx.fillRect(b.x+3,b.y+2,b.w-6,2);}",
      "ctx.fillStyle='#5df2ff';ctx.beginPath();ctx.roundRect(pad.x-pad.w/2,pad.y-6,pad.w,12,6);ctx.fill();",
      "ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(ball.x,ball.y,ball.r,0,7);ctx.fill();",
      "for(var p=0;p<parts.length;p++){var pt=parts[p];ctx.globalAlpha=Math.max(0,pt.t*2);ctx.fillStyle=pt.c;ctx.fillRect(pt.x-2,pt.y-2,4,4);}ctx.globalAlpha=1;}",
      "var last=0;",
      "function loop(ts){requestAnimationFrame(loop);var dt=Math.min(0.033,(ts-last)/1000||0.016);last=ts;if(state==='play')update(dt);if(state!=='title')draw();}",
      "cv.addEventListener('pointermove',function(e){if(state!=='play')return;var r=cv.getBoundingClientRect();pad.x=(e.clientX-r.left)/r.width*W;});",
      "window.__start=function(){newGame();};",
      "window.addEventListener('keydown',function(e){keys[e.key.length===1?e.key.toLowerCase():e.key]=true;var k=e.key;if(k===' '){if(state==='play')launch();else if(state==='title')newGame();}else if(k==='p'||k==='P'){if(state==='play'){state='pause';__overlay('<div class=\"big\">⏸</div><h2>PAUSED</h2><p>Press P to resume</p>');}else if(state==='pause'){state='play';__hideOverlay();}}else if(k==='m'||k==='M'){__muted=!__muted;}else if(k==='r'||k==='R'){if(state!=='title')newGame();}else if(k==='Enter'&&state==='title'){newGame();}});",
      "window.addEventListener('keyup',function(e){keys[e.key.length===1?e.key.toLowerCase():e.key]=false;});",
      "pad={x:W/2,y:H-30,w:78,h:12};ball={x:W/2,y:H-40,vx:0,vy:0,r:6};bricks=[];parts=[];score=0;lifeCount=CONFIG.lives;level=1;buildBricks();state='title';__overlay('<div class=\"big\">🧱</div><h2>BREAKOUT</h2><p>◀ ▶ / mouse / touch to move · Space / tap to launch.<br>Grey-striped bricks take 2 hits.<br><br><button onclick=\"__start()\">▶ START</button></p>');__hud('SCORE 0  ×'+CONFIG.lives,'LV 1 · BEST '+high);requestAnimationFrame(loop);",
    ].join("\n");
  return gameShell({ title: "Breakout", tagline: "arcade-classic · generated fully offline", width: 460, height: 560, accent: o.accent ?? "#ff9f43", js, help: ["◀ ▶ / mouse — paddle · Space / tap — launch", "P — pause · M — sound · R — restart"], actionLabel: "LAUNCH" });
}

// ---------------- PONG ----------------
export interface PongOpts {
  winScore?: number;
  aiSpeed?: number;
  ballSpeed?: number;
  accent?: string;
}
export function buildPong(o: PongOpts = {}): string {
  const winScore = o.winScore ?? 7;
  const aiSpeed = o.aiSpeed ?? 300;
  const ballSpeed = o.ballSpeed ?? 360;
  const js =
    SFX_JS +
    "\n" +
    "var CONFIG={win:" + winScore + ",ai:" + aiSpeed + ",spd:" + ballSpeed + "};\n" +
    [
      "var cv=document.getElementById('game'),ctx=cv.getContext('2d'),W=cv.width,H=cv.height;",
      "var you,cpu,ball,state='title',serveT=0,keys={},trail=[];",
      "function resetPositions(){you={x:16,y:H/2,w:10,h:74,vy:0};cpu={x:W-16,y:H/2,w:10,h:74};}",
      "function serve(toward){ball={x:W/2,y:H/2,r:7};var a=(toward||1)*(0.35+Math.random()*0.5)*(Math.random()<0.5?1:-1);var dir=toward||(Math.random()<0.5?1:-1);ball.vx=Math.cos(a)*CONFIG.spd*dir;ball.vy=Math.sin(a)*CONFIG.spd;trail=[];}",
      "function newGame(){you.s=0;cpu.s=0;resetPositions();serve();state='play';__hideOverlay();}",
      "function update(dt){var ps=380;if(keys['ArrowUp']||keys['w'])you.y-=ps*dt;if(keys['ArrowDown']||keys['s'])you.y+=ps*dt;you.y=Math.max(you.h/2,Math.min(H-you.h/2,you.y));",
      "var target=ball.vx>0?ball.y+ball.vy*0.12:H/2;var dy=target-cpu.y;cpu.y+=Math.max(-CONFIG.ai*dt,Math.min(CONFIG.ai*dt,dy));cpu.y=Math.max(cpu.h/2,Math.min(H-cpu.h/2,cpu.y));",
      "ball.x+=ball.vx*dt;ball.y+=ball.vy*dt;trail.push({x:ball.x,y:ball.y,t:0.25});if(trail.length>24)trail.shift();for(var t=trail.length-1;t>=0;t--){trail[t].t-=dt;if(trail[t].t<=0)trail.splice(t,1);}",
      "if(ball.y<ball.r){ball.y=ball.r;ball.vy=Math.abs(ball.vy);__sfx(280,0.05,'square',0.03);}if(ball.y>H-ball.r){ball.y=H-ball.r;ball.vy=-Math.abs(ball.vy);__sfx(280,0.05,'square',0.03);}",
      "function paddle(p,dir){if((dir>0&&ball.vx<0)||(dir<0&&ball.vx>0)){if(Math.abs(ball.x-p.x)<p.w/2+ball.r&&Math.abs(ball.y-p.y)<p.h/2+ball.r){var rel=(ball.y-p.y)/(p.h/2);var sp=Math.min(720,Math.sqrt(ball.vx*ball.vx+ball.vy*ball.vy)*1.045);var ang=rel*1.0;ball.vx=-dir*Math.cos(ang)*sp;ball.vy=Math.sin(ang)*sp;ball.x=p.x-dir*(p.w/2+ball.r+1);__sfx(520+Math.abs(rel)*200,0.06,'square',0.04);}}}",
      "paddle(you,1);paddle(cpu,-1);",
      "if(ball.x<-20){cpu.s++;__sfx(160,0.25,'sawtooth',0.05,70);checkWinOrServe(-1);}else if(ball.x>W+20){you.s++;__sfx(700,0.12,'square',0.05);checkWinOrServe(1);}",
      "__hud('YOU '+you.s+' : '+cpu.s+' CPU','FIRST TO '+CONFIG.win);}",
      "function checkWinOrServe(dir){if(you.s>=CONFIG.win||cpu.s>=CONFIG.win){state='over';var win=you.s>cpu.s;__sfx(win?880:150,0.4,'square',0.06);__overlay('<div class=\"big\">'+(win?'🏆':'🤖')+'</div><h2>'+(win?'YOU WIN!':'CPU WINS')+'</h2><p>'+you.s+' : '+cpu.s+'<br><br>Press R for rematch</p>');}else serve(-dir);}",
      "function draw(){ctx.fillStyle='#05070f';ctx.fillRect(0,0,W,H);ctx.fillStyle='#1a2340';for(var y=8;y<H;y+=22){ctx.fillRect(W/2-2,y,4,12);}",
      "for(var t=0;t<trail.length;t++){ctx.globalAlpha=trail[t].t*2;ctx.fillStyle='#5df2ff';ctx.beginPath();ctx.arc(trail[t].x,trail[t].y,ball.r*trail[t].t*2.4,0,7);ctx.fill();}ctx.globalAlpha=1;",
      "ctx.fillStyle='#5df2ff';ctx.fillRect(you.x-you.w/2,you.y-you.h/2,you.w,you.h);ctx.fillStyle='#ff5d5d';ctx.fillRect(cpu.x-cpu.w/2,cpu.y-cpu.h/2,cpu.w,cpu.h);",
      "ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(ball.x,ball.y,ball.r,0,7);ctx.fill();}",
      "var last=0;",
      "function loop(ts){requestAnimationFrame(loop);var dt=Math.min(0.033,(ts-last)/1000||0.016);last=ts;if(state==='play')update(dt);if(state!=='title')draw();}",
      "cv.addEventListener('pointermove',function(e){if(state!=='play')return;var r=cv.getBoundingClientRect();you.y=(e.clientY-r.top)/r.height*H;});",
      "window.__start=function(){you.s=0;cpu.s=0;resetPositions();serve();state='play';__hideOverlay();};",
      "window.addEventListener('keydown',function(e){keys[e.key.length===1?e.key.toLowerCase():e.key]=true;var k=e.key;if(k==='p'||k==='P'){if(state==='play'){state='pause';__overlay('<div class=\"big\">⏸</div><h2>PAUSED</h2><p>Press P to resume</p>');}else if(state==='pause'){state='play';__hideOverlay();}}else if(k==='m'||k==='M'){__muted=!__muted;}else if(k==='r'||k==='R'){if(state!=='title')__start();}else if((k===' '||k==='Enter')&&state==='title'){__start();}});",
      "window.addEventListener('keyup',function(e){keys[e.key.length===1?e.key.toLowerCase():e.key]=false;});",
      "resetPositions();you.s=0;cpu.s=0;serve(1);state='title';__overlay('<div class=\"big\">🏓</div><h2>PONG</h2><p>First to '+CONFIG.win+'.<br>▲ ▼ / W S / mouse / touch.<br><br><button onclick=\"__start()\">▶ START</button></p>');__hud('YOU 0 : 0 CPU','FIRST TO '+CONFIG.win);requestAnimationFrame(loop);",
    ].join("\n");
  return gameShell({ title: "Pong", tagline: "arcade-classic · generated fully offline", width: 480, height: 360, accent: o.accent ?? "#5df2ff", js, help: ["▲ ▼ / W S / mouse — paddle", "Ball speeds up every rally", "P — pause · M — sound · R — restart"], actionLabel: "⏸" });
}
