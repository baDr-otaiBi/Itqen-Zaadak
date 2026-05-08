// Itqin Zaadak — Cloze engine with IndexedDB ingestion and strict tashkeel toggle
// Architectural goals: XML -> IndexedDB import (once), cloze word-by-word, SM-2 stored in DB, zero-RAM bulk loads

const DB_NAME = 'itqin_zaadak_db';
const DB_VERSION = 1;
const XML_PATH = '/quran-simple.xml';

// Utilities
function nowSeconds(){return Math.floor(Date.now()/1000)}
const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED\u0670]/g;
function stripDiacritics(s){ return (s||'').replace(ARABIC_DIACRITICS,'').replace(/\s+/g,' ').trim(); }
function tokenizeArabic(s){ return (s||'').trim().split(/\s+/).filter(Boolean); }

function levenshtein(a,b){
  a = a||''; b = b||'';
  if(a===b) return 0;
  const m=a.length,n=b.length; const dp = Array.from({length:m+1},()=>Array(n+1).fill(0));
  for(let i=0;i<=m;i++) dp[i][0]=i; for(let j=0;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++) for(let j=1;j<=n;j++){
    const cost = a[i-1]===b[j-1]?0:1;
    dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
  }
  return dp[m][n];
}

// SM-2 minimal class (used to compute schedule and persisted)
class SM2Item{
  constructor(id){ this.id=id; this.ef=2.5; this.interval=0; this.reps=0; this.next=0; this.history=[]; }
  applyReview(quality, responseTime, errorRate){
    const timePenalty = Math.min(1.5, Math.max(0, (responseTime - 8)/15));
    const errorPenalty = Math.min(1, errorRate*2);
    const adjusted = Math.max(0, Math.min(5, quality - errorPenalty - timePenalty));
    if(adjusted < 3){ this.reps = 0; this.interval = 1; }
    else{ if(this.reps===0) this.interval=1; else if(this.reps===1) this.interval=6; else this.interval = Math.round(this.interval * this.ef); this.reps += 1; }
    this.ef = this.ef + (0.1 - (5 - adjusted) * (0.08 + (5 - adjusted) * 0.02)); if(this.ef < 1.3) this.ef = 1.3;
    const nextDate = new Date(Date.now() + this.interval * 24*3600*1000); this.next = Math.floor(nextDate.getTime()/1000);
    this.history.push({t:nowSeconds(), quality:adjusted, responseTime, errorRate, next:this.next});
  }
}

// IndexedDB helpers
function openDB(){
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev)=>{
      const db = ev.target.result;
      if(!db.objectStoreNames.contains('ayah')){
        const s = db.createObjectStore('ayah', {keyPath:'id'}); s.createIndex('surah','surahIndex',{unique:false});
      }
      if(!db.objectStoreNames.contains('progress')){
        const p = db.createObjectStore('progress', {keyPath:'id'}); p.createIndex('surah','surahIndex',{unique:false});
      }
      if(!db.objectStoreNames.contains('meta')){
        db.createObjectStore('meta', {keyPath:'k'});
      }
    };
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}

async function getMeta(db, key){ return new Promise((res,rej)=>{ const tx=db.transaction('meta').objectStore('meta').get(key); tx.onsuccess = ()=> res(tx.result?tx.result.v:null); tx.onerror=()=>rej(tx.error); }); }
async function putMeta(db, key, value){ return new Promise((res,rej)=>{ const tx=db.transaction('meta','readwrite').objectStore('meta').put({k:key,v:value}); tx.onsuccess=()=>res(); tx.onerror=()=>rej(tx.error); }); }

async function putAyah(db, ayah){ return new Promise((res,rej)=>{ const tx=db.transaction('ayah','readwrite').objectStore('ayah').put(ayah); tx.onsuccess=()=>res(); tx.onerror=()=>rej(tx.error); }); }
async function getAyah(db, surahIndex, ayaIndex){ const id = `s${surahIndex}_a${ayaIndex}`; return new Promise((res,rej)=>{ const tx=db.transaction('ayah').objectStore('ayah').get(id); tx.onsuccess=()=>res(tx.result); tx.onerror=()=>rej(tx.error); }); }

