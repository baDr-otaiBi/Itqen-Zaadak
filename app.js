// Minimal modular app for Itqin Zaadak — ruthless, data-driven
const STORAGE_KEY = 'itqin_zaadak_v1';

// Demo corpus (expandable). Structure: {surah, verses: [text...]}
const CORPUS = [
  {id:1, name:'الفاتحة', verses:[
    'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ',
    'الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ',
    'الرَّحْمَٰنِ الرَّحِيمِ',
    'مَالِكِ يَوْمِ الدِّينِ',
  ]},
  {id:2, name:'الإخلاص', verses:[
    'قُلْ هُوَ اللَّهُ أَحَدٌ',
    'اللَّهُ الصَّمَدُ',
    'لَمْ يَلِدْ وَلَمْ يُولَدْ',
    'وَلَمْ يَكُن لَّهُ كُفُوًا أَحَدٌ'
  ]},
  {id:3, name:'قُرْآن (مثال تشابه)', verses:[
    'الرَّحْمَٰنُ',
    'الرَّحِيمُ',
    'مَثَلُ النَّفْسِ',
  ]}
];

// Utilities
function nowSeconds(){return Math.floor(Date.now()/1000)}

// Arabic diacritics removal
const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED]/g;
function stripDiacritics(s){return s.replace(ARABIC_DIACRITICS,'').replace(/\s+/g,' ').trim()}

// Tokenize words conservatively
function tokenizeArabic(s){ return s.split(/\s+/).filter(Boolean); }

