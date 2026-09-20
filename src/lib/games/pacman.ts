// Verified offline core: Maze Chase (Pac-Man-classic).
// Complete playable game: maze, pellets, power pellets, 4 ghost
// personalities (chase/scatter/frightened/eyes), fruit, score, lives,
// levels, sounds, keyboard + touch. Single-file HTML, zero network.

import { gameShell, SFX_JS } from "./shell";

export interface PacmanOpts {
  lives?: number;
  pacSpeed?: number;
  ghostSpeed?: number;
  frightTime?: number;
  accent?: string;
}

const MAZE = [
  "###################",
  "#........#........#",
  "#.##.###.#.###.##.#",
  "#o##.###.#.###.##o#",
  "#.##.###.#.###.##.#",
  "#.................#",
  "#.##.#.##D##.#.##.#",
  "#.##.#.#GGG#.#.##.#",
  "#....#.#GGG#.#....#",
  "#.##.#.#GGG#.#.##.#",
  "#.##.#.#####.#.##.#",
  "#.................#",
  "#.##.###.#.###.##.#",
  "#o##.....#.....##o#",
  "#.###.#.###.#.###.#",
  "#.....#..P..#.....#",
  "###################",
];

export function buildPacman(o: PacmanOpts = {}): string {
  const lives = o.lives ?? 3;
  const pacSpeed = o.pacSpeed ?? 118;
  const ghostSpeed = o.ghostSpeed ?? 94;
  const frightTime = o.frightTime ?? 6;

  const js =
    SFX_JS +
    "\n" +
    "var CONFIG={lives:" + lives + ",pacSpeed:" + pacSpeed + ",ghostSpeed:" + ghostSpeed + ",frightTime:" + frightTime + ",tile:24};\n" +
    "var MAZE=" + JSON.stringify(MAZE) + ";\n" +
    [
      "var W=19,H=17,T=CONFIG.tile,cv=document.getElementById('game'),ctx=cv.getContext('2d');",
      "var grid=[],pellets=0,totalPellets=0,pacStart={x:9,y:15};",
      "function buildGrid(){grid=[];pellets=0;for(var y=0;y<H;y++){grid[y]=[];var row=(MAZE[y]+'###################').slice(0,W);for(var x=0;x<W;x++){var c=row.charAt(x);var v=0;if(c==='#')v=1;else if(c==='.') {v=2;pellets++;} else if(c==='o'){v=3;pellets++;} else if(c==='D')v=4;else if(c==='G')v=5;else if(c==='P'){pacStart={x:x,y:y};}grid[y][x]=v;}}totalPellets=pellets;}",
      "function tileAt(x,y){if(x<0||y<0||x>=W||y>=H)return 1;return grid[y][x];}",
      "function passPac(x,y){var t=tileAt(x,y);return t!==1&&t!==4&&t!==5;}",
      "function passGhost(x,y){var t=tileAt(x,y);return t===0||t===2||t===3;}",
      "var DIRS=[{x:1,y:0},{x:-1,y:0},{x:0,y:1},{x:0,y:-1}];",
      "var score=0,lifeCount=CONFIG.lives,level=1,high=__store.get('af_pac_high',0);",
      "var fright=0,modeIdx=0,modeTimer=0,ghostCombo=0,eaten=0,fruit=null,fruitTimer=0;",
      "var MODES=['scatter','chase','scatter','chase','scatter','chase'];",
      "var MODE_LEN=[5,20,5,20,4,99999];",
      "var pac={x:0,y:0,dir:{x:0,y:0},want:{x:-1,y:0},mouth:0};",
      "var ghosts=[];",
      "var GHOST_DEFS=[{n:'Blinky',c:'#ff3b3b',sx:9,sy:7,corner:{x:17,y:1},rel:0},{n:'Pinky',c:'#ffb3ff',sx:8,sy:8,corner:{x:1,y:1},rel:1},{n:'Inky',c:'#00e8ff',sx:9,sy:8,corner:{x:17,y:15},rel:4},{n:'Clyde',c:'#ffb847',sx:10,sy:8,corner:{x:1,y:15},rel:8}];",
      "var state='ready',readyT=0,deadT=0,state='title';",
      "function px(x){return (x+0.5)*T;}",
      "function resetPositions(){pac.x=px(pacStart.x);pac.y=px(pacStart.y);pac.dir={x:0,y:0};pac.want={x:-1,y:0};ghosts=[];for(var i=0;i<4;i++){var d=GHOST_DEFS[i];ghosts.push({def:d,x:px(d.sx),y:px(d.sy),dir:{x:0,y:0},st:'house',relT:Math.max(0,d.rel-(level-1)),fright:false,eyes:false,retarget:0,tx:0,ty:0});}fright=0;ghostCombo=0;fruit=null;}",
      "function newGame(){score=0;lifeCount=CONFIG.lives;level=1;buildGrid();resetPositions();state='ready';readyT=2;eaten=0;__hideOverlay();}",
      "function nextLevel(){level++;buildGrid();resetPositions();state='ready';readyT=2;__hideOverlay();}",
      "function ghostTarget(g){var m=MODES[Math.min(modeIdx,MODES.length-1)];var ptx=Math.floor(pac.x/T),pty=Math.floor(pac.y/T);if(g.eyes)return {x:9,y:5};if(m==='scatter'&&!g.fright)return g.def.corner;var n=g.def.n;if(n==='Blinky')return {x:ptx,y:pty};if(n==='Pinky')return {x:ptx+pac.dir.x*2,y:pty+pac.dir.y*2};if(n==='Clyde'){var dx=g.x/T-ptx,dy=g.y/T-pty;if(dx*dx+dy*dy>64)return {x:ptx,y:pty};return g.def.corner;}return {x:g.tx,y:g.ty};}",
      "function decideGhost(g,tx,ty){var opts=[];for(var i=0;i<4;i++){var d=DIRS[i];if(d.x===-g.dir.x&&d.y===-g.dir.y&&(g.dir.x!==0||g.dir.y!==0))continue;var nx=tx+d.x,ny=ty+d.y;if(g.eyes||passGhost(nx,ny)||(nx===9&&(ny===6||ny===5)))opts.push(d);}if(opts.length===0){g.dir={x:-g.dir.x,y:-g.dir.y};return;}if(g.fright&&!g.eyes){g.dir=opts[Math.floor(Math.random()*opts.length)];return;}var t=ghostTarget(g);var best=opts[0],bd=1e9;for(var j=0;j<opts.length;j++){var dx=tx+opts[j].x-t.x,dy=ty+opts[j].y-t.y;var dd=dx*dx+dy*dy;if(dd<bd){bd=dd;best=opts[j];}}g.dir={x:best.x,y:best.y};}",
      "function stepMove(e,dt,decide){var tx=Math.floor(e.x/T),ty=Math.floor(e.y/T);var cx=(tx+0.5)*T,cy=(ty+0.5)*T;var snap=e.speed*dt+0.6;if(Math.abs(e.x-cx)<=snap&&Math.abs(e.y-cy)<=snap){e.x=cx;e.y=cy;decide(e,tx,ty);}e.x+=e.dir.x*e.speed*dt;e.y+=e.dir.y*e.speed*dt;}",
      "function update(dt){",
      "if(fright>0){fright-=dt;if(fright<=0){for(var i=0;i<4;i++){ghosts[i].fright=false;}}}",
      "modeTimer+=dt;if(modeIdx<MODE_LEN.length&&modeTimer>MODE_LEN[modeIdx]){modeTimer=0;modeIdx++;for(var r=0;r<4;r++){var g=ghosts[r];if(g.st==='out'&&!g.eyes){g.dir={x:-g.dir.x,y:-g.dir.y};}}}",
      "pac.speed=CONFIG.pacSpeed+(level-1)*5+(fright>0?8:0);pac.mouth+=dt*10;",
      "stepMove(pac,dt,function(e,tx,ty){if((e.want.x!==e.dir.x||e.want.y!==e.dir.y)&&passPac(tx+e.want.x,ty+e.want.y)){e.dir={x:e.want.x,y:e.want.y};}if(!passPac(tx+e.dir.x,ty+e.dir.y)){e.dir={x:0,y:0};}});",
      "var ptx=Math.floor(pac.x/T),pty=Math.floor(pac.y/T);var tt=tileAt(ptx,pty);",
      "if(tt===2||tt===3){grid[pty][ptx]=0;pellets--;eaten++;if(tt===2){score+=10;__sfx(eaten%2?320:430,0.06,'square',0.03);}else{score+=50;fright=CONFIG.frightTime;ghostCombo=0;for(var f=0;f<4;f++){var gf=ghosts[f];if(gf.st==='out'&&!gf.eyes){gf.fright=true;gf.dir={x:-gf.dir.x,y:-gf.dir.y};}}__sfx(140,0.35,'sawtooth',0.05);}if(eaten===50&&!fruit){fruit={x:px(9),y:px(11),t:9};}if(pellets<=0){score+=500*level;__sfx(660,0.12,'square',0.05);__sfx(880,0.15,'square',0.05);nextLevel();return;}}",
      "if(fruit){fruit.t-=dt;if(fruit.t<=0)fruit=null;else{var fdx=pac.x-fruit.x,fdy=pac.y-fruit.y;if(fdx*fdx+fdy*fdy<T*T){score+=500;fruit=null;__sfx(990,0.2,'square',0.05);}}}",
      "for(var gi=0;gi<4;gi++){var g=ghosts[gi];",
      "if(g.st==='house'){g.relT-=dt;g.y+=Math.sin(Date.now()/180+gi)*dt*8;if(g.relT<=0){g.st='exit';}continue;}",
      "if(g.st==='exit'){var dx=px(9)-g.x;g.dir={x:0,y:0};if(Math.abs(dx)>2){g.x+=Math.sign(dx)*70*dt;}else{g.x=px(9);g.y-=90*dt;if(g.y<=px(5)){g.y=px(5);g.st='out';g.dir={x:gi%2?-1:1,y:0};}}continue;}",
      "if(g.def.n==='Inky'){g.retarget-=dt;if(g.retarget<=0){g.retarget=2;g.tx=1+Math.floor(Math.random()*17);g.ty=1+Math.floor(Math.random()*15);}}",
      "g.speed=g.eyes?230:(g.fright?CONFIG.ghostSpeed*0.62:CONFIG.ghostSpeed+(level-1)*6);",
      "stepMove(g,dt,function(e,tx2,ty2){decideGhost(e,tx2,ty2);});",
      "if(g.eyes){var ex=Math.floor(g.x/T),ey=Math.floor(g.y/T);if(ex===9&&(ey===6||ey===5)){g.eyes=false;g.fright=false;g.st='exit';g.x=px(9);g.y=px(7);continue;}}",
      "var ddx=pac.x-g.x,ddy=pac.y-g.y;",
      "if(ddx*ddx+ddy*ddy<T*T*0.55){if(g.eyes){}else if(g.fright){g.eyes=true;g.fright=false;ghostCombo++;score+=[0,200,400,800,1600][Math.min(ghostCombo,4)];__sfx(760,0.18,'square',0.05);}else{die();return;}}}",
      "__hud('SCORE '+score+'  ×'+lifeCount,'LV '+level+' · BEST '+Math.max(high,score));}",
      "function die(){lifeCount--;__sfx(400,0.5,'sawtooth',0.06,60);if(lifeCount<=0){if(score>high){high=score;__store.set('af_pac_high',high);}state='over';__overlay('<div class=\"big\">💀</div><h2>GAME OVER</h2><p>Score '+score+' · Level '+level+'<br>Best '+high+'<br><br>Press R or tap Restart</p>');}else{resetPositions();state='ready';readyT=1.5;}}",
      "function draw(){ctx.fillStyle='#05070f';ctx.fillRect(0,0,cv.width,cv.height);",
      "for(var y=0;y<H;y++){for(var x=0;x<W;x++){var t=grid[y][x];var X=x*T,Y=y*T;if(t===1){ctx.fillStyle='#1c2f9e';ctx.beginPath();ctx.roundRect(X+1,Y+1,T-2,T-2,6);ctx.fill();ctx.strokeStyle='#3d5bff';ctx.lineWidth=1.5;ctx.stroke();}else if(t===2){ctx.fillStyle='#ffd9a0';ctx.beginPath();ctx.arc(X+T/2,Y+T/2,2.4,0,7);ctx.fill();}else if(t===3){var p=3.4+Math.sin(Date.now()/200)*1.4;ctx.fillStyle='#ffdf80';ctx.beginPath();ctx.arc(X+T/2,Y+T/2,p,0,7);ctx.fill();}else if(t===4){ctx.fillStyle='#ff9de2';ctx.fillRect(X+2,Y+T/2-2,T-4,4);}}}",
      "if(fruit){ctx.fillStyle='#ff2d55';ctx.beginPath();ctx.arc(fruit.x,fruit.y,7,0,7);ctx.fill();ctx.strokeStyle='#7CFC00';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(fruit.x,fruit.y-7);ctx.lineTo(fruit.x+5,fruit.y-13);ctx.stroke();}",
      "for(var i=0;i<4;i++){var g=ghosts[i];drawGhost(g);}",
      "var m=Math.abs(Math.sin(pac.mouth))*0.32;var ang=pac.dir.x===1?0:pac.dir.x===-1?Math.PI:pac.dir.y===1?Math.PI/2:pac.dir.y===-1?-Math.PI/2:0;ctx.fillStyle='#ffe600';ctx.beginPath();ctx.moveTo(pac.x,pac.y);ctx.arc(pac.x,pac.y,T/2-2,ang+0.25+m,ang+Math.PI*2-0.25-m);ctx.closePath();ctx.fill();}",
      "function drawGhost(g){var x=g.x,y=g.y,r=T/2-1;var body=g.eyes?'rgba(0,0,0,0)':(g.fright?(fright<2&&Math.floor(Date.now()/200)%2?'#e8ecf5':'#2431ff'):g.def.c);if(!g.eyes){ctx.fillStyle=body;ctx.beginPath();ctx.arc(x,y-2,r,Math.PI,0);ctx.lineTo(x+r,y+r);for(var s=0;s<3;s++){ctx.lineTo(x+r-(s*2+1)*r/3,y+r-3);ctx.lineTo(x+r-(s*2+2)*r/3,y+r);}ctx.closePath();ctx.fill();}var ex=g.dir.x*2.5,ey=g.dir.y*2.5;ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(x-4.5+ex,y-4+ey,3.4,0,7);ctx.arc(x+4.5+ex,y-4+ey,3.4,0,7);ctx.fill();ctx.fillStyle=g.fright&&!g.eyes?'#ff9d9d':'#2431ff';ctx.beginPath();ctx.arc(x-4.5+ex*1.6,y-4+ey*1.6,1.8,0,7);ctx.arc(x+4.5+ex*1.6,y-4+ey*1.6,1.8,0,7);ctx.fill();if(g.fright&&!g.eyes){ctx.strokeStyle='#ffb3ab';ctx.lineWidth=1.4;ctx.beginPath();for(var z=0;z<4;z++){var zx=x-8+z*5.4;ctx.moveTo(zx,y+5);ctx.lineTo(zx+2.6,y+8);ctx.lineTo(zx+5.2,y+5);}ctx.stroke();}}",
      "var last=0;",
      "function loop(ts){requestAnimationFrame(loop);var dt=Math.min(0.033,(ts-last)/1000||0.016);last=ts;if(state==='play'){update(dt);}else if(state==='ready'){readyT-=dt;if(readyT<=0){state='play';__hideOverlay();}}draw();}",
      "function startScreen(){state='title';__overlay('<div class=\"big\">👻</div><h2>MAZE CHASE</h2><p>Eat all pellets. Avoid the ghosts — unless powered up.<br>Arrows / WASD / swipe / dpad.<br><br><button onclick=\"__start()\">▶ START</button></p>');}",
      "window.__start=function(){newGame();};",
      "window.addEventListener('keydown',function(e){var k=e.key;if(k==='ArrowUp'||k==='w'||k==='W')pac.want={x:0,y:-1};else if(k==='ArrowDown'||k==='s'||k==='S')pac.want={x:0,y:1};else if(k==='ArrowLeft'||k==='a'||k==='A')pac.want={x:-1,y:0};else if(k==='ArrowRight'||k==='d'||k==='D')pac.want={x:1,y:0};else if(k==='p'||k==='P'){if(state==='play'){state='pause';__overlay('<div class=\"big\">⏸</div><h2>PAUSED</h2><p>Press P to resume</p>');}else if(state==='pause'){state='play';__hideOverlay();}}else if(k==='m'||k==='M'){__muted=!__muted;}else if(k==='r'||k==='R'){newGame();}else if((k===' '||k==='Enter')&&state==='title'){newGame();}});",
      "buildGrid();resetPositions();startScreen();__hud('SCORE 0  ×'+CONFIG.lives,'LV 1 · BEST '+high);requestAnimationFrame(loop);",
    ].join("\n");

  return gameShell({
    title: "Maze Chase",
    tagline: "pac-man-classic · generated fully offline · no internet used",
    width: 19 * 24,
    height: 17 * 24,
    accent: "#ffe600",
    js,
    help: ["Arrows / WASD / swipe — steer", "Power pellets turn the hunt around", "P — pause · M — sound · R — restart"],
    actionLabel: "⏸",
  });
}
