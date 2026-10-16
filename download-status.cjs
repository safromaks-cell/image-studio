const fs = require('node:fs');
const path = require('node:path');
const files = [
  ['models/qwen-image-2.1-UC-Q4_K_M.gguf',4604558112],
  ['models/Qwen3VL-8B-Instruct-Q4_K_M.gguf',5027784800],
  ['models/qwen_image_2.1_vae_bf16.safetensors',675509688],
  ['runtime/sd-master-3f8527a-bin-win-cuda12-x64.zip',337915440],
  ['runtime/cudart-sd-bin-win-cu12-x64.zip',563452046]
];
// aria2 v1 control format: network-endian lengths and an MSB-first piece bitmap.
// Count only complete pieces; active partial pieces are deliberately omitted.
function progress() {
  const items = files.map(([relative,total]) => {
    const file = path.join(__dirname,relative); let completed = 0;
    if (fs.existsSync(file)) completed = total;
    else try {
      const b = fs.readFileSync(file + '.part.aria2');
      if (b.readUInt16BE(0) !== 1) throw Error('Unsupported control version');
      const start = 10 + b.readUInt32BE(6);
      const piece = b.readUInt32BE(start);
      if (Number(b.readBigUInt64BE(start+4)) !== total) throw Error('Wrong control size');
      const length = b.readUInt32BE(start+20), offset = start+24;
      if (!piece || offset + length > b.length) throw Error('Incomplete bitmap');
      for (let i=0; i<Math.ceil(total/piece); i++) if (b[offset+(i>>3)] & (128>>(i&7))) completed += Math.min(piece,total-i*piece);
    } catch {}
    return {name:path.basename(relative),completed,total,percent:Math.floor(completed/total*100)};
  });
  const completed = items.reduce((s,i)=>s+i.completed,0), total = items.reduce((s,i)=>s+i.total,0);
  return {items,completed,total,percent:Math.floor(completed/total*100)};
}
module.exports = {progress};
