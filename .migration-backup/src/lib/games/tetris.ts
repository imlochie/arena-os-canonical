// Verified offline core: Tetris.
// Complete playable single-file game, zero network.
// Parameterized: board size, start level, gravity curve, ghost piece, hold,
// next-queue depth, accent. Mods from any prompt (speed/difficulty/theme).

import { gameShell, SFX_JS } from "./shell";

export interface TetrisOpts {
  cols?: number; // board width (6–14)
  rows?: number; // board height (14–24)
  startLevel?: number; // 1–15
  gravityMs?: number; // ms per row at level 1 (default 850)
  ghost?: boolean;
  hold?: boolean;
  nextCount?: number; // next-piece queue depth (1–5)
  accent?: string;
}

const PIECE_COLORS = ["#22d3ee", "#3b82f6", "#f97316", "#facc15", "#4ade80", "#a78bfa", "#ef4444"];

export function buildTetris(o: TetrisOpts = {}): string {
  const cols = Math.min(14, Math.max(6, o.cols ?? 10));
  const rows = Math.min(24, Math.max(14, o.rows ?? 20));
  const startLevel = Math.min(15, Math.max(1, o.startLevel ?? 1));
  const gravityMs = o.gravityMs ?? 850;
  const ghost = o.ghost ?? true;
  const hold = o.hold ?? true;
  const nextCount = Math.min(5, Math.max(1, o.nextCount ?? 3));
  const cell = 24;
  const sideW = 6 * cell;
  const js =
    SFX_JS +
    "\n" +
    "var CONFIG={cols:" + cols + ",rows:" + rows + ",startLevel:" + startLevel + ",gravityMs:" + gravityMs + ",ghost:" + (ghost ? "true" : "false") + ",hold:" + (hold ? "true" : "false") + ",nextCount:" + nextCount + "};\n" +
    [
      "var cv=document.getElementById('game'),ctx=cv.getContext('2d'),C=CONFIG.cols,R=CONFIG.rows,T=" + cell + ";",
      "var COLORS=" + JSON.stringify(PIECE_COLORS) + ";",
      // piece base matrices (I on 4x4, O on 2x2, rest 3x3); 4 rotations precomputed
      "var BASE=[" +
        "[[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]]," +
        "[[1,0,0],[1,1,1],[0,0,0]]," +
        "[[0,0,1],[1,1,1],[0,0,0]]," +
        "[[1,1],[1,1]]," +
        "[[0,1,1],[1,1,0],[0,0,0]]," +
        "[[0,1,0],[1,1,1],[0,0,0]]," +
        "[[1,1,0],[0,1,1],[0,0,0]]];",
      "function rot(m){var n=m.length,r=[];for(var y=0;y<n;y++){r.push([]);for(var x=0;x<n;x++)r[y].push(m[n-1-x][y]);}return r;}",
      "var SHAPES=BASE.map(function(b){var s=[b];for(var i=1;i<4;i++)s.push(rot(s[i-1]));return s;});",
      "var KICKS=[[0,0],[-1,0],[1,0],[0,-1],[-2,0],[2,0],[0,-2]];",
      "var board,cur,curRot,px,py,holdIdx,canHold,bag,next,queue,score,lines,level,high=__store.get('af_tetris_high',0),state='title',acc=0,dropAcc=0;",
      "function refill(){if(bag.length===0){bag=[0,1,2,3,4,5,6];for(var i=6;i>0;i--){var j=Math.floor(Math.random()*(i+1));var t=bag[i];bag[i]=bag[j];bag[j]=t;}}return bag.shift();}",
      "function fillQueue(){while(queue.length<CONFIG.nextCount+1)queue.push(refill());}",
      "function collides(p,r,x,y){var m=SHAPES[p][r];for(var yy=0;yy<m.length;yy++)for(var xx=0;xx<m.length;xx++){if(!m[yy][xx])continue;var bx=x+xx,by=y+yy;if(bx<0||bx>=C||by>=R||by>=0&&board[by][bx])return true;}return false;}",
      "function spawn(){cur=queue.shift();fillQueue();curRot=0;px=Math.floor((C-SHAPES[cur][0].length)/2);py=-1;canHold=true;if(collides(cur,curRot,px,py+1)){gameOver();}}",
      "function tryRotate(dir){if(!cur&&cur!==0)return;var nr=(curRot+dir+4)%4;for(var i=0;i<KICKS.length;i++){var k=KICKS[i];if(!collides(cur,nr,px+k[0],py+k[1])){curRot=nr;px+=k[0];py+=k[1];__sfx(300,0.05,'square',0.02);return;}}}",
      "function merge(){var m=SHAPES[cur][curRot];for(var yy=0;yy<m.length;yy++)for(var xx=0;xx<m.length;xx++){if(m[yy][xx]){var by=py+yy;if(by>=0)board[by][px+xx]=cur+1;}}}",
      "function clearLines(){var cleared=0;for(var y=R-1;y>=0;y--){var full=true;for(var x=0;x<C;x++){if(!board[y][x]){full=false;break;}}if(full){board.splice(y,1);board.unshift(new Array(C).fill(0));cleared++;y++;}}if(cleared){score+=[0,100,300,500,800][cleared]*level;lines+=cleared;var nl=CONFIG.startLevel+Math.floor(lines/10);if(nl>level){level=nl;__sfx(880,0.15,'square',0.05);}else{__sfx(520+cleared*90,0.12,'square',0.045);}if(score>high){high=score;__store.set('af_tetris_high',high);}}}",
      "function gravityMs(){return Math.max(50,CONFIG.gravityMs*Math.pow(0.82,level-CONFIG.startLevel));}",
      "function lockPiece(){merge();clearLines();spawn();acc=0;}",
      "function step(down){if(collides(cur,curRot,px,py+1)){lockPiece();return;}py++;if(down){score++;acc=0;}}",
      "function hardDrop(){var d=0;while(!collides(cur,curRot,px,py+1)){py++;d++;}score+=d*2;__sfx(180,0.1,'sawtooth',0.04,70);lockPiece();}",
      "function doHold(){if(!CONFIG.hold||!canHold)return;canHold=false;if(holdIdx===null){holdIdx=cur;spawn();}else{var t=holdIdx;holdIdx=cur;cur=t;curRot=0;px=Math.floor((C-SHAPES[cur][0].length)/2);py=-1;if(collides(cur,curRot,px,py+1))gameOver();}__sfx(420,0.06,'triangle',0.03);}",
      "function ghostY(){if(!CONFIG.ghost)return -1;var gy=py;while(!collides(cur,curRot,px,gy+1))gy++;return gy;}",
      "function reset(){board=[];for(var y=0;y<R;y++)board.push(new Array(C).fill(0));bag=[];queue=[];fillQueue();holdIdx=null;score=0;lines=0;level=CONFIG.startLevel;spawn();}",
      "function newGame(){reset();state='play';__hideOverlay();__hud('SCORE 0','LINES 0 · LV '+level+' · BEST '+high);}",
      "function gameOver(){state='over';if(score>high){high=score;__store.set('af_tetris_high',high);}__sfx(200,0.5,'sawtooth',0.06,50);__overlay('<div class=\"big\">🧱</div><h2>STACK OVERFLOW</h2><p>Score '+score+' · Lines '+lines+' · Level '+level+'<br>Best '+high+'<br><br>Press R or tap Restart</p>');}",
      "function cellRect(x,y,ci,ghosty){var gx=x*T+C*T+0;if(ghosty){ctx.strokeStyle='rgba(160,180,220,.35)';ctx.lineWidth=2;ctx.strokeRect(x*T+2.5,y*T+2.5,T-5,T-5);return;}ctx.fillStyle=COLORS[ci];ctx.beginPath();ctx.roundRect(x*T+1.5,y*T+1.5,T-3,T-3,4);ctx.fill();ctx.fillStyle='rgba(255,255,255,.18)';ctx.fillRect(x*T+1.5,y*T+1.5,T-3,4);}",
      "function drawMini(m,ox,oy,ci){for(var yy=0;yy<m.length;yy++)for(var xx=0;xx<m.length;xx++){if(m[yy][xx]){ctx.fillStyle=COLORS[ci];ctx.beginPath();ctx.roundRect(ox+xx*(T-4)+1,oy+yy*(T-4)+1,T-6,T-6,3);ctx.fill();}}}",
      "function draw(){ctx.fillStyle='#05070f';ctx.fillRect(0,0,cv.width,cv.height);ctx.strokeStyle='#1a2340';ctx.lineWidth=1;for(var g=0;g<=C;g++){ctx.beginPath();ctx.moveTo(g*T,0);ctx.lineTo(g*T,R*T);ctx.stroke();}for(var g2=0;g2<=R;g2++){ctx.beginPath();ctx.moveTo(0,g2*T);ctx.lineTo(C*T,g2*T);ctx.stroke();}",
      "for(var y=0;y<R;y++)for(var x=0;x<C;x++){if(board[y][x])cellRect(x,y,board[y][x]-1,false);}",
      "if(state==='play'){var gy2=ghostY();if(gy2>py){var mg=SHAPES[cur][curRot];for(var yy2=0;yy2<mg.length;yy2++)for(var xx2=0;xx2<mg.length;xx2++){if(mg[yy2][xx2]&&gy2+yy2>=0)cellRect(px+xx2,gy2+yy2,cur,true);}}var mc=SHAPES[cur][curRot];for(var yy3=0;yy3<mc.length;yy3++)for(var xx3=0;xx3<mc.length;xx3++){if(mc[yy3][xx3]&&py+yy3>=0)cellRect(px+xx3,py+yy3,cur,false);}}",
      "var sx=C*T+12;ctx.textAlign='left';ctx.fillStyle='#8ea0c0';ctx.font='bold 10px system-ui';ctx.fillText('NEXT',sx,18);for(var q=0;q<CONFIG.nextCount;q++){var pi=queue[q];drawMini(SHAPES[pi][0],sx,26+q*62,pi);}",
      "if(CONFIG.hold){ctx.fillStyle='#8ea0c0';ctx.fillText('HOLD (C)',sx,26+CONFIG.nextCount*62+24);if(holdIdx!==null)drawMini(SHAPES[holdIdx][0],sx,26+CONFIG.nextCount*62+34,holdIdx);}",
      "__hud('SCORE '+score,'LINES '+lines+' · LV '+level+' · BEST '+high);}",
      "var last=0;",
      "function loop(ts){requestAnimationFrame(loop);var dt=Math.min(0.05,(ts-last)/1000||0.016);last=ts;if(state==='play'){acc+=dt*1000;var gm=gravityMs();while(acc>gm){acc-=gm;step(false);if(state!=='play')break;}}draw();}",
      "window.__start=function(){newGame();};",
      "window.addEventListener('keydown',function(e){var k=e.key;if(state==='title'&&(k===' '||k==='Enter')){newGame();return;}if(k==='p'||k==='P'){if(state==='play'){state='pause';__overlay('<div class=\"big\">⏸</div><h2>PAUSED</h2><p>Press P to resume</p>');}else if(state==='pause'){state='play';__hideOverlay();}return;}if(k==='m'||k==='M'){__muted=!__muted;return;}if(k==='r'||k==='R'){newGame();return;}if(state!=='play')return;if(k==='ArrowLeft'||k==='a'||k==='A'){if(!collides(cur,curRot,px-1,py))px--;}else if(k==='ArrowRight'||k==='d'||k==='D'){if(!collides(cur,curRot,px+1,py))px++;}else if(k==='ArrowDown'||k==='s'||k==='S'){step(true);}else if(k==='ArrowUp'||k==='w'||k==='W'||k==='x'||k==='X'){tryRotate(1);}else if(k==='z'||k==='Z'){tryRotate(-1);}else if(k===' '){e.preventDefault();hardDrop();}else if(k==='c'||k==='C'||k==='Shift'){doHold();}});",
      "var tx=0,ty=0,tt=0;",
      "cv.addEventListener('touchstart',function(e){if(e.touches.length>1){doHold();e.preventDefault();return;}tx=e.touches[0].clientX;ty=e.touches[0].clientY;tt=Date.now();},{passive:true});",
      "cv.addEventListener('touchend',function(e){if(state==='title'){newGame();return;}if(state!=='play')return;var dx=e.changedTouches[0].clientX-tx,dy=e.changedTouches[0].clientY-ty;if(Math.abs(dx)<18&&Math.abs(dy)<18){tryRotate(1);}else if(Math.abs(dy)>Math.abs(dx)){if(dy>36)hardDrop();else while(!collides(cur,curRot,px,py+1)){py++;}}else if(dx<-18){if(!collides(cur,curRot,px-1,py))px--;}else if(dx>18){if(!collides(cur,curRot,px+1,py))px++;}},{passive:true});",
      "reset();state='title';__overlay('<div class=\"big\">🧱</div><h2>FALLING BLOCKS</h2><p>'+(CONFIG.hold?'Hold (C) · ':'')+'Ghost '+(CONFIG.ghost?'on':'off')+' · Start level '+CONFIG.startLevel+'<br>Arrows move · Up/Z rotate · Space drop<br><br><button onclick=\"__start()\">▶ START</button></p>');__hud('SCORE 0','LINES 0 · LV '+CONFIG.startLevel+' · BEST '+high);requestAnimationFrame(loop);",
    ].join("\n");
  return gameShell({
    title: "Falling Blocks",
    tagline: "tetris-classic · generated fully offline",
    width: cols * cell + sideW + 16,
    height: rows * cell + 8,
    accent: o.accent ?? "#22d3ee",
    js,
    help: [
      "Arrows / WASD — move · Up/Z — rotate",
      "Space — hard drop · C / two-finger — hold",
      "P — pause · M — sound · R — restart",
    ],
    actionLabel: "⏭",
  });
}
