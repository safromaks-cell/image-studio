const fs = require('node:fs');
const path = require('node:path');

function galleryPage(directory, offset = 0, limit = 24) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('Некорректная страница галереи.');
  const files = fs.readdirSync(directory).filter(name => /^[a-f0-9-]+\.json$/.test(name)).map(name => ({name, time:fs.statSync(path.join(directory,name)).mtimeMs})).sort((a,b) => b.time - a.time || b.name.localeCompare(a.name));
  const items = [];
  let cursor = offset;
  while (cursor < files.length && items.length < limit) {
    const file = files[cursor++];
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(directory,file.name),'utf8'));
      if (entry.url && entry.created) items.push(entry);
    } catch { /* An interrupted metadata write must not break the gallery. */ }
  }
  return {items, total:files.length, nextOffset:cursor < files.length ? cursor : null};
}
module.exports = {galleryPage};
