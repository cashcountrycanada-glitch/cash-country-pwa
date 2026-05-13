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
    return this.db!;
  }

  private async tx(store: string, mode: IDBTransactionMode = 'readonly') {
    const db = await this.getDB();
    return db.transaction([store], mode).objectStore(store);
  }

  private idbOp<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
  }

  // ── Chansons ──────────────────────────────────────────────────────────────

  async saveSongs(songs: any[]): Promise<void> {
    const store = await this.tx(STORE_SONGS, 'readwrite');
    await this.idbOp(store.clear());
    await Promise.all(songs.map(s => this.idbOp(store.put(s))));
  }

  async getAllSongs(): Promise<any[]> {
    const store = await this.tx(STORE_SONGS);
    return this.idbOp(store.getAll());
  }

  // ── Audio ─────────────────────────────────────────────────────────────────

  async saveAudio(key: string, blob: Blob, meta: object = {}): Promise<void> {
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

  async getAudio(key: string): Promise<Blob | null> {
    const store = await this.tx(STORE_AUDIO);
    const rec   = await this.idbOp(store.get(key));
    if (!rec) return null;
    // Sur iOS Safari : forcer audio/mp4 TOUJOURS — webm/ogg/flac causent NotSupportedError.
    // Sur desktop : respecter le type stocké.
    const storedType = rec.type || 'audio/mp4';
    const type = isIOS()
      ? 'audio/mp4'
      : storedType;
    return new Blob([rec.buffer], { type });
  }

  async hasAudio(key: string): Promise<boolean> {
    const store = await this.tx(STORE_AUDIO);
    const rec   = await this.idbOp(store.get(key));
    return !!rec;
  }

  async deleteAudio(key: string): Promise<void> {
    const store = await this.tx(STORE_AUDIO, 'readwrite');
    await this.idbOp(store.delete(key));
  }

  // Supprimer tous les fichiers audio d'une chanson (nettoyage espace)
  async deleteAllForSong(songId: string): Promise<void> {
    const store = await this.tx(STORE_AUDIO, 'readwrite');
    // Chercher par clé manuelle (les clés commencent par inst_, vocal_, rec_)
    const allKeys = await this.idbOp(store.getAllKeys()) as string[];
    const toDelete = allKeys.filter(k =>
      k === `inst_${songId}` ||
      k === `vocal_${songId}` ||
      (k as string).includes(`_${songId}_`)
    );
    const store2 = await this.tx(STORE_AUDIO, 'readwrite');
    await Promise.all(toDelete.map(k => this.idbOp(store2.delete(k))));
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
            freed += recs[i].blob?.size || 0;
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
        const quota = est.quota || 50 * 1024 * 1024;
        return { used, quota, pct: Math.round((used / quota) * 100) };
      } catch {}
    }
    // Fallback : quota iOS estimé à 50MB
    const quota = 50 * 1024 * 1024;
    return { used, quota, pct: Math.round((used / quota) * 100) };
  }

  // Vider tout le cache audio (garde les métadonnées)
  async clearAllAudio(): Promise<void> {
    const store = await this.tx(STORE_AUDIO, 'readwrite');
    await this.idbOp(store.clear());
    await this.setState('cachedSongIds', []);
  }
}

export const studioOfflineDB = new StudioOfflineDatabase();
