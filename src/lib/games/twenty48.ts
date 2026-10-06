// Verified offline core: 2048 (merge-numbers puzzle).
// Complete playable single-file game, zero network. Grid size is a parameter:
// 3x3 (brutal), 4x4 (classic), 5x5 (roomy).

import { gameShell, SFX_JS } from "./shell";

export interface Twenty48Opts {
  size?: number; // 3–6
  target?: number; // win tile (512 | 1024 | 2048 | 4096)
  accent?: string;
}

export function build2048(o: Twenty48Opts = {}): string {
  const size = Math.min(6, Math.max(3, o.size ?? 4));
  const target = [512, 1024, 2048, 4096].includes(o.target ?? 2048) ? o.target ?? 2048 : 2048;
  const cell = 84;
  const gap = 10;
  const boardPx = size * cell + (size + 1) * gap;
  const js =
    SFX_JS +
    "\n" +
    "var CONFIG={size:" + size + ",target:" + target + "};\n" +
    [
      "var cv=document.getElementById('game'),ctx=cv.getContext('2d'),N=CONFIG.size,T=" + cell + ",G=" + gap + ";",
      "var grid,score,high=__store.get('af_2048_high',0),state='title',won=false;",
      "var TILE={2:'#3c4a6b',4:'#4d5f8a',8:'#5b7bd5',16:'#4299e1',32:'#38bdf8',64:'#22d3ee',128:'#4ade80',256:'#a3e635',512:'#facc15',1024:'#fb923c',2048:'#f97316',4096:'#ef4444'};",
      "function reset(){grid=[];for(var y=0;y<N;y++)grid.push(new Array(N).fill(0));score=0;won=false;addTile();addTile();}",
      "function addTile(){var empty=[];for(var y=0;y<N;y++)for(var x=0;x<N;x++){if(!grid[y][x])empty.push([x,y]);}if(!empty.length)return;var s=empty[Math.floor(Math.random()*empty.length)];grid[s[1]][s[0]]=Math.random()<0.9?2:4;}",
      "function slide(row){var v=row.filter(function(n){return n;},row),out=[],i=0;while(i<v.length){if(v[i]===v[i+1]){out.push(v[i]*2);score+=v[i]*2;if(v[i]*2===CONFIG.target)won=true;i+=2;}else{out.push(v[i]);i++;}}while(out.length<N)out.push(0);return out;}",
      "function rotateGrid(g,t){for(var r=0;r<t;r++){var n=[];for(var y=0;y<N;y++)n.push(g[y].slice());g=[];for(var y2=0;y2<N;y2++){g.push([]);for(var x=0;x<N;x++)g[y2].push(n[N-1-x][y2]);}}return g;}",
      "function move(dir){if(state!=='play')return;var g=[],y;for(y=0;y<N;y++)g.push(grid[y].slice());var t={left:0,up:1,right:2,down:3}[dir];g=rotateGrid(g,t);var moved=false;for(y=0;y<N;y++){var s=slide(g[y]);if(s.join()!==g[y].join())moved=true;g[y]=s;}t=(4-t)%4;g=rotateGrid(g,t);if(!moved)return;grid=g;addTile();__sfx(340+Math.min(600,score),0.05,'triangle',0.03);if(score>high){high=score;__store.set('af_2048_high',high);}",
      "if(won){state='won';__overlay('<div class=\"big\">🏆</div><h2>'+CONFIG.target+' REACHED!</h2><p>Score '+score+' · Best '+high+'</p><p><button onclick=\"__keep()\">KEEP GOING</button> <button onclick=\"__start()\">NEW GAME</button></p>');return;}",
      "var dead=true;for(y=0;y<N&&dead;y++)for(var x=0;x<N;x++){if(!grid[y][x]||(x<N-1&&grid[y][x]===grid[y][x+1])||(y<N-1&&grid[y][x]===grid[y+1][x])){dead=false;break;}}",
      "if(dead){state='over';__sfx(200,0.4,'sawtooth',0.06,60);__overlay('<div class=\"big\">🔢</div><h2>NO MOVES LEFT</h2><p>Score '+score+' · Best '+high+'<br><br>Press R or tap Restart</p>');}}",
      "function draw(){ctx.fillStyle='#05070f';ctx.fillRect(0,0,cv.width,cv.height);ctx.fillStyle='#111a2e';ctx.beginPath();ctx.roundRect(0,0," + boardPx + "," + boardPx + ",12);ctx.fill();",
      "for(var y=0;y<N;y++)for(var x=0;x<N;x++){var v=grid[y][x],px=G+x*(T+G),py=G+y*(T+G);ctx.fillStyle=v?TILE[v]||'#ef4444':'#18213a';ctx.beginPath();ctx.roundRect(px,py,T,T,8);ctx.fill();if(v){ctx.fillStyle=v<=4?'#cdd7ee':'#0b1020';ctx.font='bold '+(v<1024?30:v<8192?26:22)+'px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(v,px+T/2,py+T/2+2);}}",
      "__hud('SCORE '+score,'TARGET '+CONFIG.target+' · BEST '+high);}",
      "var last=0;function loop(ts){requestAnimationFrame(loop);last=ts;draw();}",
      "window.__start=function(){reset();state='play';__hideOverlay();};",
      "window.__keep=function(){won=false;state='play';__hideOverlay();};",
      "window.addEventListener('keydown',function(e){var k=e.key,m={ArrowLeft:'left',a:'left',A:'left',ArrowRight:'right',d:'right',D:'right',ArrowUp:'up',w:'up',W:'up',ArrowDown:'down',s:'down',S:'down'};if(state==='title'&&(k===' '||k==='Enter')){window.__start();return;}if(k==='r'||k==='R'){window.__start();return;}if(k==='m'||k==='M'){__muted=!__muted;return;}if(m[k]){e.preventDefault();move(m[k]);}});",
      "var tx=0,ty=0;",
      "cv.addEventListener('touchstart',function(e){tx=e.touches[0].clientX;ty=e.touches[0].clientY;},{passive:true});",
      "cv.addEventListener('touchend',function(e){if(state==='title'){window.__start();return;}var dx=e.changedTouches[0].clientX-tx,dy=e.changedTouches[0].clientY-ty;if(Math.abs(dx)<18&&Math.abs(dy)<18)return;move(Math.abs(dx)>Math.abs(dy)?(dx>0?'right':'left'):(dy>0?'down':'up'));},{passive:true});",
      "reset();state='title';__overlay('<div class=\"big\">🔢</div><h2>MERGE TO '+CONFIG.target+'</h2><p>'+N+'×'+N+' grid · swipe or arrows<br><br><button onclick=\"__start()\">▶ START</button></p>');__hud('SCORE 0','TARGET '+CONFIG.target+' · BEST '+high);requestAnimationFrame(loop);",
    ].join("\n");
  return gameShell({
    title: "Merge Numbers",
    tagline: "2048-classic · generated fully offline",
    width: boardPx + 8,
    height: boardPx + 8,
    accent: o.accent ?? "#f97316",
    js,
    help: ["Arrows / WASD / swipe — slide", "Same tiles merge · reach " + target, "R — restart · M — sound"],
    actionLabel: "↻",
  });
}