async function putProgress(db, progress){ return new Promise((res,rej)=>{ const tx=db.transaction('progress','readwrite').objectStore('progress').put(progress); tx.onsuccess=()=>res(); tx.onerror=()=>rej(tx.error); }); }
async function getProgress(db, id){ return new Promise((res,rej)=>{ const tx=db.transaction('progress').objectStore('progress').get(id); tx.onsuccess=()=>res(tx.result); tx.onerror=()=>rej(tx.error); }); }
async function getProgressBySurah(db, surahIndex){ return new Promise((res,rej)=>{ const store=db.transaction('progress').objectStore('progress'); const idx = store.index('surah'); const req = idx.getAll(IDBKeyRange.only(surahIndex)); req.onsuccess=()=>res(req.result||[]); req.onerror=()=>rej(req.error); }); }

// XML ingestion (DOMParser) — runs only once
async function importXMLIfNeeded(db){
  const imported = await getMeta(db,'imported_v1');
  if(imported) return await getMeta(db,'surah_list');
  // fetch XML
  const resp = await fetch(XML_PATH);
  if(!resp.ok) throw new Error('Failed to fetch XML');
  const text = await resp.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text,'application/xml');
  const suras = Array.from(doc.querySelectorAll('sura'));
  const surahList = [];
  for(const s of suras){
    const surahIndex = Number(s.getAttribute('index'));
    const surahName = s.getAttribute('name') || '';
    const ayat = Array.from(s.querySelectorAll('aya'));
    for(const a of ayat){
      const ayaIndex = Number(a.getAttribute('index'));
      const ayaText = a.getAttribute('text') || a.textContent || '';
      const id = `s${surahIndex}_a${ayaIndex}`;
      await putAyah(db, {id, surahIndex, surahName, ayaIndex, text: ayaText});
    }
    surahList.push({surahIndex, surahName, count: ayat.length});
  }
  await putMeta(db,'surah_list', surahList);
  await putMeta(db,'imported_v1', true);
  return surahList;
}

