const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {randomUUID} = require('node:crypto');
const {galleryPage} = require('./studio-utils.cjs');
const {config, resolve, defaultPromptSettings,discoverModels, discoverPromptModels, discoverImageModels, validateModels, generationSettings, gpuMemory, makeRuntime, pipeline} = require('./core.cjs');
for (const dir of ['outputs','logs','data']) fs.mkdirSync(resolve(dir), {recursive: true});
const runtime = makeRuntime();
const jobs = new Map();
let current = null;
function json(res, code, data) {res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(data));}
async function body(req) {let text = ''; for await (const c of req) {text += c; if (Buffer.byteLength(text) > 65536) throw Error('Слишком большой запрос.');} return JSON.parse(text || '{}');}
async function runJob(job, input) {
  const began = Date.now();
  try {
    const result = await pipeline(input, runtime, job.controller.signal, phase => {job.phase = phase;}, job.id, async (result, completed, imageId) => {
      const entry = {...result, url: `/outputs/${path.basename(result.file)}`, created:new Date().toISOString(), seconds:(Date.now() - began) / 1000};
      fs.writeFileSync(resolve(`outputs/${imageId}.json`), JSON.stringify(entry, null, 2));
      job.result = entry;
      job.completed = completed;
      job.completedSeconds = entry.seconds;
    }, () => job.stopAfterCurrent);
    Object.assign(job, {status: 'done', phase: job.stopAfterCurrent ? 'Остановлено после текущего изображения' : 'Готово', result: job.result || result, seconds: (Date.now() - began) / 1000});
  } catch (e) {job.status = job.controller.signal.aborted ? 'cancelled' : 'error'; job.phase = job.status === 'cancelled' ? 'Остановлено' : 'Ошибка'; job.error = e.message;}
  finally {current = null; fs.writeFileSync(resolve(`data/${job.id}.json`), JSON.stringify(publicJob(job), null, 2));}
}
function publicJob(job) {const {controller, ...rest} = job; return {...rest, elapsedSeconds:job.seconds ?? (Date.now() - Date.parse(job.created)) / 1000};}
const server = http.createServer(async (req, res) => {
  const addresses = Object.values(os.networkInterfaces()).flat().filter(n => n.family === 'IPv4' && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address)).map(n => n.address);
  const hosts = ['127.0.0.1','localhost',...addresses].map(host => `${host}:${config.port}`);
  if (!hosts.includes(req.headers.host)) return json(res, 403, {error: 'Доступ по адресу компьютера в локальной сети'});
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, {error: 'Недопустимый origin'});
  const url = new URL(req.url, `http://127.0.0.1:${config.port}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, {generationSeries:true, randomIdeas:true, gracefulStop:true, gpu: await gpuMemory().catch(e => ({error:e.message})), busy: current, models: discoverModels(), promptModels: discoverPromptModels(), imageModels: discoverImageModels(), defaultModel: config.promptModel, defaultImageModel: resolve(config.imageModel), defaultPromptSettings,downloads: require('./download-status.cjs').progress(), flux: require('./flux-status.cjs').progress(), networkUrls: addresses.map(a => `http://${a}:${config.port}`), installed: fs.existsSync(resolve('runtime/cli-path.txt')) && discoverImageModels().some(m => m.available)});
    if (req.method === 'GET' && url.pathname === '/api/gallery') {
      if (url.searchParams.get('paged') === '1') return json(res,200,galleryPage(resolve('outputs'),Number(url.searchParams.get('offset') || 0),Number(url.searchParams.get('limit') || 24)));
      const gallery = fs.readdirSync(resolve('outputs')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(resolve('outputs/' + f), 'utf8'))).sort((a,b) => b.created.localeCompare(a.created));
      return json(res, 200, gallery);
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      if (current) return json(res, 409, {error: 'Дождись завершения текущей задачи или останови её.'});
      const input = await body(req);
      if (current) return json(res, 409, {error: 'Дождись завершения текущей задачи или останови её.'});
      if (!['image','prompt','auto','random'].includes(input.mode)) return json(res, 400, {error: 'Неизвестный режим.'});
      require('./core.cjs').options(input);
      const generation = generationSettings(input);
      validateModels(input);
      const job = {id: randomUUID(), mode:input.mode, status: 'running', phase: 'Подготовка', completed:0, count:generation.count, infinite:generation.infinite, stopAfterCurrent:false, created: new Date().toISOString(), controller: new AbortController()};
      current = job.id; jobs.set(job.id, job); if (jobs.size > 100) jobs.delete(jobs.keys().next().value);
      json(res, 202, publicJob(job)); void runJob(job, input); return;
    }
    const match = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)(\/(?:cancel|finish))?$/);
    if (match) {
      const saved = resolve(`data/${match[1]}.json`);
      const job = jobs.get(match[1]) || (fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved,'utf8')) : null); if (!job) return json(res, 404, {error: 'Задача не найдена'});
      if (req.method === 'POST' && match[2]) {
        if (job.status !== 'running') return json(res,200,{ok:true});
        if (match[2] === '/finish') {job.stopAfterCurrent = true;return json(res,200,{ok:true});}
        job.controller?.abort(); return json(res, 200, {ok:true});
      }
      if (req.method === 'GET' && !match[2]) return json(res, 200, publicJob(job));
    }
    if (req.method === 'GET') {
      let file;
      if (url.pathname === '/') file = resolve('index.html');
      else if (url.pathname === '/app.js') file = resolve('app.js');
      else if (/^\/outputs\/[a-f0-9-]+\.png$/.test(url.pathname)) file = resolve('.' + url.pathname);
      if (file && fs.existsSync(file)) {res.writeHead(200, {'Content-Type': file.endsWith('.png') ? 'image/png' : file.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'}); return fs.createReadStream(file).pipe(res);}
    }
    json(res, 404, {error:'Не найдено'});
  } catch (e) {json(res, 400, {error:e.message});}
});
server.listen(config.port, config.listenHost || '127.0.0.1', () => console.log(`Qwen Image Studio: http://127.0.0.1:${config.port}`));
async function shutdown() {if (current) {jobs.get(current).controller.abort(); while(current) await new Promise(r => setTimeout(r,100));} server.close(); process.exit(0);}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