// Levenshtein distance (word-level or char-level). Returns integer distance.
function levenshtein(a,b){
  if(a===b) return 0;
  a = a||''; b = b||'';
  const m=a.length, n=b.length;
  const dp = Array.from({length:m+1},(_,i)=>Array(n+1).fill(0));
  for(let i=0;i<=m;i++) dp[i][0]=i;
  for(let j=0;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++){
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
}

// Detect if a word exists in other verses (Mutashabihat similarity)
function existsInOtherVerses(word, surahId, verseIndex){
  for(const s of CORPUS){
    for(const [i,v] of s.verses.entries()){
      if(s.id===surahId && i===verseIndex) continue;
      const words = tokenizeArabic(stripDiacritics(v));
      for(const w of words){ if(w === stripDiacritics(word)) return {surah:s.name, verseIndex:i}; }
    }
  }
  return null;
}

// Classification of a typed word vs expected
function classifyWord(expected, typed, surahId, verseIndex){
  const expectedRaw = expected || '';
  const typedRaw = typed || '';
  const expNoDiac = stripDiacritics(expectedRaw);
  const typedNoDiac = stripDiacritics(typedRaw);

  if(expNoDiac === typedNoDiac){
    // difference only in diacritics or minor punctuation
    const dist = levenshtein(expectedRaw, typedRaw);
    if(dist === 0) return {type:'ok'};
    return {type:'tashkeel', dist};
  }

  // If Levenshtein small on normalized forms -> typo
  const ld = levenshtein(expNoDiac, typedNoDiac);
  if(ld <= Math.max(1, Math.floor(expNoDiac.length * 0.25))) return {type:'typo', dist:ld};

  // Similarity across corpus
  const conflict = existsInOtherVerses(typed, surahId, verseIndex);
  if(conflict) return {type:'similarity', conflict};

  return {type:'wrong'};
}

// SM-2 implementation with explicit math
class SM2Item{
  constructor(id){
    this.id = id; // unique ayah id string
    this.ef = 2.5; this.interval=0; this.reps=0; this.next = 0; // next as epoch day
    this.history = [];
  }

  // rate: quality 0-5, responseTime in seconds, errorRate 0..1
  applyReview(quality, responseTime, errorRate){
    // modify quality using errorRate and responseTime (not simple boolean)
    const timePenalty = Math.min(1.5, Math.max(0, (responseTime - 8)/15));
    const errorPenalty = Math.min(1, errorRate*2); // errorRate 0..1
    const adjusted = Math.max(0, Math.min(5, quality - errorPenalty - timePenalty));

    if(adjusted < 3){ this.reps = 0; this.interval = 1; }
    else{
      if(this.reps === 0) this.interval = 1;
      else if(this.reps === 1) this.interval = 6;
      else this.interval = Math.round(this.interval * this.ef);
      this.reps += 1;
    }

    // update easiness factor using original SM-2 formula
    this.ef = this.ef + (0.1 - (5 - adjusted) * (0.08 + (5 - adjusted) * 0.02));
    if(this.ef < 1.3) this.ef = 1.3;

    const days = this.interval;
    const today = new Date();
    const nextDate = new Date(today.getTime() + days * 24*3600*1000);
    this.next = Math.floor(nextDate.getTime()/1000);
    this.history.push({t:nowSeconds(), quality:adjusted, responseTime, errorRate, next:this.next});
  }
}

// Persistence (LocalStorage wrapper) — stores per-ayah SM2 and stats
const Storage = {
  load(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw? JSON.parse(raw) : {items:{}, stats:{}};
    }catch(e){return {items:{}, stats:{}}}
  },
  save(state){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
};

// App state
const App = {
  state: Storage.load(),
  active: {surahId: CORPUS[0].id, verseIndex:0},
  startTime: null,
  init(){
    this.initUI();
    this.renderSurahList();
    this.loadActive();
  },

  initUI(){
    this.surahTitle = document.getElementById('surah-title');
    this.ayahDisplay = document.getElementById('ayah-display');
    this.typing = document.getElementById('typing-area');
    this.inline = document.getElementById('inline-feedback');
    this.live = document.getElementById('live-feedback');
    this.timer = document.getElementById('timer');
    this.heatmap = document.getElementById('heatmap');
    this.surahListEl = document.getElementById('surah-list');
    this.progressEl = document.getElementById('progress');
    this.schedulesEl = document.getElementById('schedules');

    this.typing.addEventListener('input', (e)=>this.onType(e));
    this.typing.addEventListener('focus', ()=>{ this.startTime = nowSeconds(); });
    setInterval(()=>this.updateTimer(), 500);
  },

  loadActive(){
    this.renderActive();
    this.renderHeatmap();
    this.renderSchedules();
  },

  renderSurahList(){
    this.surahListEl.innerHTML = '';
    for(const s of CORPUS){
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'text-sm w-full text-right p-2 rounded hover:bg-gray-700';
      btn.textContent = s.name + ' (' + s.verses.length + ')';
      btn.onclick = ()=>{ this.active.surahId = s.id; this.active.verseIndex = 0; this.renderActive(); this.renderHeatmap(); };
      li.appendChild(btn); this.surahListEl.appendChild(li);
    }
  },

  renderActive(){
    const surah = CORPUS.find(s=>s.id===this.active.surahId);
    const ayah = surah.verses[this.active.verseIndex];
    this.surahTitle.textContent = `${surah.name} — آية ${this.active.verseIndex+1}`;
    this.ayahDisplay.innerHTML = `<span class="quran-text">${ayah}</span>`;
    this.typing.value = '';
    this.inline.innerHTML = '';
    this.live.textContent = 'ابدأ الكتابة — التقييم آني';
    this.startTime = nowSeconds();
  },

  updateTimer(){
    if(!this.startTime) return this.timer.textContent = '0s';
    const s = nowSeconds() - this.startTime; this.timer.textContent = s + 's';
  },

  onType(e){
    const surah = CORPUS.find(s=>s.id===this.active.surahId);
    const expected = surah.verses[this.active.verseIndex];
    const typed = e.target.value;

    // Live token-level compare
    const expectedWords = tokenizeArabic(expected);
    const typedWords = tokenizeArabic(typed);

    // build inline feedback spans preserving words positions
    const fragments = [];
    for(let i=0;i<expectedWords.length;i++){
      const expW = expectedWords[i] || '';
      const typedW = typedWords[i] || '';
      const cls = classifyWord(expW, typedW, this.active.surahId, this.active.verseIndex);
      let span = document.createElement('span');
      span.textContent = expW + ' ';
      if(!typedW){ span.className = ''; }
      else if(cls.type === 'ok'){ span.className = 'word-ok'; }
      else if(cls.type === 'tashkeel'){ span.className = 'word-typo'; }
      else if(cls.type === 'typo'){ span.className = 'word-typo'; }
      else if(cls.type === 'similarity'){ span.className = 'word-sim'; }
      else span.className = 'word-wrong';
      fragments.push(span);
    }

    this.inline.innerHTML = '';
    for(const f of fragments) this.inline.appendChild(f);

    // If user typed full verse (naive: typed words >= expected words), register a review
    if(typedWords.length >= expectedWords.length){
      // compute errorRate and response time
      let errors = 0; let total = expectedWords.length;
      for(let i=0;i<expectedWords.length;i++){
        const cls = classifyWord(expectedWords[i], typedWords[i]||'', this.active.surahId, this.active.verseIndex);
        if(cls.type !== 'ok') errors++;
      }
      const errorRate = errors/Math.max(1,total);
      const responseTime = nowSeconds() - this.startTime;

      // Quality estimation (0..5): inverse of error and speed
      const rawQuality = Math.max(0, 5 - Math.round(errorRate * 5));

      // Apply to SM2 item
      const ayahKey = `s${this.active.surahId}_v${this.active.verseIndex}`;
      if(!this.state.items[ayahKey]) this.state.items[ayahKey] = new SM2Item(ayahKey);
      // if object came from storage, revive prototype
      if(!(this.state.items[ayahKey] instanceof SM2Item)){
        const data = this.state.items[ayahKey];
        const item = new SM2Item(ayahKey);
        Object.assign(item, data);
        this.state.items[ayahKey] = item;
      }
      this.state.items[ayahKey].applyReview(rawQuality, responseTime, errorRate);

      // Stats
      if(!this.state.stats[ayahKey]) this.state.stats[ayahKey] = {attempts:0, errors:0};
      this.state.stats[ayahKey].attempts += 1; this.state.stats[ayahKey].errors += errors;
      Storage.save(this.state);

      // Update UI
      this.live.textContent = `تم التقييم — أخطاء: ${errors}/${total} — جودة≈${rawQuality}`;
      this.renderHeatmap();
      this.renderSchedules();

      // If there are errors, force review: keep same ayah. If perfect, advance.
      if(errorRate === 0){
        this.advance();
      } else {
        // highlight vulnerability and keep focus
        this.typing.select();
      }
    }
  },

  advance(){
    const surah = CORPUS.find(s=>s.id===this.active.surahId);
    if(this.active.verseIndex < surah.verses.length -1){
      this.active.verseIndex += 1; this.renderActive();
    } else {
      // find next surah
      const idx = CORPUS.findIndex(s=>s.id===this.active.surahId);
      const next = CORPUS[(idx+1)%CORPUS.length];
      this.active.surahId = next.id; this.active.verseIndex = 0; this.renderActive();
    }
  },

  renderHeatmap(){
    const surah = CORPUS.find(s=>s.id===this.active.surahId);
    this.heatmap.innerHTML = '';
    for(const [i,v] of surah.verses.entries()){
      const key = `s${surah.id}_v${i}`;
      const stats = this.state.stats[key] || {attempts:0, errors:0};
      const rate = stats.attempts? stats.errors / (stats.attempts * v.split(/\s+/).length) : 0;
      const tile = document.createElement('div');
      tile.className = 'heat-tile p-2 text-xs text-gray-200 flex justify-between';
      tile.textContent = `آية ${i+1}`;
      if(rate > 0.4) tile.classList.add('heat-glow');
      // color intensity
      const r = Math.min(1, rate*2);
      tile.style.background = `linear-gradient(90deg, rgba(61,220,132,${1-r}) 0%, rgba(255,59,48,${r}) 100%)`;
      tile.onclick = ()=>{ this.active.verseIndex = i; this.renderActive(); };
      this.heatmap.appendChild(tile);
    }
  },

  renderSchedules(){
    this.schedulesEl.innerHTML = '';
    const lines = [];
    for(const k in this.state.items){
      const item = this.state.items[k];
      const when = item.next? new Date(item.next*1000).toLocaleString() : 'غير محدد';
      lines.push(`${k} → next: ${when} • ef:${item.ef.toFixed(2)} • int:${item.interval}`);
    }
    this.schedulesEl.textContent = lines.join('\n') || 'لا مواعيد';
    this.progressEl.textContent = Object.keys(this.state.stats).length? `${Object.keys(this.state.stats).length} آيات مُتابعة` : 'لا تقدم مسجل';
  }
};

// Boot
document.addEventListener('DOMContentLoaded', ()=> App.init());
