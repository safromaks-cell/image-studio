const $ = id => document.getElementById(id);
let active = null, polling = false, latestStatus = null;
let promptInitialized = false, promptDefaults = null;
let shownResult = null, galleryOffset = null, galleryLoading = false, starting = false;
const promptFields={systemPrompt:'systemPrompt',temperature:'pTemperature',topP:'pTopP',topK:'pTopK',minP:'pMinP',repeatPenalty:'pRepeat',maxTokens:'pTokens',context:'pContext',seed:'pSeed',reasoningBudget:'pReasoning',examples:'pExamples'};
function readPromptSettings() {return Object.fromEntries(Object.entries(promptFields).map(([key,id])=>[key,key==='examples' ? $(id).checked : key==='systemPrompt' ? $(id).value : Number($(id).value)]));}
function setPromptSettings(settings) {for(const [key,id] of Object.entries(promptFields))if(settings[key]!==undefined) {if(key==='examples')$(id).checked=settings[key];else $(id).value=settings[key];}}
function savePromptSettings() {try {localStorage.setItem('studio.promptSettings',JSON.stringify(readPromptSettings()));$('promptSettingsState').textContent='Настройки сохранены на этом устройстве. Инструкция будет передана модели при следующем запуске.';}catch {$('promptSettingsState').textContent='Сохранение в браузере недоступно. Инструкция будет передана при следующем запуске из этой вкладки.'}}
function imageControls(reset=false) {
  const flux=latestStatus?.imageModels.find(m=>m.path===$('imageModel').value)?.family==='FLUX.1-dev';
  $('guidanceControls').hidden=!flux; $('cfg').disabled=flux; $('negative').disabled=flux;
  $('cfgInfo').textContent=flux ? 'Для FLUX CFG = 1. Используй отдельный Guidance.' : 'Сила следования промпту. Для Qwen начни с 6.';
  if(reset){$('cfg').value=flux ? 1 : 6;$('steps').value=flux ? 28 : 20;}
}
const rememberedModels = {};
for (const id of ['model','imageModel']) {try {rememberedModels[id] = localStorage.getItem('studio.' + id);} catch {}}
async function api(url, data) {const r = await fetch(url, {...(data ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)} : {}),signal:AbortSignal.timeout(15000)}); const v = await r.json(); if (!r.ok) throw Error(v.error || 'Ошибка сервера'); return v;}
function busy(value) {for (const id of ['rewrite','generate','auto','random','model','imageModel','refreshModels','count','infinite','useResult',...Object.values(promptFields),'resetPromptSettings']) $(id).disabled = value; $('cancel').hidden = !value; if (!value) availability();}
function availability() {
  if (!latestStatus || active || starting) return;
  $('useResult').disabled=false;
  const promptReady = latestStatus.promptModels.some(m => m.path === $('model').value && m.available);
  const imageReady = latestStatus.installed && latestStatus.imageModels.some(m => m.path === $('imageModel').value && m.available);
  $('count').disabled = $('infinite').checked;
  $('rewrite').disabled = !promptReady || $('infinite').checked; $('generate').disabled = !imageReady; $('auto').disabled = !promptReady || !imageReady || $('infinite').checked;
  $('random').disabled = !promptReady || !imageReady;
}
function modelSelect(id, models, defaultModel, infoId) {
  const select = $(id), previous = select.value || rememberedModels[id];
  const signature = JSON.stringify(models.map(m => [m.path,m.available,m.reason,m.bytes]));
  if (select.dataset.models !== signature) {
    select.replaceChildren();
    for (const m of models) {const o = new Option(m.name + (m.available ? '' : ' · недоступна'), m.path); o.disabled = !m.available; o.title = m.reason || m.path; select.add(o);}
    if (!models.length) {const o = new Option('Нет скачанных совместимых моделей', ''); o.disabled = true; select.add(o);}
    select.value = models.find(m => m.path === previous && m.available)?.path || models.find(m => m.path === defaultModel && m.available)?.path || models.find(m => m.available)?.path || '';
    select.dataset.models = signature;
  }
  const selected = models.find(m => m.path === select.value);
  $(infoId).textContent = selected ? `${(selected.bytes/1024**3).toFixed(2)} ГБ · ${selected.family || 'Текстовая модель'}${models.some(m => !m.available) ? ' · недоступные модели отмечены в списке' : ''}` : 'Нет доступных моделей. Скачай совместимые веса и обнови список.';
  $(infoId).title = selected?.path || '';
}
function show(result) {
  shownResult = result; $('copyPrompt').hidden = !result.prompt; $('useResult').hidden = !result.settings; $('useResult').disabled = !!active;
  if (result.url) {const img = new Image(); img.src = result.url; img.alt = result.prompt; $('preview').replaceChildren(img); $('download').href = result.url; $('download').hidden = false;}
  $('details').textContent = result.prompt + (result.settings ? ` · ${result.settings.width}×${result.settings.height} · ${result.settings.steps} шагов · seed ${result.settings.seed}` : '') + (result.settings?.imageModel ? ' · ' + result.settings.imageModel.split(/[\\/]/).pop() : '') + (result.promptModel ? ' · Промпт: ' + result.promptModel.split(/[\\/]/).pop() : '');
}
async function gallery(append=false) {
  if(galleryLoading) return;
  galleryLoading=true; $('moreGallery').disabled=true;
  try {
    const page=await api('/api/gallery?paged=1&limit=24&offset='+(append ? galleryOffset || 0 : 0));
    const entries=Array.isArray(page) ? page : page.items;
    if(!append)$('gallery').replaceChildren();
    for (const entry of entries) {const b = document.createElement('button'); const img = new Image(); img.src = entry.url; img.alt = entry.prompt; img.loading = 'lazy'; const caption = document.createElement('small'); caption.textContent = new Date(entry.created).toLocaleString('ru-RU'); b.append(img,caption); b.onclick = () => show(entry); $('gallery').append(b);}
    galleryOffset=Array.isArray(page) ? null : page.nextOffset;
    $('moreGallery').hidden=galleryOffset===null;
    $('galleryState').textContent=entries.length || append ? `Показано ${$('gallery').children.length}${Array.isArray(page) ? '' : ' из '+page.total}` : 'Пока нет изображений.';
  } catch(e) {$('galleryState').textContent='Не удалось обновить галерею. '+e.message;}
  finally {galleryLoading=false;$('moreGallery').disabled=false;}
}
async function status() {
  const s = await api('/api/status');
  // Older running servers can still serve the updated static files.
  s.promptModels ||= (s.models || []).map(m => ({...m,available:true}));
  s.imageModels ||= s.installed ? [{path:'models/qwen-image-2.1-UC-Q4_K_M.gguf',name:'qwen-image-2.1-UC-Q4_K_M.gguf',family:'Qwen-Image 2.1',bytes:4604558112,available:true}] : [];
  s.defaultImageModel ||= s.imageModels[0]?.path;
  latestStatus = s;
  $('restartNotice').hidden = !!s.defaultPromptSettings && !!s.generationSeries && !!s.randomIdeas && !!s.gracefulStop;
  if(!promptInitialized) {
    promptDefaults={...readPromptSettings(),...s.defaultPromptSettings,systemPrompt:$('systemPrompt').defaultValue};
    setPromptSettings(promptDefaults);
    try {const saved=JSON.parse(localStorage.getItem('studio.promptSettings'));if(saved){if(saved.systemPrompt?.startsWith('You write prompts for image generation.') && !saved.systemPrompt.includes('default to photorealistic imagery'))saved.systemPrompt=promptDefaults.systemPrompt;setPromptSettings(saved);}}catch {}
    promptInitialized=true;
  }
  $('gpu').textContent = s.gpu.error || `${s.gpu.name} · свободно ${Math.round(s.gpu.free/1024*10)/10} / ${Math.round(s.gpu.total/1024)} ГБ`;
  modelSelect('model',s.promptModels,s.defaultModel,'promptModelInfo');
  modelSelect('imageModel',s.imageModels,s.defaultImageModel,'imageModelInfo');
  imageControls();
  $('networkInfo').hidden=!s.networkUrls?.length;
  if(s.networkUrls?.length){$('networkUrl').href=s.networkUrls[0];$('networkUrl').textContent=s.networkUrls[0];}
  $('fluxStatus').hidden=!s.flux;
  if(s.flux){const labels={waiting:'Ожидание скачивания',downloading:'Скачивание',downloaded:'Скачано',preparing:'Подготовка весов',testing:'Проверка GPU',ready:'Готова',error:'Ошибка'};$('fluxStatus').textContent=`FLUX: ${labels[s.flux.state] || s.flux.state} · ${s.flux.percent}% · ${(s.flux.completed/1e9).toFixed(1)} / ${(s.flux.total/1e9).toFixed(1)} ГБ${s.flux.phase ? ' · '+s.flux.phase : ''}${s.flux.error ? ' · '+s.flux.error : ''}`;}
  if (!s.installed && !active) $('status').textContent = `Скачивание файлов: ${s.downloads.percent}% · ${(s.downloads.completed/1e9).toFixed(1)} / ${(s.downloads.total/1e9).toFixed(1)} ГБ\n` + s.downloads.items.map(i=>`${i.percent}% · ${i.name}`).join('\n');
  availability();
  if (s.busy && !active && !starting) {active = s.busy; busy(true); void poll();}
}
async function poll() {
  if (polling) return;
  polling = true;
  try {
    while(active) {
      let job;
      try {job = await api('/api/jobs/' + active);} catch(e) {
        $('status').textContent='Связь прервалась. Переподключаемся; задача на сервере продолжает работать.';
        await new Promise(r=>setTimeout(r,3000));continue;
      }
      $('finish').hidden = !latestStatus?.gracefulStop || job.status !== 'running' || job.mode === 'prompt';
      $('finish').disabled=!!job.stopAfterCurrent;
      $('finish').textContent=job.stopAfterCurrent ? 'Завершаем текущее…' : 'Закончить текущее';
      $('progress').hidden=job.mode === 'prompt';
      if(job.infinite)$('progress').removeAttribute('value');else {$('progress').max=job.count || 1;$('progress').value=job.completed || 0;}
      const progress = job.completed ? ` · готово ${job.completed}${job.infinite ? ' · ∞' : ' / ' + job.count}` : '';
      const elapsed=job.elapsedSeconds ?? (Date.now()-Date.parse(job.created))/1000;
      const remaining=job.completed && Number.isFinite(job.completedSeconds) && !job.infinite && !job.stopAfterCurrent ? Math.max(0,(job.completedSeconds / job.completed)*job.count-elapsed) : null;
      $('status').textContent = job.phase + progress + (job.status === 'running' ? ` · ${Math.round(elapsed)} сек.${remaining!==null ? ' · осталось примерно '+Math.ceil(remaining/60)+' мин.' : ''}${job.stopAfterCurrent ? ' · остановка после сохранения' : ''}` : '');
      if (job.result?.url && $('download').getAttribute('href') !== job.result.url) {show(job.result); await gallery();}
      if (job.status !== 'running') {
        if (job.status === 'cancelled') $('status').textContent = 'Остановлено' + progress;
        else if (job.error) $('status').textContent = job.error + progress;
        else {if (job.result?.mode === 'prompt' && $('prompt').value.trim() === job.result.sourcePrompt) $('prompt').value = job.result.prompt; if(job.result) show(job.result); $('status').textContent = `${job.phase} за ${job.seconds.toFixed(1)} сек.` + progress; await gallery();}
        active = null; busy(false); $('finish').hidden=true;$('useResult').disabled=false; await status(); break;
      }
      await new Promise(r => setTimeout(r,1000));
    }
  } catch(e) {$('status').textContent = e.message; active = null; busy(false);}
  finally {polling = false; if(active) void poll();}
}
async function start(mode) {
  if(active || starting)return;
  if (mode !== 'image' && !latestStatus?.defaultPromptSettings) {
    $('status').textContent = 'Запущена старая версия сервера: верхняя инструкция не поддерживается. Перезапусти Studio через Restart Studio.cmd после завершения текущей задачи и обнови страницу.';
    return;
  }
  if (mode === 'random' && !latestStatus?.randomIdeas) {
    $('status').textContent = 'Для случайных идей ИИ перезапусти Studio через Restart Studio.cmd после завершения текущей задачи, затем обнови страницу.';
    return;
  }
  if (mode !== 'prompt' && ($('infinite').checked || Number($('count').value) !== 1) && !latestStatus?.generationSeries) {
    $('status').textContent = 'Для серии и бесконечного режима перезапусти Studio через Restart Studio.cmd после завершения текущей задачи, затем обнови страницу.';
    return;
  }
  starting=true;busy(true);
  try {const infinite = $('infinite').checked && mode !== 'prompt'; const input = {mode:infinite && mode !== 'random' ? 'image' : mode, count:mode === 'prompt' || infinite ? 1 : Number($('count').value), infinite, prompt:$('prompt').value, model:$('model').value, promptModel:$('model').value, imageModel:$('imageModel').value, promptSettings:readPromptSettings(),negative:$('negative').value}; for(const id of ['width','height','steps','cfg','guidance','seed']) input[id] = Number($(id).value); const job = await api('/api/jobs',input); active = job.id; void poll();}
  catch(e) {$('status').textContent = e.message; busy(false);}
  finally {starting=false;if(!active)availability();}
}
$('rewrite').onclick = () => start('prompt'); $('generate').onclick = () => start('image'); $('auto').onclick = () => start('auto'); $('cancel').onclick = async () => {try {if(active) await api(`/api/jobs/${active}/cancel`,{});} catch(e){$('status').textContent = e.message;}};
$('infinite').onchange = availability;
$('random').onclick = () => start('random');
$('finish').onclick=async()=>{try {if(active){await api(`/api/jobs/${active}/finish`,{});$('finish').disabled=true;$('finish').textContent='Завершаем текущее…';}}catch(e){$('status').textContent=e.message;}};
$('moreGallery').onclick=()=>gallery(true);
$('sizePreset').onchange=()=>{if($('sizePreset').value){const [w,h]=$('sizePreset').value.split('x');$('width').value=w;$('height').value=h;}};
$('qualityPreset').onchange=()=>{if($('qualityPreset').value)$('steps').value=$('qualityPreset').value;};
for(const id of ['width','height'])$(id).onchange=()=>{$('sizePreset').value=$('width').value+'x'+$('height').value;};
$('steps').oninput=()=>{$('qualityPreset').value=$('steps').value;};
$('copyPrompt').onclick=async()=>{
  if(!shownResult?.prompt)return;
  try {
    if(navigator.clipboard && window.isSecureContext)await navigator.clipboard.writeText(shownResult.prompt);
    else {const field=document.createElement('textarea');field.value=shownResult.prompt;field.style.position='fixed';field.style.top='-9999px';document.body.append(field);field.select();const copied=document.execCommand('copy');field.remove();if(!copied)throw Error('copy');}
    $('resultMessage').textContent='Промпт скопирован.';
  } catch {$('resultMessage').textContent='Браузер не разрешил копирование. Можно выделить промпт в описании результата.';}
};
$('useResult').onclick=()=>{
  if(active || !shownResult?.settings)return;
  $('prompt').value=shownResult.prompt;
  const settings=shownResult.settings;
  if(latestStatus?.imageModels.some(m=>m.path===settings.imageModel && m.available)){$('imageModel').value=settings.imageModel;imageControls();}
  for(const id of ['width','height','steps','cfg','guidance','seed','negative'])if(settings[id]!==undefined)$(id).value=settings[id];
  $('count').value=1;$('infinite').checked=false;$('sizePreset').value=settings.width+'x'+settings.height;$('qualityPreset').value=settings.steps;availability();
  $('resultMessage').textContent='Промпт, seed и параметры перенесены. Нажми «Создать изображения», чтобы повторить.';$('prompt').focus();
};
for (const id of ['model','imageModel']) $(id).onchange = () => {rememberedModels[id] = $(id).value; try {localStorage.setItem('studio.' + id,$(id).value);} catch {} if(latestStatus) {modelSelect(id,latestStatus[id === 'model' ? 'promptModels' : 'imageModels'],latestStatus[id === 'model' ? 'defaultModel' : 'defaultImageModel'],id === 'model' ? 'promptModelInfo' : 'imageModelInfo'); if(id==='imageModel')imageControls(true); availability();}};
for(const id of Object.values(promptFields))$(id).oninput=savePromptSettings;
$('resetPromptSettings').onclick=()=>{if(promptDefaults)setPromptSettings(promptDefaults);savePromptSettings();};
$('refreshModels').onclick = () => status().catch(e => $('status').textContent = e.message);
status().catch(e => $('status').textContent = e.message); gallery().catch(() => {}); setInterval(() => status().catch(() => {}),5000);
