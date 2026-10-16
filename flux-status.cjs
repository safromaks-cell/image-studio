const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname,'models','flux-uncensored');
function read(name) {try {return JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));} catch {return null;}}
function downloaded(file,total) {
  if (!fs.existsSync(file)) return 0;
  if (!fs.existsSync(file+'.aria2')) return fs.statSync(file).size === total ? total : 0;
  try {
    const b = fs.readFileSync(file+'.aria2');
    if(b.readUInt16BE(0)!==1) return 0;
    const start=10+b.readUInt32BE(6),piece=b.readUInt32BE(start),size=Number(b.readBigUInt64BE(start+4)),length=b.readUInt32BE(start+20),offset=start+24;
    if(size!==total || !piece || offset+length>b.length) return 0;
    let bytes=0;for(let i=0;i<Math.ceil(total/piece);i++) if(b[offset+(i>>3)] & (128>>(i&7)))bytes+=Math.min(piece,total-i*piece);
    return bytes;
  } catch {return 0;}
}
function progress() {
  const manifest=read('download.json');if(!manifest)return null;
  const items=manifest.files.map(f=>({name:f.name,total:f.bytes,completed:downloaded(path.join(root,f.name),f.bytes)}));
  const total=items.reduce((n,f)=>n+f.total,0),completed=items.reduce((n,f)=>n+f.completed,0);
  const preparation=read('preparation.json');
  return {state:preparation?.state && preparation.state!=='waiting' ? preparation.state : manifest.state,total,completed,percent:Math.floor(completed/total*100),error:preparation?.error,phase:preparation?.state==='waiting' ? undefined : preparation?.phase,items};
}
module.exports={progress,downloaded};
