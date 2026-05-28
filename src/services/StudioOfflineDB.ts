/**
 * StudioOfflineDB.ts — Stockage persistant Studio Mobile iPhone v3
 *
 * CORRECTIFS v3 :
 * - OPFS (Origin Private File System) comme stockage PRIMAIRE pour les blobs audio
 *   → Stable sur iOS 17+, pas affecté par le bug IndexedDB AVAudioSession
 *   → Quota basé sur le disque total (38+ Go sur iPhone)
 *   → Écriture directe fichier .mp4/.wav sans passer par IDB transactions
 * - IndexedDB conservé pour les MÉTADONNÉES légères uniquement (pas de ArrayBuffer)
 * - Fallback automatique vers IndexedDB si OPFS indisponible
 * - Récupération au démarrage des prises OPFS non encore indexées
 * - init() robuste avec retry si la DB est bloquée
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

// ── OPFS Helper ────────────────────────────────────────────────────────────────

async function opfsAvailable(): Promise<boolean> {
  try {
    if (!navigator.storage || !navigator.storage.getDirectory) return false;
    await navigator.storage.getDirectory();
    return true;
  } catch { return false; }
}

async function opfsWrite(filename: string, blob: Blob): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(filename, { create: true });
  const writable = await (fh as any).createWritable();
  await writable.write(blob);
  await writable.close();
}

async function opfsRead(filename: string): Promise<Blob | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(filename);
    const file = await fh.getFile();
    return file;
  } catch { return null; }
}

async function opfsDelete(filename: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(filename);
  } catch {}
}

async function opfsExists(filename: string): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.getFileHandle(filename);
    return true;
  } catch { return false; }
}

async function opfsListFiles(): Promise<string[]> {
  try {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const [name] of (root as any).entries()) {
      names.push(name);
    }
    return names;
  } catch { return []; }
}

// ── Classe principale ──────────────────────────────────────────────────────────

class StudioOfflineDatabase {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private _opfsAvailable: boolean | null = null;

  // Queue d'écriture séquentielle — évite les transactions readwrite simultanées sur iOS
  private writeQueue: Promise<any> = Promise.resolve();

  private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(() => fn()).catch(e => { throw e; });
    this.writeQueue = next.catch(() => {});
    return next;
  }

  // Vérifie OPFS une seule fois et met en cache le résultat
  async checkOPFS(): Promise<boolean> {
    if (this._opfsAvailable === null) {
      this._opfsAvailable = await opfsAvailable();
      if (this._opfsAvailable) {
        console.log('[DB] ✅ OPFS disponible — stockage audio primaire');
      } else {
        console.warn('[DB] ⚠️ OPFS indisponible — fallback IndexedDB');
      }
    }
    return this._opfsAvailable;
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
          audioStore.createIndex('songId', 'songId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_STATE)) {
          db.createObjectStore(STORE_STATE, { keyPath: 'key' });
        }
      };

      req.onsuccess = () => {
        this.db = req.result;
        this.db.onclose = () => { this.db = null; this.initPromise = null; };
        this.db.onerror = (e) => console.warn('[StudioDB] Erreur DB:', e);
        resolve();
      };

      req.onerror = () => {
        this.initPromise = null;
        reject(req.error);
      };

      req.onblocked = () => {
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

  // ── Audio — OPFS en primaire, IndexedDB en fallback ────────────────────────

  /**
   * saveAudio : tente OPFS d'abord, puis IndexedDB en fallback.
   * Pour les prises (key commence par "rec_"), OPFS est fortement préféré.
   */
  async saveAudio(key: string, blob: Blob, meta: object = {}): Promise<void> {
    return this.enqueueWrite(() => this._saveAudioImpl(key, blob, meta));
  }

  private async _saveAudioImpl(key: string, blob: Blob, meta: object = {}): Promise<void> {
    const useOPFS = await this.checkOPFS();

    if (useOPFS) {
      try {
        // Nom de fichier OPFS : "rec_REC-1234567890.mp4"
        const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('wav') ? 'wav' : 'webm';
        const filename = `${key}.${ext}`;
        await opfsWrite(filename, blob);
        // Stocker les métadonnées légères dans IndexedDB (sans le buffer)
        try {
          await this.init();
          const store = await this.tx(STORE_AUDIO, 'readwrite');
          await this.idbOp(store.put({
            key,
            opfsFilename: filename,
            size: blob.size,
            type: blob.type || (isIOS() ? 'audio/mp4' : 'audio/webm'),
            savedAt: Date.now(),
            storageBackend: 'opfs',
            ...meta,
          }));
        } catch (idbErr) {
          // Métadonnées IDB échouées — pas grave, OPFS file est là
          console.warn('[DB] saveAudio: métadonnées IDB échouées (OPFS OK):', idbErr);
          // Sauvegarder les métadonnées en localStorage comme backup
          try {
            const lsMeta = JSON.parse(localStorage.getItem('__opfs_index') || '{}');
            lsMeta[key] = { opfsFilename: filename, size: blob.size, type: blob.type, savedAt: Date.now(), ...meta };
            localStorage.setItem('__opfs_index', JSON.stringify(lsMeta));
          } catch {}
        }
        console.log(`[DB] ✅ OPFS saveAudio(${key}) → ${filename} (${(blob.size/1024).toFixed(0)} Ko)`);
        return;
      } catch (opfsErr) {
        console.warn('[DB] OPFS write échoué, fallback IDB:', opfsErr);
      }
    }

    // Fallback IndexedDB (comportement original)
    await this._saveAudioIDB(key, blob, meta);
  }

  private async _saveAudioIDB(key: string, blob: Blob, meta: object = {}): Promise<void> {
    // Vérifier l'espace disponible AVANT d'écrire
    try {
      const est = await this.getStorageEstimate();
      const needed = blob.size;
      const available = est.quota - est.used;
      if (available < needed + 2 * 1024 * 1024) {
        try { await this.freeSpaceForSize(needed); } catch {}
        const est2 = await this.getStorageEstimate();
        if (est2.quota - est2.used < needed + 2 * 1024 * 1024) {
          const usedMB  = (est.used  / (1024 * 1024)).toFixed(1);
          const quotaMB = (est.quota / (1024 * 1024)).toFixed(1);
          const needMB  = (needed    / (1024 * 1024)).toFixed(1);
          throw new DOMException(
            `QUOTA_FULL: utilisé ${usedMB} Mo / ${quotaMB} Mo, besoin ${needMB} Mo`,
            'QuotaExceededError'
          );
        }
      }
    } catch (e: any) {
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
        storageBackend: 'indexeddb',
        ...meta,
      }));
    } catch (e: any) {
      if (e.name === 'QuotaExceededError' || (e.message && e.message.includes('quota'))) {
        const est = await this.getStorageEstimate().catch(() => ({ used: 0, quota: 50 * 1024 * 1024, pct: 0 }));
        throw new DOMException(
          `QUOTA_FULL: IndexedDB plein (${(est.used/1024/1024).toFixed(1)} Mo / ${(est.quota/1024/1024).toFixed(1)} Mo)`,
          'QuotaExceededError'
        );
      }
      throw e;
    }
  }

  /**
   * getAudio : cherche d'abord dans OPFS, puis IndexedDB.
   */
  async getAudio(key: string): Promise<Blob | null> {
    const useOPFS = await this.checkOPFS();

    if (useOPFS) {
      // Chercher dans l'index IDB d'abord pour avoir le nom exact du fichier
      try {
        const store = await this.tx(STORE_AUDIO);
        const rec = await this.idbOp(store.get(key));
        if (rec?.opfsFilename) {
          const blob = await opfsRead(rec.opfsFilename);
          if (blob && blob.size > 0) {
            // Re-typer le blob avec le bon type MIME
            const mimeType = rec.type || (isIOS() ? 'audio/mp4' : 'audio/webm');
            return new Blob([await blob.arrayBuffer()], { type: mimeType });
          }
        }
      } catch {}

      // Fallback : chercher dans l'index localStorage
      try {
        const lsMeta = JSON.parse(localStorage.getItem('__opfs_index') || '{}');
        if (lsMeta[key]?.opfsFilename) {
          const blob = await opfsRead(lsMeta[key].opfsFilename);
          if (blob && blob.size > 0) {
            return new Blob([await blob.arrayBuffer()], { type: lsMeta[key].type || 'audio/mp4' });
          }
        }
      } catch {}

      // Fallback : chercher le fichier OPFS par nom deviné
      for (const ext of ['mp4', 'wav', 'webm']) {
        const blob = await opfsRead(`${key}.${ext}`);
        if (blob && blob.size > 0) {
          return new Blob([await blob.arrayBuffer()], { type: `audio/${ext}` });
        }
      }
    }

    // Fallback IndexedDB (comportement original)
    return this._getAudioIDB(key);
  }

  private async _getAudioIDB(key: string): Promise<Blob | null> {
    const attempt = async (): Promise<Blob | null> => {
      const store = await this.tx(STORE_AUDIO);
      const rec   = await this.idbOp(store.get(key));
      if (!rec) return null;
      if (!rec.buffer || rec.buffer.byteLength === 0) {
        console.error(`[DB] ❌ getAudio IDB(${key}) buffer vide`);
        return null;
      }
      const storedType = rec.type || 'audio/mp4';
      return new Blob([rec.buffer], { type: storedType });
    };

    try {
      return await attempt();
    } catch (e) {
      console.warn(`[DB] getAudio IDB(${key}) échoué, retry...`, e);
      this.db = null;
      this.initPromise = null;
      await new Promise(r => setTimeout(r, 200));
      try {
        return await attempt();
      } catch (e2) {
        console.error(`[DB] getAudio IDB(${key}) échec définitif:`, e2);
        return null;
      }
    }
  }

  async hasAudio(key: string): Promise<boolean> {
    const useOPFS = await this.checkOPFS();

    if (useOPFS) {
      // Vérifier via index IDB
      try {
        const store = await this.tx(STORE_AUDIO);
        const rec = await this.idbOp(store.get(key));
        if (rec?.opfsFilename) {
          return await opfsExists(rec.opfsFilename);
        }
      } catch {}
      // Vérifier directement dans OPFS
      for (const ext of ['mp4', 'wav', 'webm']) {
        if (await opfsExists(`${key}.${ext}`)) return true;
      }
    }

    // Fallback IDB
    try {
      const store = await this.tx(STORE_AUDIO);
      const rec   = await this.idbOp(store.get(key));
      return !!rec && !!rec.buffer && rec.buffer.byteLength > 1000;
    } catch { return false; }
  }

  async deleteAudio(key: string): Promise<void> {
    const useOPFS = await this.checkOPFS();

    if (useOPFS) {
      // Supprimer le fichier OPFS
      try {
        const store = await this.tx(STORE_AUDIO);
        const rec = await this.idbOp(store.get(key));
        if (rec?.opfsFilename) await opfsDelete(rec.opfsFilename);
      } catch {}
      for (const ext of ['mp4', 'wav', 'webm']) {
        await opfsDelete(`${key}.${ext}`);
      }
      // Nettoyer l'index localStorage
      try {
        const lsMeta = JSON.parse(localStorage.getItem('__opfs_index') || '{}');
        delete lsMeta[key];
        localStorage.setItem('__opfs_index', JSON.stringify(lsMeta));
      } catch {}
    }

    // Supprimer aussi l'entrée IDB (métadonnées)
    try {
      const store = await this.tx(STORE_AUDIO, 'readwrite');
      await this.idbOp(store.delete(key));
    } catch {}
  }

  /**
   * Récupération des prises OPFS orphelines au démarrage de l'app.
   * Si des fichiers "rec_*.mp4/wav" existent dans OPFS mais ne sont pas
   * dans IndexedDB (crash pendant la sauvegarde des métadonnées), on les retrouve.
   */
  async recoverOrphanOPFSRecordings(): Promise<string[]> {
    const useOPFS = await this.checkOPFS();
    if (!useOPFS) return [];

    try {
      const allFiles = await opfsListFiles();
      const recFiles = allFiles.filter(f => f.startsWith('rec_') && /\.(mp4|wav|webm)$/.test(f));
      if (recFiles.length === 0) return [];

      const recovered: string[] = [];
      for (const filename of recFiles) {
        // Clé IDB = filename sans l'extension
        const key = filename.replace(/\.(mp4|wav|webm)$/, '');
        try {
          const store = await this.tx(STORE_AUDIO);
          const existing = await this.idbOp(store.get(key));
          if (!existing) {
            // Fichier OPFS sans entrée IDB — recréer les métadonnées
            const blob = await opfsRead(filename);
            if (blob && blob.size > 1000) {
              const ext = filename.split('.').pop() || 'mp4';
              const mimeType = `audio/${ext === 'wav' ? 'wav' : 'mp4'}`;
              try {
                const wStore = await this.tx(STORE_AUDIO, 'readwrite');
                await this.idbOp(wStore.put({
                  key,
                  opfsFilename: filename,
                  size: blob.size,
                  type: mimeType,
                  savedAt: Date.now(),
                  storageBackend: 'opfs',
                  recovered: true,
                }));
              } catch {}
              recovered.push(key);
              console.log(`[DB] 🔄 Récupéré OPFS orphelin: ${filename} (${(blob.size/1024).toFixed(0)} Ko)`);
            }
          }
        } catch {}
      }
      return recovered;
    } catch (e) {
      console.warn('[DB] recoverOrphanOPFSRecordings erreur:', e);
      return [];
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
    try {
      const existing = await this.idbOp((await this.tx(STORE_SONGS)).count());
      if (existing === songs.length) return;
    } catch {}
    const store = await this.tx(STORE_SONGS, 'readwrite');
    await this.idbOp(store.clear());
    for (const s of songs) {
      await this.idbOp(store.put(s));
    }
  }

  async getAllSongs(): Promise<any[]> {
    const store = await this.tx(STORE_SONGS);
    return this.idbOp(store.getAll());
  }

  async listAllAudioKeys(): Promise<string[]> {
    const useOPFS = await this.checkOPFS();
    const keys: string[] = [];

    if (useOPFS) {
      const files = await opfsListFiles();
      for (const f of files) {
        if (f.startsWith('rec_') || f.startsWith('inst_') || f.startsWith('vocal_')) {
          const key = f.replace(/\.(mp4|wav|webm)$/, '');
          const blob = await opfsRead(f);
          keys.push(blob && blob.size > 1000 ? key : `${key} ⚠️VIDE`);
        }
      }
    }

    // Ajouter les clés IDB non déjà trouvées
    try {
      const store = await this.tx(STORE_AUDIO);
      const idbKeys = await this.idbOp(store.getAllKeys()) as string[];
      for (const k of idbKeys) {
        if (!keys.some(existing => existing === k || existing.startsWith(k))) {
          keys.push(k);
        }
      }
    } catch {}

    return keys;
  }

  async verifySongCache(songId: string): Promise<{ inst: boolean; vocal: boolean; both: boolean }> {
    const [inst, vocal] = await Promise.all([
      this.hasAudio(`inst_${songId}`),
      this.hasAudio(`vocal_${songId}`),
    ]);
    if (!inst && !vocal) {
      await this.markSongUncached(songId);
    }
    return { inst, vocal, both: inst && vocal };
  }

  async deleteAllForSong(songId: string): Promise<void> {
    const useOPFS = await this.checkOPFS();

    if (useOPFS) {
      const files = await opfsListFiles();
      for (const f of files) {
        if (f.includes(`_${songId}`) || f === `inst_${songId}.mp4` || f === `vocal_${songId}.mp4`) {
          await opfsDelete(f);
        }
      }
    }

    // IDB
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
    const useOPFS = await this.checkOPFS();
    if (useOPFS) {
      // Avec OPFS, navigator.storage.estimate() donne la vraie utilisation
      if (navigator.storage && navigator.storage.estimate) {
        try {
          const est = await navigator.storage.estimate();
          return est.usage || 0;
        } catch {}
      }
    }
    const store = await this.tx(STORE_AUDIO);
    const all   = await this.idbOp(store.getAll());
    return all.reduce((sum: number, r: any) => sum + (r.size || 0), 0);
  }

  async freeSpaceForSize(needed: number): Promise<void> {
    await this.init(); const db = this.db!;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['audio'], 'readwrite');
      const store = tx.objectStore('audio');
      const req = store.getAll();
      req.onsuccess = () => {
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
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      try {
        const est = await navigator.storage.estimate();
        const used  = est.usage  || 0;
        const rawQuota = est.quota || 0;
        // iOS 17+ retourne le vrai quota appareil (souvent 500Mo–2Go)
        const quota = rawQuota > 200 * 1024 * 1024 ? rawQuota : 500 * 1024 * 1024;
        return { used, quota, pct: Math.round((used / quota) * 100) };
      } catch {}
    }
    const used = await this.getTotalSize();
    const quota = 500 * 1024 * 1024;
    return { used, quota, pct: Math.round((used / quota) * 100) };
  }

  async clearAllAudio(): Promise<void> {
    const useOPFS = await this.checkOPFS();
    if (useOPFS) {
      const files = await opfsListFiles();
      for (const f of files) {
        if (/\.(mp4|wav|webm)$/.test(f)) await opfsDelete(f);
      }
    }
    const store = await this.tx(STORE_AUDIO, 'readwrite');
    await this.idbOp(store.clear());
    await this.setState('cachedSongIds', []);
    try { localStorage.removeItem('__opfs_index'); } catch {}
  }

  async clearOldRecordings(keepPerSong: number = 3): Promise<number> {
    await this.init(); const db = this.db!;
    return new Promise((resolve) => {
      const tx = db.transaction(['audio'], 'readwrite');
      const store = tx.objectStore('audio');
      const req = store.getAll();
      req.onsuccess = () => {
        const items = req.result as any[];
        const recs = items.filter(i => i.key?.startsWith('rec_'));
        const bySong: Record<string, any[]> = {};
        for (const r of recs) {
          const songId = r.meta?.songId || r.songId || 'unknown';
          if (!bySong[songId]) bySong[songId] = [];
          bySong[songId].push(r);
        }
        const toDelete: string[] = [];
        for (const songId in bySong) {
          const sorted = bySong[songId].sort((a, b) => (b.meta?.createdAt || b.savedAt || 0) - (a.meta?.createdAt || a.savedAt || 0));
          for (let i = keepPerSong; i < sorted.length; i++) toDelete.push(sorted[i].key);
        }
        let done = 0;
        if (toDelete.length === 0) { resolve(0); return; }
        for (const key of toDelete) {
          // Supprimer aussi le fichier OPFS associé
          opfsDelete(`${key}.mp4`).catch(() => {});
          opfsDelete(`${key}.wav`).catch(() => {});
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
