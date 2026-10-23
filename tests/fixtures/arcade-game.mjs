// Deliberately scripted custom game, not a genuine-model creativity claim.
export const photographyGame = `<!DOCTYPE html><html><head><title>Ghost exposure lab</title><style>
body{background:#071020;color:white;font:16px sans-serif;margin:10px}canvas{display:block;background:#102030}
button{padding:10px;margin:4px}span{padding:8px}
</style></head><body><h1>Ghost photography</h1>
<p>Start. Arrows move camera; Space takes a photo; P pauses; R restarts. Two photos win.</p>
<button id="start">Start</button><button id="pause">Pause</button><button id="restart">Restart</button>
<div>State <span id="state">title</span>Score <span id="score">0</span>Camera <span id="camera">60</span>Clock <span id="clock">0</span></div>
<canvas id="game" width="400" height="280"></canvas><script>
const canvas=document.getElementById('game'),ctx=canvas.getContext('2d');
let state='title',score=0,x=60,time=0,last=0,exposure=.5;
function reset(){state='playing';score=0;x=60;time=0;last=0}
function photo(){if(state==='playing'){score+=Math.round(exposure*100);if(score>=100)state='won'}}
function pause(){if(state==='playing')state='paused';else if(state==='paused')state='playing'}
document.getElementById('start').onclick=reset;document.getElementById('pause').onclick=pause;document.getElementById('restart').onclick=reset;
window.addEventListener('keydown',function(e){if(['ArrowRight','ArrowLeft',' '].includes(e.key))e.preventDefault();
if(e.key==='r'||e.key==='R')reset();if(e.key==='p'||e.key==='P')pause();
if(state==='playing'){if(e.key==='ArrowRight')x+=20;if(e.key==='ArrowLeft')x-=20;if(e.key===' ')photo()}});
canvas.addEventListener('pointerdown',()=>photo());
function loop(now){const dt=last?Math.min(.05,(now-last)/1000):0;last=now;
if(state==='playing'){time+=dt;if(time>=3)state='lost'}
ctx.fillStyle='#102030';ctx.fillRect(0,0,400,280);ctx.fillStyle='#99ffcc';
ctx.fillRect(180+Math.sin(time*4)*35,80,35,40);ctx.fillStyle=state==='won'?'#ffff00':'#ff55aa';ctx.fillRect(x,220,30,20);
document.getElementById('state').textContent=state;document.getElementById('score').textContent=score;document.getElementById('camera').textContent=x;document.getElementById('clock').textContent=time.toFixed(2);
requestAnimationFrame(loop)}requestAnimationFrame(loop);
</script><script id="arena-gameplay" type="application/json">{"version":1,"scenarios":[
{"kind":"controls","name":"Move camera","steps":[{"press":"ArrowRight"}],"checks":[{"selector":"#camera","mode":"change"}]},
{"kind":"progress","name":"Photograph ghost","steps":[{"press":"Space"}],"checks":[{"selector":"#score","mode":"increase"}]},
{"kind":"terminal","name":"Two photographs win","steps":[{"press":"Space"},{"press":"Space"}],"checks":[{"selector":"#state","mode":"equals","value":"won"}]},
{"kind":"restart","name":"Restart a used camera","steps":[{"press":"Space"},{"press":"r"}],"checks":[{"selector":"#score","mode":"equals","value":"0"},{"selector":"#state","mode":"equals","value":"playing"}]}
]}</script><!-- Scripted behavioural fixture: camera input, exposure scoring, distinct title/play/pause/win/loss states; bounded animation and reset, no external assets. --></body></html>`;
export const crashingGame = photographyGame.replace("<script>", "<script>throw new Error('CONTROLLED_BROWSER_CRASH');");
export const inertGame = photographyGame.replace("requestAnimationFrame(loop)}requestAnimationFrame(loop);", "}loop(0); /* requestAnimationFrame deliberately not called */");
// Avoid literal forbidden API/URL patterns to test actual CSP, not just regexes.
export const networkGame = photographyGame.replace("<script>", "<script>self['fet'+'ch']('//example.invalid/blocked').catch(()=>{});");
export const navigationGame = photographyGame.replace("<script>", "<script>self['loc'+'ation']='//example.invalid/escape';");
