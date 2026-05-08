/**
 * CoreEngine manages the application state, analytics, and the adaptive learning algorithm.
 */
class CoreEngine {
    constructor(dataManager) {
        this.dm = dataManager;
        this.surahList = [];
        this.currentAyah = null;
        this.sessionStats = {
            totalAttempts: 0,
            totalErrors: 0,
            surahStats: new Map()
        };
        this.masteryThreshold = 0.4; // 40% error rate triggers force-bridge
    }

    async init() {
        this.surahList = await this.dm.importXML();
        await this.refreshAnalytics();
    }

    async refreshAnalytics() {
        const allProgress = await this.dm.getAllProgress();
        const bySurah = new Map();

        // Initialize with all surahs
        for (const s of this.surahList) {
            bySurah.set(s.surahIndex, {
                surahIndex: s.surahIndex,
                surahName: s.surahName,
                count: s.count,
                attempts: 0,
                errors: 0,
                mastery: 1.0 // 1.0 = perfect, 0.0 = failing
            });
        }

        for (const item of allProgress) {
            const current = bySurah.get(item.surahIndex);
            if (current) {
                current.attempts += (item.attempts || 0);
                current.errors += (item.errors || 0);

                // Calculate weighted mastery: recent performance matters more
                const history = item.sm2 ? item.sm2.history : [];
                let mastery = 1.0;
                if (history.length > 0) {
                    const recent = history.slice(-5);
                    const avgQuality = recent.reduce((sum, h) => sum + h.quality, 0) / recent.length;
                    mastery = avgQuality / 5;
                } else if (item.attempts > 0) {
                    mastery = Math.max(0, 1 - (item.errors / item.attempts));
                }

                // Aggregate mastery at Surah level
                if (!current.masteryScores) current.masteryScores = [];
                current.masteryScores.push(mastery);
            }
        }

        for (const s of bySurah.values()) {
            if (s.masteryScores && s.masteryScores.length > 0) {
                s.mastery = s.masteryScores.reduce((a, b) => a + b, 0) / s.masteryScores.length;
                // If many verses are not yet attempted, decrease total mastery
                const coverage = s.masteryScores.length / s.count;
                s.mastery = (s.mastery * coverage);
            } else {
                s.mastery = 0;
            }
        }
        this.surahStats = bySurah;
        return bySurah;
    }

    /**
     * The heart of the Adaptive Learning Path.
     * Decides which Ayah the user should tackle next based on weighted priorities.
     */
    async getNextAyah() {
        const allProgress = await this.dm.getAllProgress();
        const now = Math.floor(Date.now() / 1000);

        let reason = "عشوائي"; // Default reason

        // 1. HIGH PRIORITY: Force-bridge struggling surahs
        // If a surah has >40% error rate, we MUST fix it before moving to new content.
        const strugglingSurahs = Array.from(this.surahStats.values())
            .filter(s => s.attempts >= 3 && (s.errors / s.attempts) >= this.masteryThreshold)
            .sort((a, b) => (b.errors / b.attempts) - (a.errors / a.attempts));

        if (strugglingSurahs.length > 0) {
            const targetSurah = strugglingSurahs[0];
            reason = `تحسين إتقان: ${targetSurah.surahName}`;

            const surahProgress = allProgress.filter(p => p.surahIndex === targetSurah.surahIndex);
            // Prioritize verses in this surah that are due or have errors
            const candidates = surahProgress.filter(p => (p.sm2 && p.sm2.next <= now) || p.errors > 0);

            if (candidates.length > 0) {
                const pick = candidates[Math.floor(Math.random() * candidates.length)];
                const ayah = await this.dm.getAyahById(pick.id);
                return { ayah, reason };
            } else {
                // Pick a random un-attempted or least-mastered verse from this surah
                const attemptedAyaIndices = new Set(surahProgress.map(p => p.ayaIndex));
                for(let i=1; i<=targetSurah.count; i++) {
                    if (!attemptedAyaIndices.has(i)) {
                        const ayah = await this.dm.getAyah(targetSurah.surahIndex, i);
                        return { ayah, reason };
                    }
                }
                // If all attempted, pick random
                const randAyaIndex = Math.floor(Math.random() * targetSurah.count) + 1;
                const ayah = await this.dm.getAyah(targetSurah.surahIndex, randAyaIndex);
                return { ayah, reason };
            }
        }

        // 2. Scheduled Reviews (SM2)
        const overdue = allProgress.filter(p => p.sm2 && p.sm2.next <= now);
        if (overdue.length > 0) {
            reason = "مراجعة دورية";
            const pick = overdue.sort((a, b) => a.sm2.next - b.sm2.next)[0];
            const ayah = await this.dm.getAyahById(pick.id);
            return { ayah, reason };
        }

        // 3. High-error individual verses
        const buggyVerses = allProgress
            .filter(p => p.attempts >= 2 && (p.errors / p.attempts) > 0.25)
            .sort((a, b) => (b.errors / b.attempts) - (a.errors / a.attempts));

        if (buggyVerses.length > 0 && Math.random() > 0.4) {
            reason = "تثبيت موضع خطأ";
            const pick = buggyVerses[0];
            const ayah = await this.dm.getAyahById(pick.id);
            return { ayah, reason };
        }

        // 4. New content
        reason = "تعلم جديد";
        const attemptedIds = new Set(allProgress.map(p => p.id));
        // Find first surah that isn't fully mastered/attempted
        for(const surah of this.surahList) {
            const surahProg = allProgress.filter(p => p.surahIndex === surah.surahIndex);
            if (surahProg.length < surah.count) {
                // Find first unattempted verse
                const attemptedIndices = new Set(surahProg.map(p => p.ayaIndex));
                for(let i=1; i<=surah.count; i++) {
                    if (!attemptedIndices.has(i)) {
                        const ayah = await this.dm.getAyah(surah.surahIndex, i);
                        return { ayah, reason };
                    }
                }
            }
        }

        // Fallback
        const surah = this.surahList[Math.floor(Math.random() * this.surahList.length)];
        const ayaIndex = Math.floor(Math.random() * surah.count) + 1;
        const ayah = await this.dm.getAyah(surah.surahIndex, ayaIndex);
        return { ayah, reason: "استكشاف عشوائي" };
    }

