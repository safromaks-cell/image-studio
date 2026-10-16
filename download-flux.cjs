// Downloads the exact referenced snapshot; aria2 resumes interrupted transfers.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const repo = 'aschjj/FLUX-UNCENSORED-merged';
const revision = '526da5e40b775db572090d769710e267b1d9634c';
const root = path.join(__dirname,'models','flux-uncensored');
async function main() {
  fs.mkdirSync(root,{recursive:true});
  const response = await fetch(`https://huggingface.co/api/models/${repo}/revision/${revision}?blobs=true`);
  if(!response.ok) throw Error('Hugging Face metadata: '+response.status);
  const metadata = await response.json();
  const files = metadata.siblings.filter(f => /^(transformer|text_encoder|text_encoder_2|vae)\//.test(f.rfilename) && /\.(safetensors|json)$/.test(f.rfilename));
  const manifest = {repo,revision,state:'downloading',started:new Date().toISOString(),files:files.map(f=>({name:f.rfilename,bytes:f.size,sha256:f.lfs?.sha256}))};
  fs.writeFileSync(path.join(root,'download.json'),JSON.stringify(manifest,null,2));
  const lines = [];
  for(const file of manifest.files) {
    const target = path.join(root,file.name); fs.mkdirSync(path.dirname(target),{recursive:true});
    lines.push(`https://huggingface.co/${repo}/resolve/${revision}/${file.name}\n  dir=${path.dirname(target)}\n  out=${path.basename(target)}${file.sha256 ? '\n  checksum=sha-256='+file.sha256 : ''}`);
  }
  const input = path.join(root,'aria2-input.txt'); fs.writeFileSync(input,lines.join('\n')+'\n');
  const aria = path.join(__dirname,'runtime','aria2-1.37.0-win-64bit-build1','aria2c.exe');
  const child = spawn(aria,['--input-file='+input,'--continue=true','--max-concurrent-downloads=3','--max-connection-per-server=8','--split=8','--min-split-size=16M','--file-allocation=none','--summary-interval=30','--console-log-level=warn','--download-result=full','--auto-file-renaming=false','--allow-overwrite=true','--max-tries=12','--retry-wait=5','--check-integrity=true'],{windowsHide:true,stdio:'inherit'});
  const code = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  manifest.state = code===0 ? 'downloaded' : 'error'; manifest.finished=new Date().toISOString();manifest.exitCode=code;
  fs.writeFileSync(path.join(root,'download.json'),JSON.stringify(manifest,null,2));
  if(code!==0) throw Error('aria2 download failed: '+code);
  console.log('FLUX snapshot downloaded and checksums verified.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
