// Three different hand-authored games: controlled regression/evaluation corpus,
// never live-model creativity evidence. Scenarios act through normal controls.
const scenario = (kind, name, steps, checks) => ({ kind, name, steps, checks });
const eq = (selector, value) => ({ selector, mode: "equals", value });
const common = (title, input, draw, plan) => `<!doctype html><html><head><title>${title}</title><style>
body{background:#111827;color:white;font:18px sans-serif}canvas{display:block;border:1px solid #aaa}span{padding:8px}</style></head><body>
<h1>${title}</h1><button id="start">Start</button><p>Arrows/WASD or A/B and Space. R restarts.</p>
<div>State <span id="state">title</span>Score <span id="score">0</span>Position <span id="position">0</span></div>
<canvas id="game" width="360" height="240" tabindex="0"></canvas>
<script id="arena-gameplay" type="application/json">${JSON.stringify({ version: 1, scenarios: plan })}</script>
<script>const canvas=document.getElementById('game'),ctx=canvas.getContext('2d');let state='title',score=0,x=0,y=0,bullet=-1,tick=0,mask=0;
function reset(){state='playing';score=0;x=0;y=0;bullet=-1;mask=0}
document.getElementById('start').onclick=reset;
function input(k){if(k==='r'){reset();return;}if(state!=='playing')return;${input}}
window.addEventListener('keydown',e=>{e.preventDefault();input(e.key)});
canvas.addEventListener('pointerdown',()=>input(' '));
function loop(){tick++;ctx.fillStyle='#111827';ctx.fillRect(0,0,360,240);ctx.fillStyle='#334155';ctx.fillRect(0,230,tick%360,5);${draw}
document.getElementById('state').textContent=state;document.getElementById('score').textContent=score;document.getElementById('position').textContent=x+','+y+','+mask;
requestAnimationFrame(loop)}requestAnimationFrame(loop);</script></body></html>`;
const resetCheck = [eq("#score", "0"), eq("#state", "playing")];
export const maze = common("Key maze with walls",
  `const nx=x+(k==='ArrowRight'?1:k==='ArrowLeft'?-1:0),ny=y+(k==='ArrowDown'?1:k==='ArrowUp'?-1:0);
if(nx>=0&&nx<=2&&ny>=0&&ny<=1&&!(nx===2&&ny===0)){x=nx;y=ny;}
if(y===1)score=1;if(x===2&&y===1)state='won';`,
  `ctx.fillStyle='#38bdf8';ctx.fillRect(20+x*70,30+y*70,25,25);ctx.fillStyle='#f97316';ctx.fillRect(160,30,40,40);ctx.fillStyle='#22c55e';ctx.fillRect(160,100,40,40);`,
  [scenario("controls", "Move through corridor", [{ press: "ArrowRight" }], [{ selector: "#position", mode: "change" }]),
   scenario("progress", "Collect lower-row key", [{ press: "ArrowDown" }], [{ selector: "#score", mode: "increase" }]),
   scenario("terminal", "Route around wall to exit", [{ press: "ArrowRight" }, { press: "ArrowDown" }, { press: "ArrowRight" }], [eq("#state", "won")]),
   scenario("restart", "Reset collected key", [{ press: "ArrowDown" }, { press: "r" }], resetCheck)]);
export const shooter = common("Aim and intercept",
  `if(k==='ArrowRight')x=1;if(k==='ArrowLeft')x=0;if(k===' ')bullet=180;`,
  `if(bullet>=0&&state==='playing'){bullet-=14;if(bullet<=40){if(x===1){score++;state='won';}bullet=-1;}}
ctx.fillStyle='#22c55e';ctx.fillRect(30+x*100,190,30,20);ctx.fillStyle='#f87171';ctx.fillRect(130,20,30,20);
ctx.fillStyle='white';if(bullet>=0)ctx.fillRect(42+x*100,bullet,5,12);`,
  [scenario("controls", "Aim right", [{ press: "ArrowRight" }], [{ selector: "#position", mode: "change" }]),
   scenario("progress", "Hit target with projectile", [{ press: "ArrowRight" }, { press: "Space" }, { waitMs: 250 }], [{ selector: "#score", mode: "increase" }]),
   scenario("terminal", "Intercept wins", [{ press: "ArrowRight" }, { press: "Space" }, { waitMs: 250 }], [eq("#state", "won")]),
   scenario("restart", "Reset destroyed target", [{ press: "ArrowRight" }, { press: "Space" }, { waitMs: 250 }, { press: "r" }], resetCheck)]);
export const puzzle = common("Two-switch logic puzzle",
  `if(k==='a')mask^=1;if(k==='b')mask^=2;score=(mask&1)+((mask>>1)&1);if(mask===3)state='won';`,
  `for(let i=0;i<2;i++){ctx.fillStyle=mask&(1<<i)?'#22c55e':'#f87171';ctx.fillRect(50+i*100,80,70,70);}`,
  [scenario("controls", "Toggle first switch", [{ press: "a" }], [{ selector: "#position", mode: "change" }]),
   scenario("progress", "Light a switch", [{ press: "a" }], [{ selector: "#score", mode: "increase" }]),
   scenario("terminal", "Solve switch combination", [{ press: "a" }, { press: "b" }], [eq("#state", "won")]),
   scenario("restart", "Clear solved board", [{ press: "a" }, { press: "b" }, { press: "r" }], resetCheck)]);
export const games = { maze, shooter, puzzle };
export const withoutContract = code => code.replace(/<script id="arena-gameplay" type="application\/json">[\s\S]*?<\/script>/, "");
export const brokenControls = code => code.replace("input(e.key)", "if(e.key==='r')input(e.key)");
export const brokenRestart = code => code.replace("if(k==='r'){reset();return;}", "if(k==='r'){return;}");
export const brokenTerminal = code => code.replaceAll("state='won'", "state='playing'");
