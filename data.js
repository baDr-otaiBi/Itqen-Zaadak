/**
 * DataManager handles all persistence and external data fetching (XML).
 * It provides a clean API for the CoreEngine to interact with data.
 */
class DataManager {
    constructor() {
        this.DB_NAME = 'itqin_zaadak_db';
        this.DB_VERSION = 1;
        this.XML_PATH = '/quran-simple.xml';
        this.db = null;
    }

    async init() {
        this.db = await this._openDB();
    }

    _openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
            req.onupgradeneeded = (ev) => {
                const db = ev.target.result;
                if (!db.objectStoreNames.contains('ayah')) {
                    const s = db.createObjectStore('ayah', { keyPath: 'id' });
                    s.createIndex('surah', 'surahIndex', { unique: false });
                }
                if (!db.objectStoreNames.contains('progress')) {
                    const p = db.createObjectStore('progress', { keyPath: 'id' });
                    p.createIndex('surah', 'surahIndex', { unique: false });
                }
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'k' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async getMeta(key) {
        return new Promise((res, rej) => {
            const tx = this.db.transaction('meta').objectStore('meta').get(key);
            tx.onsuccess = () => res(tx.result ? tx.result.v : null);
            tx.onerror = () => rej(tx.error);
        });
    }

    async putMeta(key, value) {
        return new Promise((res, rej) => {
            const tx = this.db.transaction('meta', 'readwrite').objectStore('meta').put({ k: key, v: value });
            tx.onsuccess = () => res();
            tx.onerror = () => rej(tx.error);
        });
    }

    async putAyah(ayah) {
        return new Promise((res, rej) => {
            const tx = this.db.transaction('ayah', 'readwrite').objectStore('ayah').put(ayah);
            tx.onsuccess = () => res();
            tx.onerror = () => rej(tx.error);
        });
    }

    async getAyah(surahIndex, ayaIndex) {
        const id = `s${surahIndex}_a${ayaIndex}`;
        return new Promise((res, rej) => {
            const tx = this.db.transaction('ayah').objectStore('ayah').get(id);
            tx.onsuccess = () => res(tx.result);
            tx.onerror = () => rej(tx.error);
        });
    }

    async getAyahById(id) {
        return new Promise((res, rej) => {
            const tx = this.db.transaction('ayah').objectStore('ayah').get(id);
            tx.onsuccess = () => res(tx.result);
            tx.onerror = () => rej(tx.error);
        });
    }

    async putProgress(progress) {
        return new Promise((res, rej) => {
            const tx = this.db.transaction('progress', 'readwrite').objectStore('progress').put(progress);
            tx.onsuccess = () => res();
            tx.onerror = () => rej(tx.error);
        });
    }

    async getProgress(id) {
        return new Promise((res, rej) => {
            const tx = this.db.transaction('progress').objectStore('progress').get(id);
            tx.onsuccess = () => res(tx.result);
            tx.onerror = () => rej(tx.error);
        });
    }

    async getAllProgress() {
        return new Promise((res, rej) => {
            const req = this.db.transaction('progress').objectStore('progress').getAll();
            req.onsuccess = () => res(req.result || []);
            req.onerror = () => rej(req.error);
        });
    }

    async getProgressBySurah(surahIndex) {
        return new Promise((res, rej) => {
            const store = this.db.transaction('progress').objectStore('progress');
            const idx = store.index('surah');
            const req = idx.getAll(IDBKeyRange.only(surahIndex));
            req.onsuccess = () => res(req.result || []);
            req.onerror = () => rej(req.error);
        });
    }

    async importXML() {
        const imported = await this.getMeta('imported_v1');
        if (imported) return await this.getMeta('surah_list');

        const resp = await fetch(this.XML_PATH);
        if (!resp.ok) throw new Error('Failed to fetch XML');
        const text = await resp.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'application/xml');
        const suras = Array.from(doc.querySelectorAll('sura'));
        const surahList = [];

        // Use a transaction for bulk put
        const txAyah = this.db.transaction('ayah', 'readwrite');
        const storeAyah = txAyah.objectStore('ayah');

        for (const s of suras) {
            const surahIndex = Number(s.getAttribute('index'));
            const surahName = s.getAttribute('name') || '';
            const ayat = Array.from(s.querySelectorAll('aya'));
            for (const a of ayat) {
                const ayaIndex = Number(a.getAttribute('index'));
                const ayaText = a.getAttribute('text') || a.textContent || '';
                const id = `s${surahIndex}_a${ayaIndex}`;
                storeAyah.put({ id, surahIndex, surahName, ayaIndex, text: ayaText });
            }
            surahList.push({ surahIndex, surahName, count: ayat.length });
        }

        await this.putMeta('surah_list', surahList);
        await this.putMeta('imported_v1', true);
        return surahList;
    }
}