    async recordResult(ayah, quality, responseTime, errorRate) {
        const id = ayah.id;
        let prog = await this.dm.getProgress(id);

        if (!prog) {
            prog = {
                id,
                surahIndex: ayah.surahIndex,
                ayaIndex: ayah.ayaIndex,
                attempts: 0,
                errors: 0,
                sm2: { ef: 2.5, interval: 0, reps: 0, next: 0, history: [] }
            };
        }

        prog.attempts++;
        if (errorRate > 0) prog.errors++;

        // Apply SM2 Logic
        const sm2 = this._applySM2(prog.sm2, quality, responseTime, errorRate);
        prog.sm2 = sm2;

        await this.dm.putProgress(prog);
        await this.refreshAnalytics();
        return prog;
    }

    _applySM2(item, quality, responseTime, errorRate) {
        // SM2 Logic adapted from app.js but refined
        const timePenalty = Math.min(1.5, Math.max(0, (responseTime - 8) / 15));
        const errorPenalty = Math.min(1, errorRate * 2);
        const adjusted = Math.max(0, Math.min(5, quality - errorPenalty - timePenalty));

        let { ef, interval, reps, history } = item;

        if (adjusted < 3) {
            reps = 0;
            interval = 1;
        } else {
            if (reps === 0) interval = 1;
            else if (reps === 1) interval = 6;
            else interval = Math.round(interval * ef);
            reps += 1;
        }

        ef = ef + (0.1 - (5 - adjusted) * (0.08 + (5 - adjusted) * 0.02));
        if (ef < 1.3) ef = 1.3;

        const nextDate = new Date(Date.now() + interval * 24 * 3600 * 1000);
        const next = Math.floor(nextDate.getTime() / 1000);

        history.push({
            t: Math.floor(Date.now() / 1000),
            quality: adjusted,
            responseTime,
            errorRate,
            next
        });

        return { ef, interval, reps, next, history };
    }

    getSurahStats() {
        return Array.from(this.surahStats.values());
    }

    async getMasteryLevel(id) {
        const prog = await this.dm.getProgress(id);
        if (!prog || !prog.sm2 || !prog.sm2.history.length) return 0;
        const recent = prog.sm2.history.slice(-3);
        const avg = recent.reduce((sum, h) => sum + h.quality, 0) / recent.length;
        return avg / 5; // 0.0 to 1.0
    }
}
