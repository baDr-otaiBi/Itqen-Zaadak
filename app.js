// Itqin Zaadak — Advanced Cloze engine with sidebar error stats, Hijri, Arabic UI, wrong answer modal

const DB_NAME = 'itqin_zaadak_db';
const DB_VERSION = 1;
const XML_PATH = '/quran-simple.xml';

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

// IndexedDB
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

async function importXMLIfNeeded(db){
  const imported = await getMeta(db,'imported_v1');
  if(imported) return await getMeta(db,'surah_list');
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

// Main App
const UI = {
  db: null,
  surahList: [],
  active: {surahIndex:1, ayaIndex:1, revealed:0},
  elements: {},

  async init(){
    this.elements = {
      surahListEl: document.getElementById('surah-list'),
      surahStatsSummaryEl: document.getElementById('surah-stats-summary'),
      surahStatsListEl: document.getElementById('surah-stats-list'),
      clozeContainer: document.getElementById('cloze-container'),
      surahTitle: document.getElementById('surah-title'),
      liveFeedback: document.getElementById('live-feedback'),
      timer: document.getElementById('timer'),
      tashkeelToggle: document.getElementById('tashkeel-toggle'),
      tolerance: document.getElementById('tolerance'),
      toleranceDisplay: document.getElementById('tolerance-display'),
      initialWords: document.getElementById('initial-words'),
      progressEl: document.getElementById('progress'),
      schedulesEl: document.getElementById('schedules'),
      wrongModal: document.getElementById('wrong-modal'),
      correctAnswerEl: document.getElementById('correct-answer'),
      continueBtn: document.getElementById('continue-btn')
    };
    this.db = await openDB();
    this.surahList = await importXMLIfNeeded(this.db);
    if(!this.surahList || !this.surahList.length) this.surahList = await getMeta(this.db,'surah_list') || [];
    this.renderSurahList();
    this.loadActiveFromURL();
    setInterval(()=>this.updateTimer(),500);
    this.elements.tolerance.addEventListener('input', (e)=>{ this.elements.toleranceDisplay.textContent = e.target.value; });
    this.elements.initialWords.addEventListener('change', ()=>{ this.active.revealed = Math.max(0, Math.min(this.words?this.words.length:0, Number(this.elements.initialWords.value))); this.spawnCloze(); });
    this.elements.continueBtn.addEventListener('click', async ()=>{ 
      this.elements.wrongModal.classList.add('hidden'); 
      await this.onAyahComplete(); 
    });
    this.setFeedback('neutral', 'جاهز — ابدأ الإجابة');
  },

  setFeedback(state, text){
    if(!this.elements.liveFeedback) return;
    this.elements.liveFeedback.classList.remove('is-neutral','is-success','is-error','is-warning','feedback-pill');
    this.elements.liveFeedback.classList.add('feedback-pill', `is-${state}`);
    this.elements.liveFeedback.textContent = text;
  },

  loadActiveFromURL(){
    if(this.surahList.length){ this.active.surahIndex = this.surahList[0].surahIndex; this.active.ayaIndex = 1; this.active.revealed = 0; this.renderActive(); }
  },

  renderSurahList(){
    const el = this.elements.surahListEl; el.innerHTML = '';
    for(const s of this.surahList){
      const li = document.createElement('li');
      const btn = document.createElement('button'); btn.className='surah-item w-full text-right';
      btn.textContent = `${s.surahName} (${s.count})`;
      btn.onclick = ()=>{ this.active.surahIndex = s.surahIndex; this.active.ayaIndex = 1; this.active.revealed=0; this.renderActive(); this.renderSurahStats(); };
      li.appendChild(btn); el.appendChild(li);
    }
  },

  async renderActive(){
    const surahMeta = this.surahList.find(s=>s.surahIndex===this.active.surahIndex);
    this.elements.surahTitle.textContent = `${surahMeta.surahName} — آية ${this.active.ayaIndex}`;
    const ayah = await getAyah(this.db, this.active.surahIndex, this.active.ayaIndex);
    if(!ayah) { this.elements.clozeContainer.textContent = 'آية غير موجودة'; return; }
    this.currentAyah = ayah;
    this.words = tokenizeArabic(ayah.text);
    const init = Number(this.elements.initialWords? this.elements.initialWords.value : 0) || 0;
    this.active.revealed = Math.min(this.words.length, Math.max(0, init));
    this.elements.wrongModal.classList.add('hidden');
    this.setFeedback('neutral', 'جاهز — ابدأ الإجابة');
    this.spawnCloze();
    this.renderSurahStats();
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

  normalizeForCompare(s){
    let out = s||'';
    out = out.replace(/\u0640/g,'');
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
    e.target.classList.remove('minor-typo','major-miss');
    if(d === 0){ e.target.classList.remove('minor-typo','major-miss'); }
    else if(d <= 2) e.target.classList.add('minor-typo');
    else e.target.classList.add('major-miss');
    const normLen = Math.max(1, normTarget.length);
    const immediateRatio = Math.min(1, d / normLen);
    const tol = this.getToleranceRatio();
    clearTimeout(this._debounce);
    if(d === 0 || immediateRatio <= tol){
      this._debounce = null;
      this.evaluateCurrent(idx, true);
    } else {
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
      this.setFeedback('success', 'صحيح ✓');
      const span = document.createElement('span'); span.className='quran-text word-ok'; span.textContent = target + ' ';
      input.replaceWith(span);
      this.active.revealed += 1;
      const errorRate = ratio; const quality = Math.max(0, 5 - Math.round(ratio * 5));
      await this.recordProgress(quality, responseTime, errorRate);
      if(this.active.revealed >= this.words.length){ await this.onAyahComplete(); }
      else { this.spawnCloze(); }
    } else if(force){
      const isMinor = ratio <= 0.25;
      input.classList.remove('minor-typo','major-miss','input-success','input-error','input-warning');
      input.classList.add(isMinor? 'minor-typo':'major-miss', isMinor? 'input-warning':'input-error');
      input.disabled = true;  // تعطيل الـ input حتى يضغط تابع
      clearTimeout(this._debounce);
      this._debounce = null;
      const quality = Math.max(0, 5 - Math.round(ratio * 5)); const errorRate = ratio;
      await this.recordProgress(quality, responseTime, errorRate);
      // show wrong modal with correct answer
      this.elements.correctAnswerEl.textContent = target;
      this.elements.wrongModal.classList.remove('hidden');
      this.setFeedback(isMinor ? 'warning' : 'error', isMinor ? 'قريب لكن يحتاج ضبط — راجع الإجابة الصحيحة' : 'خاطئ — الإجابة الصحيحة معروضة');
    }
  },

  async recordProgress(quality, responseTime, errorRate){
    const id = `s${this.currentAyah.surahIndex}_a${this.currentAyah.ayaIndex}`;
    let prog = await getProgress(this.db, id);
    if(!prog){ prog = {id, surahIndex:this.currentAyah.surahIndex, ayaIndex:this.currentAyah.ayaIndex, attempts:0, errors:0, sm2: new SM2Item(id)}; }
    prog.attempts = (prog.attempts||0) + 1; prog.errors = (prog.errors||0) + (errorRate>0?1:0);
    if(!(prog.sm2 && prog.sm2 instanceof SM2Item)){
      const s = prog.sm2 || {}; const sm = new SM2Item(id); Object.assign(sm, s); prog.sm2 = sm;
    }
    prog.sm2.applyReview(quality, responseTime, errorRate);
    const toSave = { ...prog, sm2: {id: prog.sm2.id, ef: prog.sm2.ef, interval: prog.sm2.interval, reps: prog.sm2.reps, next: prog.sm2.next, history: prog.sm2.history } };
    await putProgress(this.db, toSave);
    this.renderSurahStats(); this.renderSchedules();
  },

  async onAyahComplete(){
    this.setFeedback('success', 'تم إتمام الآية بنجاح — الانتقال...');
    if(this.surahList.length === 0) return;
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

  async renderSurahStats(){
    const summaryEl = this.elements.surahStatsSummaryEl;
    const listEl = this.elements.surahStatsListEl;
    if(!summaryEl || !listEl) return;

    const allProgress = await new Promise((res,rej)=>{
      const req = this.db.transaction('progress').objectStore('progress').getAll();
      req.onsuccess = ()=> res(req.result || []);
      req.onerror = ()=> rej(req.error);
    });

    const bySurah = new Map();
    for(const s of this.surahList) bySurah.set(s.surahIndex, {surahIndex:s.surahIndex, surahName:s.surahName, count:s.count, attempts:0, errors:0});

    for(const item of allProgress){
      const current = bySurah.get(item.surahIndex) || {surahIndex:item.surahIndex, surahName:`سورة ${item.surahIndex}`, count:0, attempts:0, errors:0};
      current.attempts += Number(item.attempts || 0);
      current.errors += Number(item.errors || 0);
      bySurah.set(item.surahIndex, current);
    }

    const rows = [...bySurah.values()]
      .filter(row => row.attempts > 0 || row.errors > 0)
      .map(row => ({
        ...row,
        errorRate: row.attempts ? row.errors / Math.max(1, row.attempts) : 0
      }))
      .sort((a,b)=> (b.errors - a.errors) || (b.errorRate - a.errorRate) || (b.attempts - a.attempts));

    const totalAttempts = rows.reduce((sum, row)=> sum + row.attempts, 0);
    const totalErrors = rows.reduce((sum, row)=> sum + row.errors, 0);
    const mostProblem = rows[0] || null;

    summaryEl.innerHTML = mostProblem
      ? `<div class="stat-card"><div class="text-[11px] text-gray-500 mb-1">ملخص سريع</div><div class="text-sm text-gray-100 leading-6">إجمالي المحاولات: <strong>${totalAttempts}</strong><br>إجمالي الأخطاء: <strong>${totalErrors}</strong><br>الأكثر خطأ: <strong>${mostProblem.surahName}</strong> (${(mostProblem.errorRate * 100).toFixed(0)}%)</div></div>`
      : 'لا توجد بيانات كافية بعد. ابدأ بالمراجعة وستظهر لك السور التي يكثر فيها الخطأ.';

    listEl.innerHTML = '';
    if(!rows.length){
      const empty = document.createElement('div');
      empty.className = 'text-xs text-gray-500 bg-white/5 rounded-xl p-3 border border-white/10';
      empty.textContent = 'لن تظهر الإحصاءات إلا بعد أن تبدأ بكتابة الإجابات وتسجيل المحاولات.';
      listEl.appendChild(empty);
      return;
    }

    const topRows = rows.slice(0, 7);
    const maxErrors = Math.max(1, ...topRows.map(row => row.errors));

    for(const row of topRows){
      const percent = row.attempts ? Math.round((row.errors / Math.max(1, row.attempts)) * 100) : 0;
      const barWidth = Math.max(8, Math.round((row.errors / maxErrors) * 100));
      const item = document.createElement('div');
      item.className = 'stat-card';
      item.innerHTML = `
        <div class="flex items-start justify-between gap-3 mb-2">
          <div>
            <div class="text-sm text-gray-200 font-semibold">${row.surahName}</div>
            <div class="text-[11px] text-gray-500">${row.errors} أخطاء من ${row.attempts} محاولة</div>
          </div>
          <div class="text-xs text-red-300 px-2 py-1 rounded-full bg-red-500/10 border border-red-500/20">${percent}%</div>
        </div>
        <div class="stat-bar">
          <span style="width:${barWidth}%"></span>
        </div>
      `;
      listEl.appendChild(item);
    }
  },

  async renderSchedules(){
    const list = await new Promise((res,rej)=>{ const req = this.db.transaction('progress').objectStore('progress').getAll(); req.onsuccess=()=>res(req.result||[]); req.onerror=()=>rej(req.error); });
    this.elements.schedulesEl.innerHTML = '';
    list.forEach(p=>{
      const div = document.createElement('div');
      div.className = 'text-xs p-2 rounded bg-white/5 border border-white/10 mb-1';
      div.textContent = formatSchedule(p.id, p.sm2, p.attempts);
      this.elements.schedulesEl.appendChild(div);
    });
    this.elements.progressEl.textContent = list.length? `${list.length} آيات تُراجع` : 'لا تقدم مسجل';
  }
};

document.addEventListener('DOMContentLoaded', ()=> UI.init());
