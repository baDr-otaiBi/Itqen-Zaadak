// Itqin Zaadak — Refactored View Controller

const UI = {
    engine: null,
    active: { revealed: 0 },
    elements: {},

    async init() {
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

        const dataManager = new DataManager();
        await dataManager.init();
        this.engine = new CoreEngine(dataManager);
        await this.engine.init();

        this.renderSurahList();
        await this.nextSessionItem();

        setInterval(() => this.updateTimer(), 500);
        this.elements.tolerance.addEventListener('input', (e) => { this.elements.toleranceDisplay.textContent = e.target.value; });
        this.elements.initialWords.addEventListener('change', () => {
            this.active.revealed = Math.max(0, Math.min(this.words ? this.words.length : 0, Number(this.elements.initialWords.value)));
            this.spawnCloze();
        });
        this.elements.continueBtn.addEventListener('click', async () => {
            this.elements.wrongModal.classList.add('hidden');
            await this.nextSessionItem();
        });
        this.setFeedback('neutral', 'جاهز — ابدأ الإجابة');
    },

    setFeedback(state, text) {
        if (!this.elements.liveFeedback) return;
        this.elements.liveFeedback.classList.remove('is-neutral', 'is-success', 'is-error', 'is-warning', 'feedback-pill');
        this.elements.liveFeedback.classList.add('feedback-pill', `is-${state}`);
        this.elements.liveFeedback.textContent = text;
    },

    renderSurahList() {
        const el = this.elements.surahListEl; el.innerHTML = '';
        for (const s of this.engine.surahList) {
            const li = document.createElement('li');
            const btn = document.createElement('button'); btn.className = 'surah-item w-full text-right';
            btn.textContent = `${s.surahName} (${s.count})`;
            btn.onclick = async () => {
                this.currentAyah = await this.engine.dm.getAyah(s.surahIndex, 1);
                this.renderActive();
            };
            li.appendChild(btn); el.appendChild(li);
        }
    },

    async nextSessionItem() {
        const { ayah, reason } = await this.engine.getNextAyah();
        this.currentAyah = ayah;
        this.sessionReason = reason;
        await this.renderActive();
    },

    async renderActive() {
        if (!this.currentAyah) return;

        const mastery = await this.engine.getMasteryLevel(this.currentAyah.id);
        const masteryPct = Math.round(mastery * 100);

        this.elements.surahTitle.innerHTML = `
            <div class="flex justify-between items-end">
                <span>${this.currentAyah.surahName} — آية ${this.currentAyah.ayaIndex}</span>
                <span class="text-xs text-gold/80 font-normal">إتقان الآية: ${masteryPct}%</span>
            </div>
            <span class="block text-[10px] text-gold/60 font-normal mt-1">نمط التدريب: ${this.sessionReason}</span>
        `;

        this.words = tokenizeArabic(this.currentAyah.text);

        // Mastery-Aware difficulty: Higher mastery = fewer initial words revealed
        let init = Number(this.elements.initialWords ? this.elements.initialWords.value : 0) || 0;
        if (mastery > 0.7) init = Math.max(0, init - 1);
        if (mastery > 0.9) init = 0;

        this.active.revealed = Math.min(this.words.length, Math.max(0, init));
        this.elements.wrongModal.classList.add('hidden');
        this.setFeedback('neutral', 'جاهز — ابدأ الإجابة');
        this.spawnCloze();
        this.renderStats();
        this.startTime = Math.floor(Date.now() / 1000);
    },

    spawnCloze() {
        const container = this.elements.clozeContainer; container.innerHTML = '';
        for (let i = 0; i < this.words.length; i++) {
            if (i < this.active.revealed) {
                const span = document.createElement('span'); span.className = 'quran-text'; span.textContent = this.words[i] + ' '; container.appendChild(span);
            }
            else if (i === this.active.revealed) {
                const input = document.createElement('input'); input.type = 'text'; input.className = 'cloze-input quran-text';
                input.setAttribute('aria-label', 'أكمل الكلمة التالية');
                const target = this.words[i]; input.value = ''; input.style.width = Math.max(2, target.length) + 'ch';
                input.addEventListener('input', (e) => this.onClozeInput(e, i));
                input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.evaluateCurrent(i, true); } });
                container.appendChild(input); const space = document.createElement('span'); space.textContent = ' '; container.appendChild(space);
                setTimeout(() => input.focus(), 30);
            } else {
                const placeholder = document.createElement('span'); placeholder.textContent = '_____ '; placeholder.className = 'text-gray-500'; container.appendChild(placeholder);
            }
        }
    },

    normalizeForCompare(s) {
        let out = s || '';
        out = out.replace(/\u0640/g, '');
        out = out.replace(/[.,؛:؛!?،\"'()\[\]{}«»…]/g, '');
        out = out.replace(/\s+/g, ' ').trim();
        if (this.elements.tashkeelToggle && this.elements.tashkeelToggle.value === 'lenient') out = stripDiacritics(out);
        return out;
    },

    getToleranceRatio() { return (Number(this.elements.tolerance?.value || 20) / 100); },

    onClozeInput(e, idx) {
        const typed = e.target.value;
        const target = this.words[idx];
        const normTyped = this.normalizeForCompare(typed);
        const normTarget = this.normalizeForCompare(target);
        const d = levenshtein(normTyped, normTarget);
        const ratio = Math.min(1, d / Math.max(1, normTarget.length));
        e.target.classList.remove('minor-typo', 'major-miss');
        if (d === 0) { e.target.classList.remove('minor-typo', 'major-miss'); }
        else if (d <= 2) e.target.classList.add('minor-typo');
        else e.target.classList.add('major-miss');

        const tol = this.getToleranceRatio();
        clearTimeout(this._debounce);
        if (d === 0 || ratio <= tol) {
            this._debounce = null;
            this.evaluateCurrent(idx, true);
        } else {
            this._debounce = setTimeout(() => this.evaluateCurrent(idx, false), 1200);
        }
    },

    async evaluateCurrent(idx, force) {
        const container = this.elements.clozeContainer;
        const input = container.querySelector('input.cloze-input');
        if (!input) return;
        const typed = input.value.trim(); const target = this.words[idx];
        const normTyped = this.normalizeForCompare(typed); const normTarget = this.normalizeForCompare(target);
        const d = levenshtein(normTyped, normTarget);
        const responseTime = Math.floor(Date.now() / 1000) - (this.startTime || Math.floor(Date.now() / 1000));

        const tol = this.getToleranceRatio();
        const ratio = Math.min(1, d / Math.max(1, normTarget.length));
        if (d === 0 || ratio <= tol) {
            this.setFeedback('success', 'صحيح ✓');
            const span = document.createElement('span'); span.className = 'quran-text word-ok'; span.textContent = target + ' ';
            input.replaceWith(span);
            this.active.revealed += 1;

            const quality = Math.max(0, 5 - Math.round(ratio * 5));
            await this.engine.recordResult(this.currentAyah, quality, responseTime, ratio);

            if (this.active.revealed >= this.words.length) {
                await this.nextSessionItem();
            } else {
                this.spawnCloze();
            }
        } else if (force) {
            const isMinor = ratio <= 0.25;
            input.classList.remove('minor-typo', 'major-miss', 'input-success', 'input-error', 'input-warning');
            input.classList.add(isMinor ? 'minor-typo' : 'major-miss', isMinor ? 'input-warning' : 'input-error');
            input.disabled = true;
            clearTimeout(this._debounce);
            this._debounce = null;

            const quality = Math.max(0, 5 - Math.round(ratio * 5));
            await this.engine.recordResult(this.currentAyah, quality, responseTime, ratio);

            this.elements.correctAnswerEl.textContent = target;
            this.elements.wrongModal.classList.remove('hidden');
            this.setFeedback(isMinor ? 'warning' : 'error', isMinor ? 'قريب لكن يحتاج ضبط — راجع الإجابة الصحيحة' : 'خاطئ — الإجابة الصحيحة معروضة');
        }
    },

    async renderStats() {
        const stats = this.engine.getSurahStats();
        const summaryEl = this.elements.surahStatsSummaryEl;
        const listEl = this.elements.surahStatsListEl;

        const rows = stats
            .filter(row => row.attempts > 0)
            .sort((a, b) => (b.errors - a.errors) || (b.attempts - a.attempts));

        const totalAttempts = rows.reduce((sum, row) => sum + row.attempts, 0);
        const totalErrors = rows.reduce((sum, row) => sum + row.errors, 0);
        const mostProblem = rows[0] || null;

        summaryEl.innerHTML = mostProblem
            ? `<div class="stat-card"><div class="text-[11px] text-gray-500 mb-1">ملخص سريع</div><div class="text-sm text-gray-100 leading-6">إجمالي المحاولات: <strong>${totalAttempts}</strong><br>إجمالي الأخطاء: <strong>${totalErrors}</strong><br>الأكثر خطأ: <strong>${mostProblem.surahName}</strong> (${((mostProblem.errors / mostProblem.attempts) * 100).toFixed(0)}%)</div></div>`
            : 'لا توجد بيانات كافية بعد. ابدأ بالمراجعة وستظهر لك السور التي يكثر فيها الخطأ.';

        listEl.innerHTML = '';
        if (!rows.length) {
            const empty = document.createElement('div');
            empty.className = 'text-xs text-gray-500 bg-white/5 rounded-xl p-3 border border-white/10';
            empty.textContent = 'لن تظهر الإحصاءات إلا بعد أن تبدأ بكتابة الإجابات وتسجيل المحاولات.';
            listEl.appendChild(empty);
        } else {
            const topRows = rows.slice(0, 7);
            const maxErrors = Math.max(1, ...topRows.map(row => row.errors));
            for (const row of topRows) {
                const percent = Math.round((row.errors / row.attempts) * 100);
                const masteryPct = Math.round(row.mastery * 100);
                const barWidth = Math.max(8, Math.round((row.errors / maxErrors) * 100));
                const item = document.createElement('div');
                item.className = 'stat-card';
                item.innerHTML = `
                    <div class="flex items-start justify-between gap-3 mb-2">
                      <div>
                        <div class="text-sm text-gray-200 font-semibold">${row.surahName}</div>
                        <div class="text-[11px] text-gray-500">${row.errors} أخطاء — إتقان: ${masteryPct}%</div>
                      </div>
                      <div class="text-xs text-red-300 px-2 py-1 rounded-full bg-red-500/10 border border-red-500/20">${percent}%</div>
                    </div>
                    <div class="stat-bar">
                      <span style="width:${barWidth}%"></span>
                    </div>
                `;
                listEl.appendChild(item);
            }
        }

        const allProgress = await this.engine.dm.getAllProgress();
        this.elements.schedulesEl.innerHTML = '';
        allProgress.forEach(p => {
            const div = document.createElement('div');
            div.className = 'text-xs p-2 rounded bg-white/5 border border-white/10 mb-1';
            div.textContent = formatSchedule(p.id, p.sm2, p.attempts);
            this.elements.schedulesEl.appendChild(div);
        });
        this.elements.progressEl.textContent = allProgress.length ? `${allProgress.length} آيات تُراجع` : 'لا تقدم مسجل';
    },

    updateTimer() {
        if (!this.startTime) return this.elements.timer.textContent = '0s';
        this.elements.timer.textContent = (Math.floor(Date.now() / 1000) - this.startTime) + 's';
    }
};

document.addEventListener('DOMContentLoaded', () => UI.init());