// UI wiring — strict cloze engine
const UI = {
  db: null,
  surahList: [],
  active: {surahIndex:1, ayaIndex:1, revealed:0},
  elements: {},

  async init(){
    this.elements = {
      surahListEl: document.getElementById('surah-list'),
      heatmapEl: document.getElementById('heatmap'),
      clozeContainer: document.getElementById('cloze-container'),
      surahTitle: document.getElementById('surah-title'),
      liveFeedback: document.getElementById('live-feedback'),
      timer: document.getElementById('timer'),
      tashkeelToggle: document.getElementById('tashkeel-toggle'),
      tolerance: document.getElementById('tolerance'),
      initialWords: document.getElementById('initial-words'),
      progressEl: document.getElementById('progress'),
      schedulesEl: document.getElementById('schedules')
    };
    this.db = await openDB();
    this.surahList = await importXMLIfNeeded(this.db);
    if(!this.surahList || !this.surahList.length) this.surahList = await getMeta(this.db,'surah_list') || [];
    this.renderSurahList();
    this.loadActiveFromURL();
    setInterval(()=>this.updateTimer(),500);
    // attach control listeners
    this.elements.tolerance.addEventListener('input', ()=>{ this.elements.liveFeedback.textContent = `Tolerance: ${this.elements.tolerance.value}%`; });
    this.elements.initialWords.addEventListener('change', ()=>{ this.active.revealed = Math.max(0, Math.min(this.words?this.words.length:0, Number(this.elements.initialWords.value))); this.spawnCloze(); });
  },

  loadActiveFromURL(){
    // default: first surah and aya 1
    if(this.surahList.length){ this.active.surahIndex = this.surahList[0].surahIndex; this.active.ayaIndex = 1; this.active.revealed = 0; this.renderActive(); }
  },

  renderSurahList(){
    const el = this.elements.surahListEl; el.innerHTML = '';
    for(const s of this.surahList){
      const li = document.createElement('li');
      const btn = document.createElement('button'); btn.className='text-sm w-full text-right p-2 rounded hover:bg-gray-700';
      btn.textContent = `${s.surahName} (${s.count})`;
      btn.onclick = ()=>{ this.active.surahIndex = s.surahIndex; this.active.ayaIndex = 1; this.active.revealed=0; this.renderActive(); this.renderHeatmap(); };
      li.appendChild(btn); el.appendChild(li);
    }
  },

  async renderActive(){
    const surahMeta = this.surahList.find(s=>s.surahIndex===this.active.surahIndex);
    this.elements.surahTitle.textContent = `${surahMeta.surahName} — آية ${this.active.ayaIndex}`;
    this.active.revealed = 0;
    const ayah = await getAyah(this.db, this.active.surahIndex, this.active.ayaIndex);
    if(!ayah) { this.elements.clozeContainer.textContent = 'آية غير موجودة'; return; }
    this.currentAyah = ayah;
    this.words = tokenizeArabic(ayah.text);
    // default revealed words from control
    const init = Number(this.elements.initialWords? this.elements.initialWords.value : 0) || 0;
    this.active.revealed = Math.min(this.words.length, Math.max(0, init));
    this.spawnCloze();
    this.renderHeatmap();
    this.renderSchedules();
    this.startTime = nowSeconds();
  },

  spawnCloze(){
    const container = this.elements.clozeContainer; container.innerHTML = '';
    for(let i=0;i<this.words.length;i++){
      if(i < this.active.revealed){ const span = document.createElement('span'); span.className='quran-text'; span.textContent = this.words[i] + ' '; container.appendChild(span); }
      else if(i === this.active.revealed){
        const input = document.createElement('input'); input.type='text'; input.className='cloze-input quran-text';
        input.setAttribute('aria-label','أكمل الكلمة التالية');
        const target = this.words[i]; input.value=''; input.style.width = Math.max(2,target.length) + 'ch';
        input.addEventListener('input', (e)=> this.onClozeInput(e, i));
        input.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); this.evaluateCurrent(i, true); } });
        container.appendChild(input); const space = document.createElement('span'); space.textContent=' '; container.appendChild(space);
        setTimeout(()=>input.focus(),30);
      } else {
        const placeholder = document.createElement('span'); placeholder.textContent = '_____ '; placeholder.className='text-gray-500'; container.appendChild(placeholder);
      }
    }
  },

  // normalization: remove tashkeel when lenient, remove tatweel and collapse spaces and punctuation
  normalizeForCompare(s){
    let out = s||'';
    out = out.replace(/\u0640/g,''); // tatweel
    out = out.replace(/[.,؛:؛!?،\"'()\[\]{}«»…]/g,'');
    out = out.replace(/\s+/g,' ').trim();
    if(this.elements.tashkeelToggle && this.elements.tashkeelToggle.value === 'lenient') out = stripDiacritics(out);
    return out;
  },

  getToleranceRatio(){ return (Number(this.elements.tolerance?.value || 20) / 100); },

  onClozeInput(e, idx){
    const typed = e.target.value;
    const target = this.words[idx];
    const normTyped = this.normalizeForCompare(typed);
    const normTarget = this.normalizeForCompare(target);
    const d = levenshtein(normTyped, normTarget);
    const ratio = Math.min(1, d / Math.max(1, normTarget.length));
    // live feedback classes
    e.target.classList.remove('minor-typo','major-miss');
    if(d === 0){ e.target.classList.remove('minor-typo','major-miss'); }
    else if(d <= 2) e.target.classList.add('minor-typo');
    else e.target.classList.add('major-miss');
    // immediate acceptance when within tolerance or exact match
    const normLen = Math.max(1, normTarget.length);
    const immediateRatio = Math.min(1, d / normLen);
    const tol = this.getToleranceRatio();
    clearTimeout(this._debounce);
    if(d === 0 || immediateRatio <= tol){
      // immediate evaluation
      this._debounce = null;
      this.evaluateCurrent(idx, true);
    } else {
      // debounce auto-evaluate after 1200ms
      this._debounce = setTimeout(()=> this.evaluateCurrent(idx, false), 1200);
    }
  },

  async evaluateCurrent(idx, force){
    const container = this.elements.clozeContainer;
    const input = container.querySelector('input.cloze-input');
    if(!input) return;
    const typed = input.value.trim(); const target = this.words[idx];
    const normTyped = this.normalizeForCompare(typed); const normTarget = this.normalizeForCompare(target);
    const d = levenshtein(normTyped, normTarget);
    const responseTime = nowSeconds() - (this.startTime||nowSeconds());

    const tol = this.getToleranceRatio();
    const ratio = Math.min(1, d / Math.max(1, normTarget.length));
    if(d === 0 || ratio <= tol){
      // correct
      this.elements.liveFeedback.textContent = 'صحيح ✓';
      const span = document.createElement('span'); span.className='quran-text word-ok'; span.textContent = target + ' ';
      input.replaceWith(span);
      this.active.revealed += 1;
      // SM-2 reward based on similarity
      const errorRate = ratio; const quality = Math.max(0, 5 - Math.round(ratio * 5));
      await this.recordProgress(quality, responseTime, errorRate);
      if(this.active.revealed >= this.words.length){ await this.onAyahComplete(); }
      else { this.spawnCloze(); }
    } else if(force){
      // wrong attempt: apply heatmap/penalty
      const isMinor = ratio <= 0.25;
      input.classList.remove('minor-typo','major-miss'); input.classList.add(isMinor? 'minor-typo':'major-miss');
      const quality = Math.max(0, 5 - Math.round(ratio * 5)); const errorRate = ratio;
      await this.recordProgress(quality, responseTime, errorRate);
      this.elements.liveFeedback.textContent = isMinor? 'طباعة بها أخطاء بسيطة — سجلّنا محاولة' : 'خطأ كبير — سجلّنا عقوبة للمراجعة';
      // keep focus for retry
      input.focus();
    }
  },

  async recordProgress(quality, responseTime, errorRate){
    const id = `s${this.currentAyah.surahIndex}_a${this.currentAyah.ayaIndex}`;
    let prog = await getProgress(this.db, id);
    if(!prog){ prog = {id, surahIndex:this.currentAyah.surahIndex, ayaIndex:this.currentAyah.ayaIndex, attempts:0, errors:0, sm2: new SM2Item(id)}; }
    prog.attempts = (prog.attempts||0) + 1; prog.errors = (prog.errors||0) + (errorRate>0?1:0);
    // revive sm2 if plain
    if(!(prog.sm2 && prog.sm2 instanceof SM2Item)){
      const s = prog.sm2 || {}; const sm = new SM2Item(id); Object.assign(sm, s); prog.sm2 = sm;
    }
    prog.sm2.applyReview(quality, responseTime, errorRate);
    // store serializable
    const toSave = { ...prog, sm2: {id: prog.sm2.id, ef: prog.sm2.ef, interval: prog.sm2.interval, reps: prog.sm2.reps, next: prog.sm2.next, history: prog.sm2.history } };
    await putProgress(this.db, toSave);
    this.renderHeatmap(); this.renderSchedules();
  },

  async onAyahComplete(){
    this.elements.liveFeedback.textContent = 'تم إتمام الآية بنجاح — انتقل آليًا';
    // choose a random surah and aya to continue the game
    if(this.surahList.length === 0) return;
    // pick random surah different from current if possible
    const curSurahIdx = this.surahList.findIndex(s=>s.surahIndex===this.active.surahIndex);
    let randSurahIdx = Math.floor(Math.random() * this.surahList.length);
    if(this.surahList.length > 1 && randSurahIdx === curSurahIdx) randSurahIdx = (randSurahIdx + 1) % this.surahList.length;
    const randSurah = this.surahList[randSurahIdx];
    const randAya = Math.max(1, Math.floor(Math.random() * randSurah.count) + 1);
    this.active.surahIndex = randSurah.surahIndex;
    this.active.ayaIndex = randAya;
    this.active.revealed = 0;
    await this.renderActive();
  },

  updateTimer(){ if(!this.startTime) return this.elements.timer.textContent='0s'; this.elements.timer.textContent = (nowSeconds()-this.startTime) + 's'; },

  async renderHeatmap(){
    // D3 geometric heatmap: circles grid colored by error rate
    const surahIndex = this.active.surahIndex; const heatEl = this.elements.heatmapEl; heatEl.innerHTML = '';
    const meta = this.surahList.find(s=>s.surahIndex===surahIndex); const count = meta?meta.count:0;
    const progressList = await getProgressBySurah(this.db, surahIndex);
    const map = {}; for(const p of progressList) map[p.ayaIndex]=p;

    const svg = d3.select(heatEl).append('svg').attr('class','heat-svg').attr('width','100%').attr('height',260);
    const width = heatEl.clientWidth || 320; const height = 260;
    const cols = Math.max(6, Math.min(12, Math.floor(width / 40)));
    const cellSize = Math.min(36, Math.floor(width / cols) - 6);
    const rows = Math.ceil(count / cols);
    const data = [];
    for(let i=1;i<=count;i++){
      const p = map[i] || {attempts:0, errors:0}; const rate = p.attempts? p.errors / Math.max(1,p.attempts) : 0;
      const col = (i-1) % cols; const row = Math.floor((i-1)/cols);
      data.push({i, rate, attempts: p.attempts||0, errors: p.errors||0, x: col * (cellSize+6) + cellSize/2 + 6, y: row * (cellSize+8) + cellSize/2 + 6});
    }

    const color = d3.scaleLinear().domain([0,1]).range(['#3ddc84','#ff3b30']);

    // tooltip
    let tooltip = heatEl.querySelector('.tooltip');
    if(!tooltip){ tooltip = document.createElement('div'); tooltip.className='tooltip'; heatEl.appendChild(tooltip); }

    const g = svg.append('g').attr('transform','translate(6,6)');
    const nodes = g.selectAll('g').data(data).enter().append('g').attr('transform', d => `translate(${d.x},${d.y})`).style('cursor','pointer');

    nodes.append('circle').attr('r', cellSize/2).attr('fill', d => color(d.rate)).attr('stroke','rgba(255,255,255,0.03)').attr('stroke-width',1)
      .on('mouseover', function(event,d){ tooltip.style.opacity = 1; tooltip.style.left = (event.offsetX+12)+'px'; tooltip.style.top = (event.offsetY+6)+'px'; tooltip.textContent = `آية ${d.i} — خطأ: ${(d.rate*100).toFixed(0)}% • محاولات:${d.attempts}`; })
      .on('mouseout', ()=>{ tooltip.style.opacity = 0; })
      .on('click', (event,d)=>{ this.active.ayaIndex = d.i; this.active.revealed = 0; this.renderActive(); });

    nodes.append('text').text(d=>d.i).attr('y',4).attr('text-anchor','middle').attr('fill','rgba(255,255,255,0.85)').attr('font-size',12);
  },

  async renderSchedules(){
    const list = await new Promise((res,rej)=>{ const req = this.db.transaction('progress').objectStore('progress').getAll(); req.onsuccess=()=>res(req.result||[]); req.onerror=()=>rej(req.error); });
    const lines = list.map(p=> `${p.id} → next:${p.sm2? new Date(p.sm2.next*1000).toLocaleString() : '—'} • ef:${p.sm2? (p.sm2.ef||'') : ''} • attempts:${p.attempts||0}`);
    this.elements.schedulesEl.textContent = lines.join('\n') || 'لا مواعيد';
    this.elements.progressEl.textContent = list.length? `${list.length} آيات تُراجع` : 'لا تقدم';
  }
};

document.addEventListener('DOMContentLoaded', ()=> UI.init());
