const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {galleryPage} = require('./studio-utils.cjs');
test('gallery is paginated newest first and survives incomplete metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'studio-gallery-test-'));
  try {
    for(let i=1;i<=5;i++){
      const file=path.join(root,`${i}.json`);
      fs.writeFileSync(file,i===4 ? '{broken' : JSON.stringify({url:`/outputs/${i}.png`,created:'2026-01-01'}));
      fs.utimesSync(file,100+i,100+i);
    }
    fs.writeFileSync(path.join(root,'not-metadata.json'),'{}');
    const first=galleryPage(root,0,2);
    assert.deepEqual(first.items.map(e=>e.url),['/outputs/5.png','/outputs/3.png']);
    assert.equal(first.total,5);assert.equal(first.nextOffset,3);
    const second=galleryPage(root,first.nextOffset,2);
    assert.deepEqual(second.items.map(e=>e.url),['/outputs/2.png','/outputs/1.png']);assert.equal(second.nextOffset,null);
    assert.throws(()=>galleryPage(root,-1));assert.throws(()=>galleryPage(root,0,101));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
