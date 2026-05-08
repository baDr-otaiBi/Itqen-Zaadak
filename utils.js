// Hijri calendar conversion and Arabic translations
const MONTHS_HIJRI = ['محرم', 'صفر', 'ربيع الأول', 'ربيع الثاني', 'جمادى الأولى', 'جمادى الآخرة', 'رجب', 'شعبان', 'رمضان', 'شوال', 'ذو القعدة', 'ذو الحجة'];
const DAYS_HIJRI = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

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

// Convert Gregorian to Hijri (simplified but accurate)
function toHijri(date) {
  const jd = Math.floor((date.getTime() / 86400000) + 1948439.5);
  const l = jd + 68569;
  const n = Math.floor((4 * l) / 146097);
  const l2 = l - Math.floor((146097 * n + 3) / 4);
  const i = Math.floor((4000 * (l2 + 1)) / 1461001);
  const l3 = l2 - Math.floor((1461 * i) / 4) + 31;
  const j = Math.floor((80 * l3) / 2447);
  const d = l3 - Math.floor((2447 * j) / 80);
  const l4 = Math.floor(j / 11);
  const m = j + 2 - 12 * l4;
  const y = 100 * (n - 49) + i + l4;
  return { year: y, month: m, day: d };
}

function formatHijri(date) {
  const h = toHijri(date);
  const dayName = DAYS_HIJRI[date.getDay()];
  return `${dayName} ${h.day} ${MONTHS_HIJRI[h.month - 1]} ${h.year}`;
}

// Arabic UI strings
const AR_STRINGS = {
  sources: 'المصادر',
  quran: 'القرآن',
  next_review: 'المراجعة التالية',
  correct: 'صحيح ✓',
  wrong: 'خاطئ',
  correct_answer: 'الإجابة الصحيحة هي:',
  will_review: 'سيتم مراجعة هذه الآية لاحقاً',
  attempts: 'محاولات',
  error_rate: 'معدل الخطأ',
  next_time: 'المراجعة التالية',
  difficulty: 'مستوى الصعوبة',
  understood: 'فهمت، تابع',
  strictness: 'وضع التشكيل',
  strict: 'صارم (تطابق كامل)',
  lenient: 'متساهل (تجاهل الحركات)',
  tolerance: 'التسامح',
  initial_words: 'عدد الكلمات الأولى',
  progress: 'التقدم',
  no_progress: 'لا توجد بيانات بعد',
  tracking: 'آيات تُراجع',
  surah: 'السورة',
  aya: 'الآية',
  vulnerability_map: 'خريطة الضعف',
  click_to_select: 'انقر للاختيار',
  ay: 'ا',
  easy: 'سهل',
  medium: 'متوسط',
  hard: 'صعب'
};

function formatSchedule(id, sm2, attempts) {
  const [_, surah, aya] = id.match(/s(\d+)_a(\d+)/) || [null, '?', '?'];
  const nextDate = sm2 && sm2.next ? new Date(sm2.next * 1000) : null;
  const nextStr = nextDate ? formatHijri(nextDate) : '—';
  const ef = sm2 ? (sm2.ef || 2.5).toFixed(2) : '—';
  return `سورة ${surah} — آية ${aya} • التالي: ${nextStr} • المعامل: ${ef} • محاولات: ${attempts || 0}`;
}
