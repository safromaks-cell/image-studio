const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {config,resolve,gpuMemory}=require('./core.cjs');
const root=resolve('models/flux-uncensored');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const state={state:'waiting',phase:'Ожидание скачивания FLUX',started:new Date().toISOString()};
function save(){fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'preparation.json'),JSON.stringify(state,null,2));}
function read(name){try{return JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));}catch{return null;}}
async function convert(source,flag,target) {
  const file=path.join(root,target);
  if(fs.existsSync(file)) {const fd=fs.openSync(file,'r'),magic=Buffer.alloc(4);fs.readSync(fd,magic,0,4,0);fs.closeSync(fd);if(magic.toString()==='GGUF')return;throw Error('Invalid GGUF: '+file);}
  state.state='preparing';state.phase='Квантование '+target;save();
  const temporary=file+'.part';
  const log=fs.createWriteStream(resolve('logs/flux-convert-'+target+'.log'));
  const exe=fs.readFileSync(resolve('runtime/cli-path.txt'),'utf8').replace(/^\uFEFF/,'').trim();
  const child=spawn(exe,['-M','convert',flag,path.join(root,source),'--convert-name','--type','q4_K','-t','8','-o',temporary],{cwd:path.dirname(exe),windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  const code=await new Promise((r,j)=>{child.once('error',j);child.once('close',r);});log.end();
  if(code!==0)throw Error('Conversion failed: '+target+'; see logs/flux-convert-'+target+'.log');
  const fd=fs.openSync(temporary,'r'),magic=Buffer.alloc(4);fs.readSync(fd,magic,0,4,0);fs.closeSync(fd);
  if(magic.toString()!=='GGUF')throw Error('Conversion did not produce GGUF: '+target);
  fs.renameSync(temporary,file);
}
async function main() {
  save();
  for(;;) {
    const manifest=read('download.json');
    if(manifest?.state==='error')throw Error('Скачивание FLUX прервано. Повтори download-flux.cjs.');
    if(manifest?.state==='downloaded')break;
    await sleep(10000);
  }
  await convert('text_encoder_2/model.safetensors.index.json','--t5xxl','t5xxl-Q4_K.gguf');
  await convert('transformer/diffusion_pytorch_model.safetensors.index.json','--diffusion-model','flux-uncensored-Q4_K.gguf');
  fs.writeFileSync(path.join(root,'ready.json'),JSON.stringify({repo:'aschjj/FLUX-UNCENSORED-merged',revision:read('download.json').revision,quantization:'Q4_K',created:new Date().toISOString()},null,2));
  state.state='testing';state.phase='Ожидание свободного GPU для проверки FLUX';save();
  const currentPort=JSON.parse(fs.readFileSync(resolve('config.json'),'utf8')).port;
  const base='http://127.0.0.1:'+currentPort;
  for(;;) {
    const statuses=await Promise.all([8797,8799,currentPort].map(async p=>{try{return await (await fetch('http://127.0.0.1:'+p+'/api/status',{signal:AbortSignal.timeout(3000)})).json();}catch{return null;}}));
    if(statuses.at(-1) && statuses.every(s=>!s?.busy) && (await gpuMemory()).free>=6200)break;
    await sleep(10000);
  }
  state.phase='Проверка FLUX на GPU: 512×512, 28 шагов';save();
  const response=await fetch(base+'/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'image',imageModel:resolve('models/flux-uncensored/flux-uncensored-Q4_K.gguf'),prompt:'A red ceramic cup on a wooden table, soft morning light from a nearby window, product photography.',width:512,height:512,steps:28,cfg:1,guidance:3.5,seed:42})});
  const job=await response.json();if(!response.ok)throw Error(job.error);
  for(;;) {
    const result=await (await fetch(base+'/api/jobs/'+job.id)).json();
    if(result.status!=='running') {
      fs.writeFileSync(resolve('FLUX_TEST_RESULTS.json'),JSON.stringify(result,null,2));
      if(result.status!=='done')throw Error(result.error || 'FLUX GPU test failed');
      state.state='ready';state.phase='FLUX готова · проверка GPU пройдена';state.testId=job.id;state.seconds=result.seconds;save();console.log(state.phase);return;
    }
    await sleep(2000);
  }
}
main().catch(e=>{state.state='error';state.error=e.message;state.phase='Ошибка подготовки FLUX';save();console.error(e);process.exitCode=1;});
