// Real GPU tests. Start Studio first, then run: node verify.cjs
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {resolve, gpuMemory, config} = require('./core.cjs');
const BASE = 'http://127.0.0.1:' + config.port;
const report = {started: new Date().toISOString(), tests: []};
const sleep = ms => new Promise(r => setTimeout(r, ms));
function save() {fs.writeFileSync(resolve('TEST_RESULTS.json'), JSON.stringify(report,null,2));}
async function request(route, data) {
  let r;
  for (let retry=0; retry<10; retry++) {
    try {r = await fetch(BASE + route, data ? {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)} : undefined); break;}
    catch(e) {if(data || retry===9) throw e; await sleep(1000);}
  }
  const body = await r.json(); if (!r.ok) throw Error(body.error); return body;
}
async function task(input) {
  const job = await request('/api/jobs',input); let last;
  for (;;) {
    const state = await request('/api/jobs/'+job.id);
    if (state.phase !== last) {console.log(state.phase); last = state.phase;}
    if (state.status !== 'running') {
      if (state.status !== 'done') throw Error(state.error);
      return state;
    }
    await sleep(1000);
  }
}
async function check(name, fn) {
  const before = Date.now();
  try {const details = await fn(); report.tests.push({name, passed:true, seconds:(Date.now()-before)/1000, details}); console.log('PASS:',name);}
  catch(e) {report.tests.push({name,passed:false,error:e.message}); console.error('FAIL:',name,e.message); throw e;}
  finally {save();}
}
async function main() {
  const waiting = await request('/api/status');
  if (waiting.busy) {console.log('Waiting for current user job'); while((await request('/api/status')).busy) await sleep(1000);}
  for (const [name, prompt, expected] of [
    ['English prompt from a Russian idea','Маленький робот-садовник в оранжерее, утренний солнечный свет, фотореализм',/robot|gardener/i],
    ['Quoted lettering and watercolor style preservation','Уютная кофейня вечером с вывеской "LUNA", акварельная иллюстрация',/(?=.*LUNA)(?=.*watercolou?r)/i],
    ['Product photo prompt','Фото красной керамической чашки на деревянном столе, мягкий свет из окна',/cup|mug/i]
  ]) {
    await check(name, async () => {
      const state = await task({mode:'prompt',prompt});
      assert.match(state.result.prompt,expected);
      assert(!/[а-яё]/i.test(state.result.prompt), 'Expected English prompt');
      const log = fs.readFileSync(resolve(`logs/${state.id}-llama.log`),'utf8');
      const layers = [...log.matchAll(/offloaded\s+(\d+)\/(\d+)\s+layers to GPU/g)].at(-1);
      assert(layers && layers[1] === layers[2], 'All prompt model layers must be on GPU');
      const after = await gpuMemory(); assert(after.free >= 6200,'Model must release GPU after prompt');
      return {id:state.id,prompt:state.result.prompt,seconds:state.seconds,freeVRAM:after.free};
    });
  }
  console.log('Waiting for verified image model files and runtime');
  while (!(await request('/api/status')).installed) await sleep(10000);
  for (const [name, input] of [
    ['Image smoke test 256x256', {mode:'image',prompt:'A red ceramic cup on a wooden table, soft morning light, product photo',width:256,height:256,steps:4,seed:42}],
    ['Image quality test 512x512', {mode:'image',prompt:'A cozy cafe at dusk, warm window light, a clear sign reading "LUNA", watercolor illustration',width:512,height:512,steps:20,seed:123}],
    ['Sequential Llama to Qwen workflow', {mode:'auto',prompt:'Маленький робот-садовник в оранжерее, утренний солнечный свет, фотореализм',width:512,height:512,steps:20,seed:456}]
  ]) {
    await check(name, async () => {
      const state = await task(input);
      const png = fs.readFileSync(state.result.file);
      assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
      assert.equal(png.readUInt32BE(16), input.width); assert.equal(png.readUInt32BE(20), input.height);
      const log = fs.readFileSync(resolve(`logs/${state.id}-image.log`),'utf8');
      assert.match(log,/CUDA|cuda/);
      const after = await gpuMemory(); assert(after.free >= 6200,'Qwen must release GPU after generation');
      return {id:state.id,file:state.result.file,prompt:state.result.prompt,seconds:state.seconds,bytes:png.length,freeVRAM:after.free};
    });
  }
  report.finished = new Date().toISOString(); save(); console.log('All real tests passed. See TEST_RESULTS.json');
}
main().catch(e => {report.error=e.message; save(); process.exitCode=1;});
