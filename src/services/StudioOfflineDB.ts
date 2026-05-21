/**
 * StudioOfflineDB.ts — Stockage persistant Studio Mobile iPhone v2
 *
 * CORRECTIFS v2 :
 * - getAudio() : type par défaut 'audio/mp4' au lieu de 'audio/webm' (iOS)
 * - deleteAllForSong() : nettoyer tous les audios d'une chanson
 * - getStorageEstimate() : quota IndexedDB iOS (~50MB par origine)
 * - init() robuste avec retry si la DB est bloquée (Safari iOS tue parfois la connexion)
 * - tx() protégée : relance getDB() si this.db est null (après kill Safari)
 */

const DB_NAME    = 'CashCountryStudio';
const DB_VERSION = 1;

const STORE_SONGS = 'songs';
const STORE_AUDIO = 'audio';
const STORE_STATE = 'state';

// Détecter iOS pour le type MIME par défaut
function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

class StudioOfflineDatabase {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  // Queue d'écriture séquentielle — évite les transactions readwrite simultanées sur iOS
  private writeQueue: Promise<any> = Promise.resolve();

  private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(() => fn()).catch(e => { throw e; });
    // La queue continue même si une opération échoue
    this.writeQueue = next.catch(() => {});
    return next;
  }

  static async requestPersistence(): Promise<void> {
    try {
      if (navigator.storage && navigator.storage.persist) {
        const granted = await navigator.storage.persist();
        console.log('[DB] Stockage persistant:', granted ? '✅ accordé' : '⚠️ quota limité');
      }
    } catch(e) { console.warn('[DB] persist() erreur:', e); }
  }

  async init(): Promise<void> {
    if (this.db) return;
    StudioOfflineDatabase.requestPersistence().catch(() => {});
    // Éviter les initialisations parallèles
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_SONGS)) {
          db.createObjectStore(STORE_SONGS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_AUDIO)) {
          const audioStore = db.createObjectStore(STORE_AUDIO, { keyPath: 'key' });
          // Index par songId pour faciliter la suppression par chanson
          audioStore.createIndex('songId', 'songId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_STATE)) {
          db.createObjectStore(STORE_STATE, { keyPath: 'key' });
        }
      };

      req.onsuccess = () => {
        this.db = req.result;
        // Gérer la déconnexion de la DB (iOS peut tuer la connexion)
        this.db.onclose = () => { this.db = null; this.initPromise = null; };
        this.db.onerror = (e) => console.warn('[StudioDB] Erreur DB:', e);
        resolve();
      };

      req.onerror = () => {
        this.initPromise = null;
        reject(req.error);
      };

      req.onblocked = () => {
        // Une autre connexion bloque l'upgrade — fermer les anciennes
        console.warn('[StudioDB] DB bloquée — attente...');
      };
    });

    return this.initPromise;
  }

  private async getDB(): Promise<IDBDatabase> {
    if (!this.db) await this.init();
    if (!this.db) throw new Error('[StudioDB] DB non disponible après init');
    return this.db;
  }

  private async tx(store: string, mode: IDBTransactionMode = 'readonly') {
    const db = await this.getDB();
    return db.transaction([store], mode).objectStore(store);
  }

  // getAudio avec retry complet de la transaction (iOS peut tuer la connexion mid-op)
  async getAudio(key: string): Promise<Blob | null> {
    const attempt = async (): Promise<Blob | null> => {
      const store = await this.tx(STORE_AUDIO);
      const rec   = await this.idbOp(store.get(key));
      if (!rec) return null;
      if (!rec.buffer || rec.buffer.byteLength === 0) {
        console.error(`[DB] ❌ getAudio(${key}) buffer vide — entrée corrompue`);
        return null;
      }
      // Retourner le type ORIGINAL stocké — fixBlobType dans useStudioAudio décide
      const storedType = rec.type || 'audio/flac';
      return new Blob([rec.buffer], { type: storedType });
    };

    try {
      return await attempt();
    } catch (e) {
      // Retry après reset de la connexion DB
      console.warn(`[DB] getAudio(${key}) échoué, retry...`, e);
      this.db = null;
      this.initPromise = null;
      await new Promise(r => setTimeout(r, 200));
      try {
        return await attempt();
      } catch (e2) {
        console.error(`[DB] getAudio(${key}) échec définitif:`, e2);
        return null;
      }
    }
  }

  private idbOp<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
  }

  // ── Chansons ──────────────────────────────────────────────────────────────

  async saveSongs(songs: any[]): Promise<void> {
    // Éviter d'écraser si le même nombre de chansons est déjà en DB
    // (évite 7-8 clear()+put() simultanés quand on cache plusieurs chansons)
    try {
      const existing = await this.idbOp((await this.tx(STORE_SONGS)).count());
      if (existing === songs.length) return; // déjà à jour
    } catch {}
    const store = await this.tx(STORE_SONGS, 'readwrite');
    await this.idbOp(store.clear());
    // Écrire en séquence (pas en parallèle) pour éviter les conflits iOS
    for (const s of songs) {
      await this.idbOp(store.put(s));
    }
  }

  async getAllSongs(): Promise<any[]> {
    const store = await this.tx(STORE_SONGS);
    return this.idbOp(store.getAll());
  }

  // ── Audio ─────────────────────────────────────────────────────────────────

  async saveAudio(key: string, blob: Blob, meta: object = {}): Promise<void> {
    return this.enqueueWrite(() => this._saveAudioImpl(key, blob, meta));
  }

  private async _saveAudioImpl(key: string, blob: Blob, meta: object = {}): Promise<void> {
    // Vérifier l'espace disponible AVANT d'écrire pour un feedback immédiat
    try {
      const est = await this.getStorageEstimate();
      const needed = blob.size;
      const available = est.quota - est.used;
      if (available < needed + 2 * 1024 * 1024) {
        // Moins de 2 Mo de marge → erreur claire avec détails
        const usedMB  = (est.used  / (1024 * 1024)).toFixed(1);
        const quotaMB = (est.quota / (1024 * 1024)).toFixed(1);
        const needMB  = (needed    / (1024 * 1024)).toFixed(1);
        // Tenter de libérer de l'espace en supprimant les anciens enregistrements
        try { await this.freeSpaceForSize(needed); } catch {}
        // Revérifier après nettoyage
        const est2 = await this.getStorageEstimate();
        if (est2.quota - est2.used < needed + 2 * 1024 * 1024) {
          throw new DOMException(
          `QUOTA_FULL: utilisé ${usedMB} Mo / ${quotaMB} Mo, besoin ${needMB} Mo — supprimez des chansons en cache`,
          'QuotaExceededError'
        );
        } // end if est2
      }
    } catch (e: any) {
      // Re-lancer uniquement les erreurs de quota, pas les erreurs storage.estimate()
      if (e.name === 'QuotaExceededError') throw e;
    }

    const buffer = await blob.arrayBuffer();
    const store  = await this.tx(STORE_AUDIO, 'readwrite');

    try {
      await this.idbOp(store.put({
        key,
        buffer,
        size:    blob.size,
        type:    blob.type || (isIOS() ? 'audio/mp4' : 'audio/webm'),
        savedAt: Date.now(),
        ...meta,
      }));
    } catch (e: any) {
      // IDBTransaction peut aussi lever QuotaExceededError directement
      if (e.name === 'QuotaExceededError' || (e.message && e.message.includes('quota'))) {
        const est = await this.getStorageEstimate().catch(() => ({ used: 0, quota: 50 * 1024 * 1024, pct: 0 }));
        const usedMB  = (est.used  / (1024 * 1024)).toFixed(1);
        const quotaMB = (est.quota / (1024 * 1024)).toFixed(1);
        throw new DOMException(
          `QUOTA_FULL: IndexedDB plein (${usedMB} Mo / ${quotaMB} Mo) — supprimez des chansons en cache pour libérer de l'espace`,
          'QuotaExceededError'
        );
      }
      throw e;
    }
  }

  async hasAudio(key: string): Promise<boolean> {
    const store = await this.tx(STORE_AUDIO);
    const rec   = await this.idbOp(store.get(key));
    return !!rec;
  }

  // Vérification RÉELLE du cache — vérifie que les blobs audio existent vraiment
  // (pas juste le flag cachedSongIds qui peut être désynchronisé si iOS vide le cache)
  async verifySongCache(songId: string): Promise<{ inst: boolean; vocal: boolean; both: boolean }> {
    const [inst, vocal] = await Promise.all([
      this.hasAudio(`inst_${songId}`),
      this.hasAudio(`vocal_${songId}`),
    ]);
    // Marquer uncached seulement si vraiment rien — pas si partiel (upload manuel d'un seul stem)
    if (!inst && !vocal) {
      await this.markSongUncached(songId);
    }
    return { inst, vocal, both: inst && vocal };
  }

  async deleteAudio(key: string): Promise<void> {
    const store = await this.tx(STORE_AUDIO, 'readwrite');
    await this.idbOp(store.delete(key));
  }

  // Supprimer tous les fichiers audio d'une chanson (nettoyage espace)
  async deleteAllForSong(songId: string): Promise<void> {
    // Une seule transaction pour lire + supprimer (évite conflit iOS)
    await this.init(); const db = this.db!;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_AUDIO], 'readwrite');
      const store = tx.objectStore(STORE_AUDIO);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        const allKeys = req.result as string[];
        const toDelete = allKeys.filter(k =>
          k === `inst_${songId}` ||
          k === `vocal_${songId}` ||
          (k as string).includes(`_${songId}_`)
        );
        let pending = toDelete.length;
        if (pending === 0) { resolve(); return; }
        for (const k of toDelete) {
          const d = store.delete(k);
          d.onsuccess = () => { if (--pending === 0) resolve(); };
          d.onerror   = () => { if (--pending === 0) resolve(); };
        }
      };
      req.onerror = () => reject(req.error);
      tx.onerror  = () => reject(tx.error);
    });
    await this.markSongUncached(songId);
  }

  async getAllAudioKeys(): Promise<string[]> {
    const store = await this.tx(STORE_AUDIO);
    return this.idbOp(store.getAllKeys()) as Promise<string[]>;
  }

  // ── État persistant ───────────────────────────────────────────────────────

  async setState(key: string, value: any): Promise<void> {
    const store = await this.tx(STORE_STATE, 'readwrite');
    await this.idbOp(store.put({ key, value, updatedAt: Date.now() }));
  }

  async getState<T>(key: string, defaultValue: T): Promise<T> {
    const store = await this.tx(STORE_STATE);
    const rec   = await this.idbOp(store.get(key));
    return rec ? rec.value : defaultValue;
  }

  // ── IDs des chansons en cache ──────────────────────────────────────────────

  async getCachedSongIds(): Promise<Set<string>> {
    const ids = await this.getState<string[]>('cachedSongIds', []);
    return new Set(ids);
  }

  async markSongCached(songId: string): Promise<void> {
    const ids = await this.getCachedSongIds();
    ids.add(songId);
    await this.setState('cachedSongIds', Array.from(ids));
  }

  async markSongUncached(songId: string): Promise<void> {
    const ids = await this.getCachedSongIds();
    ids.delete(songId);
    await this.setState('cachedSongIds', Array.from(ids));
  }

  // ── Taille et quota ───────────────────────────────────────────────────────

  async getTotalSize(): Promise<number> {
    const store = await this.tx(STORE_AUDIO);
    const all   = await this.idbOp(store.getAll());
    return all.reduce((sum: number, r: any) => sum + (r.size || 0), 0);
  }

  // Estimation du quota disponible (navigator.storage API)
  // iOS Safari : ~50MB par origine, peut varier
  // Libérer de l'espace en supprimant les enregistrements les plus anciens
  async freeSpaceForSize(needed: number): Promise<void> {
    await this.init(); const db = this.db!;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['audio'], 'readwrite');
      const store = tx.objectStore('audio');
      const req = store.getAll();
      req.onsuccess = () => {
        // Trier par date (les enregistrements d'abord, les plus anciens en premier)
        const items = req.result as any[];
        const recs = items.filter(i => i.key?.startsWith('rec_'))
          .sort((a, b) => (a.meta?.createdAt || 0) - (b.meta?.createdAt || 0));
        let freed = 0;
        const deleteNext = (i: number) => {
          if (i >= recs.length || freed >= needed) { resolve(); return; }
          const del = store.delete(recs[i].key);
          del.onsuccess = () => {
            freed += recs[i].size || 0;
            console.warn(`[DB] Libéré enregistrement ${recs[i].key} (${(freed/1024/1024).toFixed(1)} Mo)`);
            deleteNext(i + 1);
          };
          del.onerror = () => deleteNext(i + 1);
        };
        deleteNext(0);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getStorageEstimate(): Promise<{ used: number; quota: number; pct: number }> {
    const used = await this.getTotalSize();
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      try {
        const est = await navigator.storage.estimate();
        // iOS 17+ retourne le vrai quota appareil (souvent 500Mo–2Go)
        // On prend le quota réel de navigator.storage si > 200 Mo, sinon fallback 500 Mo
        const rawQuota = est.quota || 0;
        const quota = rawQuota > 200 * 1024 * 1024 ? rawQuota : 500 * 1024 * 1024;
        return { used, quota, pct: Math.round((used / quota) * 100) };
      } catch {}
    }
    // Fallback : quota iOS conservateur 500 Mo
    const quota = 500 * 1024 * 1024;
    return { used, quota, pct: Math.round((used / quota) * 100) };
  }

  // Vider tout le cache audio (garde les métadonnées)
  async clearAllAudio(): Promise<void> {
    const store = await this.tx(STORE_AUDIO, 'readwrite');
    await this.idbOp(store.clear());
    await this.setState('cachedSongIds', []);
  }

  // Garder seulement les N prises les plus récentes par chanson, supprimer le reste
  async clearOldRecordings(keepPerSong: number = 3): Promise<number> {
    await this.init(); const db = this.db!;
    return new Promise((resolve) => {
      const tx = db.transaction(['audio'], 'readwrite');
      const store = tx.objectStore('audio');
      const req = store.getAll();
      req.onsuccess = () => {
        const items = req.result as any[];
        const recs = items.filter(i => i.key?.startsWith('rec_'));
        // Grouper par songId
        const bySong: Record<string, any[]> = {};
        for (const r of recs) {
          const songId = r.meta?.songId || 'unknown';
          if (!bySong[songId]) bySong[songId] = [];
          bySong[songId].push(r);
        }
        // Garder les N plus récentes, supprimer le reste
        const toDelete: string[] = [];
        for (const songId in bySong) {
          const sorted = bySong[songId].sort((a, b) => (b.meta?.createdAt || 0) - (a.meta?.createdAt || 0));
          for (let i = keepPerSong; i < sorted.length; i++) toDelete.push(sorted[i].key);
        }
        let done = 0;
        if (toDelete.length === 0) { resolve(0); return; }
        for (const key of toDelete) {
          const del = store.delete(key);
          del.onsuccess = () => { if (++done === toDelete.length) resolve(toDelete.length); };
          del.onerror  = () => { if (++done === toDelete.length) resolve(toDelete.length); };
        }
      };
      req.onerror = () => resolve(0);
    });
  }
}

export const studioOfflineDB = new StudioOfflineDatabase();
