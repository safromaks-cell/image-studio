const fs = require('node:fs');
const assert = require('node:assert/strict');
const {config,resolve} = require('./core.cjs');
const base = `http://127.0.0.1:${config.port}`;
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function main() {
  const input = {mode:'auto',model:config.promptModel,prompt:'Комикс с вымышленным взрослым капитаном пиратов в кожаном пальто, реплика в облачке "DAMN IT", штормовое море, драматичный свет',width:512,height:512,steps:20,seed:2026};
  assert.match(config.promptModel,/Gemma-4-E4B-Abliterated-Uncensored/);
  assert.match(config.imageModel,/-UC-/);
  let job;
  while (!job) {
    const r = await fetch(base+'/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    if(r.status===409) {await sleep(250);continue;}
    const data = await r.json(); if(!r.ok) throw Error(data.error); job = data;
  }
  console.log('Test job:',job.id);
  let phase;
  for (;;) {
    const r = await fetch(base+'/api/jobs/'+job.id); const state = await r.json();
    if(state.phase!==phase) {console.log(state.phase);phase=state.phase;}
    if(state.status==='running') {await sleep(500);continue;}
    const report = {model:config.promptModel,imageModel:config.imageModel,job:state,passed:state.status==='done'};
    fs.writeFileSync(resolve('ABLITERATED_TEST_RESULTS.json'),JSON.stringify(report,null,2));
    assert.equal(state.status,'done',state.error);
    assert.match(state.result.prompt,/DAMN IT/);
    const log = fs.readFileSync(resolve(`logs/${job.id}-llama.log`),'utf8');
    const layers = [...log.matchAll(/offloaded\s+(\d+)\/(\d+)\s+layers to GPU/g)].at(-1);
    assert(layers && layers[1]===layers[2]);
    report.gpuLayers = Number(layers[1]); report.passed=true;
    fs.writeFileSync(resolve('ABLITERATED_TEST_RESULTS.json'),JSON.stringify(report,null,2));
    console.log('PASS: abliterated default, full GPU offload, quoted text, sequential image generation');
    break;
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
