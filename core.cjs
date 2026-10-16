const fs = require('node:fs');
const path = require('node:path');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {randomBytes, randomInt} = require('node:crypto');
const runFile = promisify(execFile);
const ROOT = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const resolve = p => path.resolve(ROOT, p);
const defaultPromptSettings = {
  systemPrompt:'You write prompts for image generation. Translate the idea into a clear English image prompt. Preserve all requested subjects and exact quoted lettering. If no visual style or medium is specified, default to photorealistic imagery with natural lighting, realistic materials, textures and proportions. If the user explicitly requests anime, manga, watercolor, painting, illustration, cartoon, 3D rendering or any other style or medium, preserve that requested style instead and do not add photorealism. Describe composition, lighting and materials without inventing unrelated subjects. Return ONLY the English image prompt, no explanations, headings or markdown. Maximum 130 words.',
  temperature:0.55,topP:0.95,topK:40,minP:0.05,repeatPenalty:1.1,maxTokens:240,context:2048,seed:-1,reasoningBudget:0,examples:true
};
function promptSettings(input = {}) {
  if(!input || typeof input!=='object' || Array.isArray(input))throw Error('Некорректные настройки промптов.');
  const settings={...defaultPromptSettings};
  for(const [key,min,max,integer] of [['temperature',0,2,false],['topP',0.01,1,false],['topK',0,1000,true],['minP',0,1,false],['repeatPenalty',0.5,2,false],['maxTokens',16,2048,true],['context',1024,8192,true],['seed',-1,2147483647,true],['reasoningBudget',0,1024,true]]) {
    const value=Number(input[key] ?? settings[key]);
    if(!Number.isFinite(value) || value<min || value>max || integer && !Number.isInteger(value))throw Error('Некорректная настройка промптов: '+key);
    settings[key]=value;
  }
  if(settings.context%256 || settings.maxTokens>settings.context-512)throw Error('Контекст должен быть кратен 256 и оставлять минимум 512 токенов для инструкции и идеи.');
  if(input.systemPrompt!==undefined) {if(typeof input.systemPrompt!=='string' || !input.systemPrompt.trim() || input.systemPrompt.length>12000)throw Error('Системная инструкция: от 1 до 12000 символов.');settings.systemPrompt=input.systemPrompt.trim();}
  if(input.examples!==undefined) {if(typeof input.examples!=='boolean')throw Error('Некорректный переключатель примеров.');settings.examples=input.examples;}
  return settings;
}
function options(input) {
  const prompt = String(input.prompt || '').trim();
  if (!prompt || prompt.length > 8000) throw Error('Промпт должен содержать от 1 до 8000 символов.');
  const value = (key, fallback, min, max, multiple = 1) => {
    const n = Number(input[key] ?? fallback);
    if (!Number.isFinite(n) || n < min || n > max || (multiple && n % multiple)) throw Error('Некорректный параметр: ' + key);
    return n;
  };
  return {prompt, negative: String(input.negative || '').slice(0, 8000), width: value('width', 512, 256, 1024, 32), height: value('height', 512, 256, 1024, 32), steps: value('steps', 20, 1, 1000), cfg: value('cfg', 6, 1, 15, 0), guidance: value('guidance', 3.5, 0, 20, 0), seed: value('seed', -1, -1, 2147483647)};
}
function modelFiles(roots) {
  const list = [];
  const seen = new Set();
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(file);
      else if (/\.gguf$/i.test(entry.name) && !fs.existsSync(file + '.aria2')) {
        const bytes = fs.statSync(file).size;
        const key = file.toLowerCase();
        if (bytes && !seen.has(key)) {seen.add(key); list.push({path: file, name: entry.name, bytes});}
      }
    }
  }
  for (const root of roots) walk(resolve(root));
  return list.sort((a,b) => a.name.localeCompare(b.name));
}
function discoverPromptModels(roots = config.promptModelRoots || [config.modelRoot]) {
  return modelFiles(roots).filter(m => !/mmproj|qwen[-_]?image|qwen3[-_]?vl|clip[-_]|t5[-_]|vae/i.test(m.name)).map(m => {
    const sizes = [...m.name.matchAll(/(?:^|[-_.])(?:E)?(\d+(?:\.\d+)?)B(?=[-_.]|$)/gi)].map(v => Number(v[1]));
    const supported = sizes.length > 0 && Math.max(...sizes) <= 13;
    return {...m, available: supported, reason: supported ? '' : sizes.length ? 'Больше 13B: недоступна в текущем режиме загрузки всех слоёв на GPU.' : 'Размер модели неизвестен: текущий GPU-режим поддерживает модели до 13B.'};
  });
}
function discoverModels() {return discoverPromptModels().filter(m => m.available);}
function discoverImageModels(roots = config.imageModelRoots || ['models', config.modelRoot]) {
  const candidates = modelFiles(roots).filter(m => /qwen[-_]image[-_]2[._-]1.*\.gguf$/i.test(m.name));
  const defaultPath = resolve(config.imageModel);
  if (fs.existsSync(defaultPath) && fs.statSync(defaultPath).size && !fs.existsSync(defaultPath + '.aria2') && !candidates.some(m => m.path === defaultPath)) candidates.unshift({path: defaultPath, name: path.basename(defaultPath), bytes: fs.statSync(defaultPath).size});
  const models = candidates.map(m => {
    const missing = [config.textEncoder, config.vae].filter(p => !fs.existsSync(resolve(p)) || !fs.statSync(resolve(p)).size || fs.existsSync(resolve(p) + '.aria2'));
    return {...m, family: 'Qwen-Image 2.1', available: !missing.length, reason: missing.length ? 'Не скачаны компоненты: ' + missing.join(', ') : '', textEncoder: resolve(config.textEncoder), vae: resolve(config.vae)};
  });
  for (const profile of config.imageProfiles || []) {
    const files = [profile.path,profile.clipL,profile.t5,profile.vae,profile.readyFile].filter(Boolean);
    const missing = files.filter(p => !fs.existsSync(resolve(p)) || !fs.statSync(resolve(p)).size || fs.existsSync(resolve(p)+'.aria2'));
    models.push({...profile,path:resolve(profile.path),clipL:resolve(profile.clipL),t5:resolve(profile.t5),vae:resolve(profile.vae),bytes:fs.existsSync(resolve(profile.path)) ? fs.statSync(resolve(profile.path)).size : 0,available:missing.length===0,reason:missing.length ? 'Скачивание или подготовка FLUX ещё не завершены.' : ''});
  }
  return models;
}
function selectPromptModel(value) {
  const model = discoverPromptModels().find(m => m.path === resolve(value || config.promptModel));
  if (!model) throw Error('Выбери скачанную модель промптов из списка.');
  if (!model.available) throw Error(model.reason);
  return model;
}
function selectImageModel(value) {
  const model = discoverImageModels().find(m => m.path === resolve(value || config.imageModel));
  if (!model) throw Error('Выбери скачанную модель изображений из списка.');
  if (!model.available) throw Error(model.reason);
  return model;
}
function validateModels(input) {
  if (input.mode !== 'image') {selectPromptModel(input.promptModel || input.model);promptSettings(input.promptSettings);}
  if (input.mode !== 'prompt') selectImageModel(input.imageModel);
}
function imageArgs(input, output) {
  const o = options(input);
  const model = selectImageModel(input.imageModel);
  const components = model.family === 'FLUX.1-dev' ? ['--clip_l',model.clipL,'--t5xxl',model.t5,'--cfg-scale','1','--guidance',String(o.guidance),'--max-vram','6.5'] : ['--llm',model.textEncoder,'--model-args','qwen_image_2_1_prefix_cache_type=q8_0','--cfg-scale',String(o.cfg),'-n',o.negative];
  return ['--diffusion-model', model.path, '--vae', model.vae, ...components, '--backend', 'cuda0', '--offload-to-cpu', '--fa', '--vae-tiling', '--sampling-method', 'euler', '--steps', String(o.steps), '--width', String(o.width), '--height', String(o.height), '--seed', String(o.seed), '-p', o.prompt, '-o', output];
}
function cliPath() {
  const file = resolve('runtime/cli-path.txt');
  if (!fs.existsSync(file)) throw Error('Сначала выполни Install.ps1 для скачивания моделей и CUDA runtime.');
  const exe = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!fs.existsSync(exe)) throw Error('Не найден sd-cli.exe. Повтори Install.ps1.');
  return exe;
}
function promptMessages(input, preferences = defaultPromptSettings) {
  const messages = [
    {role:'system', content:preferences.systemPrompt},
    {role:'user', content:'Write an English image prompt: красная чашка на деревянном столе, мягкий утренний свет, предметное фото'},
    {role:'assistant', content:'A red ceramic cup on a wooden table, soft morning light from a nearby window, natural textures, close-up composition, photorealistic product photography.'},
    {role:'user', content:'Write an English image prompt: уютная книжная лавка с вывеской "BOOKS", акварель'},
    {role:'assistant', content:'A cozy bookshop with a sign reading "BOOKS", warm light glowing through the windows, inviting street-level composition, delicate watercolor illustration on textured paper, soft pigment washes and loose brushstrokes.'},
    {role:'user', content:'Write an English image prompt for this idea. Preserve the art style and exact quoted lettering. Output only the English prompt. Idea: ' + input}
  ];
  if(!preferences.examples) messages.splice(1,4);
  // The editable system instruction controls the requested output format.
  messages[messages.length-1].content=input;
  return messages;
}
async function gpuMemory() {
  const {stdout} = await runFile('nvidia-smi', ['--query-gpu=memory.free,memory.total,name', '--format=csv,noheader,nounits'], {windowsHide: true});
  const [free, total, ...name] = stdout.trim().split('\n')[0].split(',');
  return {free: Number(free), total: Number(total), name: name.join(',').trim()};
}
function makeRuntime() {
  let active = null;
  async function launch(exe, args, logFile, signal) {
    if (active) throw Error('Предыдущая модель ещё не выгружена.');
    signal.throwIfAborted();
    const log = fs.createWriteStream(logFile);
    const child = spawn(exe, args, {cwd: path.dirname(exe), windowsHide: true, env: {...process.env, GGML_CUDA_FORCE_MMQ: '1'}, stdio: ['ignore', 'pipe', 'pipe']});
    let recent = '';
    const append = chunk => { const t = chunk.toString(); recent = (recent + t).slice(-100000); log.write(t); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const done = new Promise((resolveDone, rejectDone) => {
      child.once('error', rejectDone);
      child.once('close', code => { log.end(); active = null; signal.removeEventListener('abort', cancel); resolveDone(code); });
    });
    done.catch(() => {});
    const cancel = () => child.kill();
    active = child;
    signal.addEventListener('abort', cancel, {once: true});
    if (signal.aborted) cancel();
    return {child, done, recent: () => recent, stop: async () => { if (child.exitCode === null) child.kill(); await done; }};
  }
  return {
    async rewrite(input, model, signal, update, id, preferences = defaultPromptSettings) {
      preferences=promptSettings(preferences);
      model = selectPromptModel(model).path;
      if (!fs.existsSync(config.llamaExe)) throw Error('Не найден llama-server.exe из Qwen_Simple_Chat.');
      const gpu = await gpuMemory();
      if (gpu.free < 6200) throw Error(`Недостаточно свободной VRAM: ${gpu.free} МБ. Выгрузи модели в других приложениях (нужно около 6.2 ГБ).`);
      update('Загрузка модели промптов на GPU');
      const apiKey = randomBytes(32).toString('hex');
      const headers = {Authorization: 'Bearer ' + apiKey};
      const args = ['--model', model, '--host', '127.0.0.1', '--port', String(config.llamaPort), '--api-key', apiKey, '--device', 'CUDA0', '--n-gpu-layers', 'all', '--fit', 'off', '--ctx-size', String(preferences.context), '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--parallel', '1', '--batch-size', '128', '--ubatch-size', '64', '--flash-attn', 'on', '--jinja', '--reasoning-budget', String(preferences.reasoningBudget), '--no-warmup', '--log-verbosity', '4'];
      const proc = await launch(config.llamaExe, args, resolve(`logs/${id}-llama.log`), signal);
      try {
        let ready = false;
        const deadline = Date.now() + 180000;
        while (Date.now() < deadline) {
          signal.throwIfAborted();
          if (proc.child.exitCode !== null) throw Error('Ошибка загрузки Llama: ' + proc.recent().slice(-2000));
          try { const r = await fetch(`http://127.0.0.1:${config.llamaPort}/health`, {headers, signal: AbortSignal.timeout(1500)}); if (r.ok) {ready = true; break;} } catch {}
          await new Promise(r => setTimeout(r, 300));
        }
        if (!ready) throw Error('Превышено время загрузки Llama.');
        const layers = [...proc.recent().matchAll(/offloaded\s+(\d+)\/(\d+)\s+layers to GPU/gi)].at(-1);
        if (!layers || layers[1] !== layers[2]) throw Error('Не все слои Llama загружены на GPU. CPU fallback запрещён.');
        update(`Модель пишет промпт · ${layers[1]}/${layers[2]} слоёв GPU`);
        const response = await fetch(`http://127.0.0.1:${config.llamaPort}/v1/chat/completions`, {
          method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]), headers: {...headers, 'Content-Type': 'application/json'},
          body: JSON.stringify({messages: promptMessages(input,preferences), temperature: preferences.temperature,top_p:preferences.topP,top_k:preferences.topK,min_p:preferences.minP,repeat_penalty:preferences.repeatPenalty,seed:preferences.seed,max_tokens:preferences.maxTokens, stream: false})
        });
        if (!response.ok) throw Error('Llama: ' + await response.text());
        const data = await response.json();
        const prompt = data.choices?.[0]?.message?.content?.trim();
        if (!prompt) throw Error('Llama вернула пустой промпт.');
        return prompt;
      } finally { update('Выгрузка модели промптов из VRAM'); await proc.stop(); }
    },
    async image(input, signal, update, id) {
      const model = selectImageModel(input.imageModel);
      const gpu = await gpuMemory();
      if (gpu.free < 6200) throw Error(`Недостаточно свободной VRAM: ${gpu.free} МБ. Выгрузи другие модели.`);
      update(model.name + ': загрузка и генерация на GPU');
      const file = resolve(`outputs/${id}.png`);
      const proc = await launch(cliPath(), imageArgs(input, file), resolve(`logs/${id}-image.log`), signal);
      const timer = setTimeout(() => proc.child.kill(), Math.max(45 * 60 * 1000, input.steps * 30 * 1000));
      try {
        const code = await proc.done;
        signal.throwIfAborted();
        if (code !== 0) throw Error(model.family + ' завершилась с ошибкой. ' + proc.recent().slice(-2500));
        if (!fs.existsSync(file)) throw Error(model.family + ' не сохранила изображение. Проверь журнал.');
        return file;
      } finally {clearTimeout(timer); await proc.stop();}
    }
  };
}
function generationSettings(input) {
  const count = input.count ?? 1;
  const infinite = input.infinite ?? false;
  if (typeof infinite !== 'boolean') throw Error('Некорректный переключатель бесконечного режима.');
  if (!Number.isSafeInteger(count) || count < 1) throw Error('Количество изображений должно быть целым числом от 1.');
  if (infinite && !['image','random'].includes(input.mode)) throw Error('Бесконечный режим доступен для готового промпта и случайных идей ИИ.');
  return {count: input.mode === 'prompt' ? 1 : count, infinite};
}
async function pipeline(input, runtime, signal, update, id, onResult = async () => {}, finishRequested = () => false) {
  const {count, infinite} = generationSettings(input);
  const validated = options(input);
  validateModels(input);
  const promptModel = input.mode === 'image' ? undefined : selectPromptModel(input.promptModel || input.model).path;
  const preferences = input.mode === 'image' ? undefined : promptSettings(input.promptSettings);
  let prompt = validated.prompt;
  if (!['image','random'].includes(input.mode)) prompt = await runtime.rewrite(prompt, promptModel, signal, update, id, preferences);
  signal.throwIfAborted();
  if (input.mode === 'prompt') return {prompt, sourcePrompt:validated.prompt, mode:input.mode, promptModel, promptSettings:preferences};
  const selectedImage = selectImageModel(input.imageModel);
  const settings = {...validated, prompt, cfg: selectedImage.family === 'FLUX.1-dev' ? 1 : validated.cfg, negative:selectedImage.family === 'FLUX.1-dev' ? '' : validated.negative, imageModel: selectedImage.path, family:selectedImage.family, seed: validated.seed < 0 ? randomInt(2147483647) : validated.seed};
  let result;
  const firstSeed = settings.seed;
  const variationSeed = input.mode === 'random' ? randomInt(2147483647) : 0;
  for (let index = 0; infinite || index < count; index++) {
    signal.throwIfAborted();
    const imageId = count === 1 && !infinite ? id : `${id}-${index + 1}`;
    const imageUpdate = phase => update(`${phase} · изображение ${index + 1}${infinite ? ' · ∞' : ' / ' + count}`);
    let imagePreferences = preferences;
    if (input.mode === 'random') {
      imagePreferences = {...preferences, examples:false, temperature:Math.max(preferences.temperature,0.9), seed:(variationSeed + index) % 2147483647,
        systemPrompt:preferences.systemPrompt + '\nFor this task, create ONE imaginative, randomly varied English image prompt based ONLY on the user request. Treat the request as the theme and constraints for a new scene, rather than merely translating it. Preserve every explicitly requested subject, style, restriction and exact quoted lettering. Randomly vary unspecified composition, setting, lighting, viewpoint and details while remaining within that request. Never use conversation history or previous prompts. Return only the image prompt, no commentary. Variation number: ' + (index + 1)};
      prompt = await runtime.rewrite(validated.prompt, promptModel, signal, imageUpdate, imageId, imagePreferences);
      signal.throwIfAborted();
      options({...validated,prompt});
    }
    const imageSettings = {...settings, prompt, seed: (firstSeed + index) % 2147483647};
    const file = await runtime.image(imageSettings, signal, imageUpdate, imageId);
    result = {prompt, sourcePrompt:validated.prompt, mode:input.mode, promptModel, promptSettings:imagePreferences, file, settings:imageSettings};
    await onResult(result, index + 1, imageId);
    if (finishRequested()) break;
  }
  return result;
}
module.exports = {config, resolve, options, generationSettings, defaultPromptSettings,promptSettings,promptMessages,discoverModels, discoverPromptModels, discoverImageModels, selectPromptModel, selectImageModel, validateModels, imageArgs, gpuMemory, makeRuntime, pipeline};
