const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {config, options, generationSettings, promptSettings,promptMessages,imageArgs, discoverModels, discoverPromptModels, discoverImageModels, validateModels, pipeline} = require('./core.cjs');
test('batch settings reject invalid counts and infinite rewriting', () => {
  for (const count of [0,-1,1.5,'3',Infinity,Number.MAX_SAFE_INTEGER+1]) assert.throws(() => generationSettings({mode:'image',count}));
  assert.throws(() => generationSettings({mode:'image',infinite:'true'}));
  assert.throws(() => generationSettings({mode:'auto',infinite:true}));
  assert.deepEqual(generationSettings({mode:'image',count:12}),{count:12,infinite:false});
});
test('batch creates exact count sequentially, rewrites once, and varies seeds without mutating input', async () => {
  let rewrites=0, running=false;
  const images=[], saved=[];
  const input={mode:'auto',prompt:'a tree',count:3,seed:2147483646};
  const runtime={async rewrite(){rewrites++;return 'A tree';},async image(settings,signal,update,id){assert.equal(running,false);running=true;await new Promise(r=>setTimeout(r,1));images.push({settings,id});running=false;return id+'.png';}};
  await pipeline(input,runtime,new AbortController().signal,()=>{},'batch',async(result,n,id)=>saved.push({result,n,id}));
  assert.equal(rewrites,1);assert.equal(images.length,3);assert.equal(saved.length,3);
  assert.deepEqual(images.map(i=>i.settings.seed),[2147483646,0,1]);
  assert.deepEqual(images.map(i=>i.id),['batch-1','batch-2','batch-3']);
  assert(images.every(i=>i.settings.prompt==='A tree'));assert.equal(input.prompt,'a tree');assert.equal(input.seed,2147483646);
});
test('infinite loop uses only original prompt, preserves completed results, and stops on cancellation', async () => {
  const controller=new AbortController(), images=[], saved=[];
  const runtime={async rewrite(){assert.fail('Direct infinite mode must not rewrite');},async image(settings,signal,update,id){images.push({settings,id});return id+'.png';}};
  await assert.rejects(pipeline({mode:'image',prompt:'a tree',infinite:true,seed:10},runtime,controller.signal,()=>{},'loop',async(result,n)=>{saved.push(result);if(n===4)controller.abort();}));
  assert.equal(images.length,4);assert.equal(saved.length,4);
  assert.deepEqual(images.map(i=>i.settings.seed),[10,11,12,13]);
  assert(images.every(i=>i.settings.prompt==='a tree'));
});
test('random ideas derive each prompt from the original request, unload between stages, and save individual prompts', async () => {
  const input={mode:'random',prompt:'forest landscapes, watercolor only',count:3,promptSettings:{seed:42,temperature:0.2}};
  const order=[], requests=[], saved=[], seeds=[];
  const runtime={async rewrite(prompt,model,signal,update,id,preferences){requests.push(prompt);seeds.push(preferences.seed);assert.equal(preferences.examples,false);assert(preferences.temperature>=0.9);assert.match(preferences.systemPrompt,/based ONLY on the user request/);order.push('rewrite');return 'Watercolor forest '+requests.length;},async image(settings){order.push('image');assert.equal(settings.prompt,'Watercolor forest '+requests.length);return 'new.png';}};
  await pipeline(input,runtime,new AbortController().signal,()=>{},'random',async r=>saved.push(r));
  assert.deepEqual(order,['rewrite','image','rewrite','image','rewrite','image']);
  assert.deepEqual(requests,[input.prompt,input.prompt,input.prompt]);assert.equal(new Set(seeds).size,3);
  assert.deepEqual(saved.map(r=>r.prompt),['Watercolor forest 1','Watercolor forest 2','Watercolor forest 3']);
  assert(saved.every(r=>r.sourcePrompt===input.prompt && r.mode==='random'));
});
test('random infinite generation stops between rewriting and image creation', async () => {
  const controller=new AbortController();let images=0,rewrites=0;
  const runtime={async rewrite(){if(++rewrites===3)controller.abort();return 'A forest';},async image(){images++;return 'new.png';}};
  await assert.rejects(pipeline({mode:'random',prompt:'forest',infinite:true},runtime,controller.signal,()=>{},'random-loop'));
  assert.equal(rewrites,3);assert.equal(images,2);
});
test('graceful stop saves the current image and never launches the next one', async () => {
  let images=0, saved=0, finish=false;
  const runtime={async image(){images++;finish=true;return 'finished.png';}};
  const result=await pipeline({mode:'image',prompt:'test tree',infinite:true},runtime,new AbortController().signal,()=>{},'finish',async()=>{saved++;},()=>finish);
  assert.equal(images,1);assert.equal(saved,1);assert.equal(result.file,'finished.png');
});
test('dimensions and settings reject invalid requests before launching GPU', () => {
  for (const input of [{prompt:''},{prompt:'cat',width:513},{prompt:'cat',steps:0},{prompt:'cat',seed:1.5},{prompt:'cat',cfg:Infinity}]) assert.throws(() => options(input));
});
test('100 and 1000 steps are accepted; fractions and values above the limit are rejected',()=>{
  assert.equal(options({prompt:'cat',steps:100}).steps,100);
  assert.equal(options({prompt:'cat',steps:1000}).steps,1000);
  assert.throws(()=>options({prompt:'cat',steps:1001}));
  assert.throws(()=>options({prompt:'cat',steps:100.5}));
});
test('custom prompt instructions control messages; invalid sampling and context are rejected',()=>{
  const preferences=promptSettings({systemPrompt:'Write a short Russian description.',examples:false,temperature:0.2,context:4096,maxTokens:512,seed:42});
  const messages=promptMessages('Красная чашка',preferences);
  assert.deepEqual(messages,[{role:'system',content:'Write a short Russian description.'},{role:'user',content:'Красная чашка'}]);
  for(const bad of [{temperature:3},{topP:0},{topK:1.5},{context:1025},{context:1024,maxTokens:1024},{systemPrompt:''},{examples:'false'},{seed:0.5}])assert.throws(()=>promptSettings(bad));
});
test('FLUX has its own encoders and guidance, never inherits Qwen components',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-flux-'));
  const previous=config.imageProfiles;
  try {
    const profile={family:'FLUX.1-dev',name:'test flux',path:path.join(root,'flux.gguf'),clipL:path.join(root,'clip.safetensors'),t5:path.join(root,'t5.gguf'),vae:path.join(root,'ae.safetensors'),readyFile:path.join(root,'ready.json')};
    config.imageProfiles=[profile];
    for(const key of ['path','clipL','t5','vae'])fs.writeFileSync(profile[key],'fixture');
    assert.equal(discoverImageModels().find(m=>m.path===profile.path).available,false);
    fs.writeFileSync(profile.readyFile,'{}');
    const args=imageArgs({prompt:'cat',imageModel:profile.path,cfg:9,guidance:4},'cat.png');
    assert.equal(args[args.indexOf('--cfg-scale')+1],'1');assert.equal(args[args.indexOf('--guidance')+1],'4');
    assert(args.includes('--clip_l')&&args.includes('--t5xxl'));
    assert(!args.includes('--llm')&&!args.includes('--model-args')&&!args.includes('--clip-on-cpu')&&!args.includes('-n'));
    assert.equal(args[args.indexOf('--backend')+1],'cuda0');
  } finally {config.imageProfiles=previous;fs.rmSync(root,{recursive:true,force:true});}
});
test('GPU backend is explicit; prompt is one argument, never a shell command', () => {
  const prompt = 'cat; $(whoami) "quoted text"'; const args = imageArgs({prompt},'image.png');
  assert.equal(args[args.indexOf('--backend')+1],'cuda0');
  assert.equal(args[args.indexOf('-p')+1],prompt);
  assert(!args.includes('--clip-on-cpu')); assert(!args.includes('--vae-on-cpu'));
});
test('local model list includes requested 8B and excludes models over 13B', () => {
  const models = discoverModels(); assert(models.some(m => m.name.includes('Llama-3.1-8B-Lexi')));
  assert(!models.some(m => /(?:20|26|27|35)B/i.test(m.name)));
  assert(models.some(m => m.name.includes('Cyber-Exploit-Agent')));
});
test('download inventory excludes incomplete files and encoders, and explains large prompt models', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'studio-models-'));
  try {
    for (const name of ['Plain-9B-Q4.gguf','Large-27B-Q4.gguf','mmproj-9B.gguf','Qwen3VL-8B-Instruct.gguf','pending-8B.gguf','empty-8B.gguf','qwen-image-2.1-second.gguf']) fs.writeFileSync(path.join(root,name),name.startsWith('empty') ? '' : 'fixture');
    fs.writeFileSync(path.join(root,'pending-8B.gguf.aria2'),'partial');
    const prompts = discoverPromptModels([root]);
    assert.deepEqual(prompts.map(m => m.name),['Large-27B-Q4.gguf','Plain-9B-Q4.gguf']);
    assert.equal(prompts[0].available,false); assert.match(prompts[0].reason,/13B/);
    assert.equal(prompts[1].available,true);
    const images = discoverImageModels([root]);
    assert(images.some(m => m.name === 'qwen-image-2.1-second.gguf'));
    assert(!images.some(m => /Plain|Qwen3VL|pending/.test(m.name)));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('selected checkpoint reaches CLI and metadata; invalid selections fail before rewriting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'studio-selection-'));
  const previous = config.imageModelRoots;
  const selected = path.join(root,'qwen-image-2.1-custom.gguf');
  try {
    fs.writeFileSync(selected,'fixture'); config.imageModelRoots = [root];
    const args = imageArgs({prompt:'cat',imageModel:selected},'cat.png');
    assert.equal(args[args.indexOf('--diffusion-model')+1],selected);
    let rewrites = 0;
    const promptModel = discoverModels().find(m => m.path !== config.promptModel).path;
    const runtime = {async rewrite(prompt,model){rewrites++; assert.equal(model,promptModel); return 'A cat';},async image(input){assert.equal(input.imageModel,selected); return 'cat.png';}};
    const result = await pipeline({mode:'auto',prompt:'cat',promptModel,imageModel:selected},runtime,new AbortController().signal,()=>{},'selection');
    assert.equal(result.settings.imageModel,selected); assert.equal(result.promptModel,promptModel);
    await assert.rejects(pipeline({mode:'auto',prompt:'cat',imageModel:path.join(root,'absent.gguf')},runtime,new AbortController().signal,()=>{},'invalid'),/из списка/);
    assert.equal(rewrites,1);
    assert.throws(() => validateModels({mode:'prompt',promptModel:selected}),/из списка/);
    assert.throws(() => validateModels({mode:'prompt',promptModel:discoverPromptModels().find(m => !m.available).path}),/13B/);
  } finally {if (previous === undefined) delete config.imageModelRoots; else config.imageModelRoots = previous; fs.rmSync(root,{recursive:true,force:true});}
});
test('automatic pipeline waits for prompt model unloading before image stage', async () => {
  let loaded = false; const order = [];
  const runtime = {async rewrite(){loaded=true; order.push('load-llama'); await new Promise(r => setTimeout(r,5)); loaded=false; order.push('unload-llama'); return 'A red robot';}, async image(input){assert(!loaded); assert.equal(input.prompt,'A red robot'); order.push('image'); return 'test.png';}};
  const result = await pipeline({mode:'auto',prompt:'робот'},runtime,new AbortController().signal,()=>{},'id');
  assert.deepEqual(order,['load-llama','unload-llama','image']); assert.equal(result.prompt,'A red robot');
});
test('cancellation between stages never starts the image model', async () => {
  const controller = new AbortController(); let started = false;
  const runtime = {async rewrite(){controller.abort(); return 'cat';}, async image(){started=true;}};
  await assert.rejects(pipeline({mode:'auto',prompt:'cat'},runtime,controller.signal,()=>{},'id')); assert(!started);
});
test('prompt-only and direct-image modes skip unnecessary model loading', async () => {
  let rewrites = 0, images = 0; const runtime = {async rewrite(){rewrites++;return 'cat';},async image(){images++;return 'cat.png';}};
  const signal = new AbortController().signal;
  await pipeline({mode:'prompt',prompt:'cat'},runtime,signal,()=>{},'id'); assert.equal(images,0);
  await pipeline({mode:'image',prompt:'cat'},runtime,signal,()=>{},'id'); assert.equal(rewrites,1); assert.equal(images,1);
});
