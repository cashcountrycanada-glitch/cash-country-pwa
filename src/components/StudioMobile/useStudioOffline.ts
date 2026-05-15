/**
 * useStudioOffline.ts — Hook réseau, PWA, cache hors-ligne v3
 *
 * NOUVEAUTÉS v3 :
 * - cacheError : message d'erreur exposé avec songId pour afficher "Réessayer"
 * - forceRefreshSong : re-télécharge les stems même s'ils sont déjà en cache
 *   (utile si un stem est corrompu ou mal converti)
 * - cachedCount : nombre total de chansons en cache
 * - Meilleure gestion WiFi coupé : l'erreur reste visible jusqu'au prochain essai
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Song, TrackType } from '../../types';
import { studioOfflineDB } from '../../services/StudioOfflineDB';

interface StorageInfo { used: number; quota: number; pct: number; }

export interface CacheProgress {
  step:  'inst_download' | 'inst_convert' | 'vocal_download' | 'vocal_convert' | 'done';
  label: string;
  pct:   number;
}

export interface CacheError {
  songId:  string;
  message: string;
}

interface OfflineResult {
  isOnline:        boolean;
  isInstalled:     boolean;
  httpsUrl:        string;
  installPrompt:   any;
  cachedSongs:     Set<string>;
  cachedCount:     number;
  cachingId:       string | null;
  cacheProgress:   CacheProgress | null;
  cacheError:      CacheError | null;
  storage:         StorageInfo | null;
  storageWarning:  boolean;
  cacheHealth:     'ok' | 'incomplete' | 'checking' | 'repairing';
  missingModules:  number;
  repairProgress:  number; // 0-100
  installPWA:          () => Promise<void>;
  cacheSongForOffline: (song: Song, allSongs: Song[], force?: boolean) => Promise<void>;
  forceRefreshSong:    (song: Song, allSongs: Song[]) => Promise<void>;
  uncacheSong:         (songId: string) => Promise<void>;
  clearAllCache:       () => Promise<void>;
  clearCacheError:     () => void;
  repairCache:         () => void;
  importFileToCache:   (song: Song, type: 'inst' | 'vocal', file: File) => Promise<void>;
  setOfflineLog:       (fn: (msg: string) => void) => void;
}

// ── Téléchargement avec progression réelle ────────────────────────────────────
async function fetchWithProgress(
  url: string,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  // Timeout 90s — fichiers audio peuvent être volumineux
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 90_000);
  const combined   = signal
    ? (() => { signal.addEventListener('abort', () => controller.abort()); return controller.signal; })()
    : controller.signal;

  let res: Response;
  try {
    res = await fetch(url, { signal: combined });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) throw new Error(`Erreur serveur ${res.status}`);

  const contentLength = res.headers.get('Content-Length');
  const total = contentLength ? parseInt(contentLength, 10) : 0;

  let blob: Blob;
  if (!total || !res.body) {
    onProgress(50);
    blob = await res.blob();
    onProgress(100);
  } else {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(Math.round((received / total) * 100));
    }

    const allChunks = new Uint8Array(received);
    let pos = 0;
    for (const chunk of chunks) { allChunks.set(chunk, pos); pos += chunk.length; }
    blob = new Blob([allChunks]);
  }

  // Vérifier que le blob est bien un fichier audio — pas une page HTML du routeur
  const blobType = blob.type || '';
  const isAudio  = blobType.startsWith('audio/') || blobType === 'application/octet-stream' || blobType === '';
  if (!isAudio && blobType.startsWith('text/')) {
    throw new Error(`Réponse invalide (${blobType}) — le Mac est peut-être éteint`);
  }

  return blob;
}

function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// iOS Safari supporte FLAC nativement depuis iOS 11 — pas de conversion nécessaire.
function getMediaUrl(fileName: string): string {
  const _mac = ((window as any).__CC_MAC_URL as string) || '';
  const _base = _mac.startsWith('http') ? _mac : '';
  return `${_base}/api/media/${encodeURIComponent(fileName)}`;
}

function getMediaUrlFallbacks(fileName: string): string[] {
  // Génère des variantes du nom de fichier en cas de 503/404
  const urls: string[] = [getMediaUrl(fileName)];
  // Variante sans _compressed
  const noCompressed = fileName.replace(/_compressed(\.\w+)$/, '$1');
  if (noCompressed !== fileName) urls.push(getMediaUrl(noCompressed));
  // Variante avec extension différente (.flac <-> .mp3)
  const withFlac = fileName.replace(/\.mp3$/i, '.flac');
  if (withFlac !== fileName) urls.push(getMediaUrl(withFlac));
  const withMp3 = fileName.replace(/\.flac$/i, '.mp3');
  if (withMp3 !== fileName) urls.push(getMediaUrl(withMp3));
  // Sans _compressed + flac
  const noCompressedFlac = noCompressed.replace(/\.mp3$/i, '.flac');
  if (noCompressedFlac !== noCompressed && noCompressedFlac !== fileName) urls.push(getMediaUrl(noCompressedFlac));
  return [...new Set(urls)];
}

function needsConversion(_fileName: string): boolean {
  return false; // iOS lit FLAC nativement — pas de transcoding
}

export function useStudioOffline(): OfflineResult {
  const logRef = useRef<(msg: string) => void>(() => {});
  const setOfflineLog = useCallback((fn: (msg: string) => void) => { logRef.current = fn; }, []);
  const log = (msg: string) => logRef.current(msg);
  const [isOnline, setIsOnline]           = useState(navigator.onLine);
  const [isInstalled, setIsInstalled]     = useState(false);
  const [httpsUrl, setHttpsUrl]           = useState('');
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [cachedSongs, setCachedSongs]     = useState<Set<string>>(new Set());
  const [cachingId, setCachingId]         = useState<string | null>(null);
  const [cacheProgress, setCacheProgress] = useState<CacheProgress | null>(null);
  const [cacheError, setCacheError]       = useState<CacheError | null>(null);
  const [storage, setStorage]             = useState<StorageInfo | null>(null);
  const [cacheHealth, setCacheHealth]     = useState<'ok'|'incomplete'|'checking'|'repairing'>('checking');
  const [missingModules, setMissingModules] = useState(0);
  const [repairProgress, setRepairProgress] = useState(0);

  // Écouter les messages du SW (CACHE_STATUS, REPAIR_*)
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'CACHE_STATUS') {
        setMissingModules(e.data.missing.length);
        setCacheHealth(e.data.complete ? 'ok' : 'incomplete');
      }
      if (e.data?.type === 'REPAIR_START') {
        setCacheHealth('repairing');
        setRepairProgress(0);
      }
      if (e.data?.type === 'REPAIR_PROGRESS') {
        setRepairProgress(Math.round((e.data.repaired / e.data.total) * 100));
      }
      if (e.data?.type === 'REPAIR_DONE') {
        setCacheHealth(e.data.complete ? 'ok' : 'incomplete');
        setMissingModules(e.data.failed);
        setRepairProgress(e.data.complete ? 100 : 0);
      }
    };
    navigator.serviceWorker?.addEventListener('message', handler);
    // Vérifier l'état du cache au montage.
    // Le contrôleur SW peut ne pas être encore actif au premier rendu (installation
    // asynchrone). On attend 2s avant de déclarer 'incomplete', ce qui évite
    // le faux avertissement jaune au démarrage sur iPhone.
    const checkSW = () => {
      const sw = navigator.serviceWorker?.controller;
      if (sw) {
        sw.postMessage({ type: 'CHECK_CACHE' });
      } else {
        // Pas de SW du tout (ex: http sans PWA) → pas d'avertissement inutile
        setCacheHealth('ok');
      }
    };
    // Vérification immédiate si SW déjà actif, sinon attendre l'activation
    if (navigator.serviceWorker?.controller) {
      checkSW();
    } else {
      // SW en cours d'activation → attendre
      const onControllerChange = () => {
        checkSW();
        navigator.serviceWorker?.removeEventListener('controllerchange', onControllerChange);
      };
      navigator.serviceWorker?.addEventListener('controllerchange', onControllerChange);
      // Timeout de sécurité : si le SW n'arrive pas en 5s, on considère OK (pas de cache)
      setTimeout(() => {
        navigator.serviceWorker?.removeEventListener('controllerchange', onControllerChange);
        if (!navigator.serviceWorker?.controller) setCacheHealth('ok');
      }, 5000);
    }
    return () => navigator.serviceWorker?.removeEventListener('message', handler);
  }, []);

  const repairCache = () => {
    const sw = navigator.serviceWorker?.controller;
    if (sw) { setCacheHealth('repairing'); sw.postMessage({ type: 'REPAIR_CACHE' }); }
    else window.location.reload();
  };
  const storageWarning = storage ? storage.pct > 90 : false;
  const cachedCount    = cachedSongs.size;

  const refreshStorage = useCallback(async () => {
    try { setStorage(await studioOfflineDB.getStorageEstimate()); } catch {}
  }, []);

  useEffect(() => {
    const up   = () => setIsOnline(true);
    const down = () => setIsOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);

  useEffect(() => {
    fetch('/api/local-ip').then(r => r.json())
      .then(d => { if (d.httpsUrl) setHttpsUrl(d.studioUrl || d.httpsUrl + '?mode=studio'); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true;
    setIsInstalled(standalone);
    const handler = (e: any) => { e.preventDefault(); setInstallPrompt(e); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  useEffect(() => {
    studioOfflineDB.getCachedSongIds().then(setCachedSongs).catch(() => {});
    refreshStorage();
  }, []);

  const installPWA = useCallback(async () => {
    if (installPrompt) {
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      if (outcome === 'accepted') { setIsInstalled(true); setInstallPrompt(null); }
    } else {
      alert('Sur iPhone : bouton Partage ⬆️ → "Sur l\'écran d\'accueil"');
    }
  }, [installPrompt]);

  // Helper : essaie chaque URL en séquence sans for...of+await (compat Babel browser)
  const tryUrls = (urls: string[], onProgress: (pct: number) => void): Promise<Blob> => {
    const attempt = (i: number): Promise<Blob> => {
      if (i >= urls.length) return Promise.reject(new Error('Toutes les URLs ont échoué'));
      return fetchWithProgress(urls[i], onProgress).catch(() => attempt(i + 1));
    };
    return attempt(0);
  };

  // ── Téléchargement d'un stem individuel ──────────────────────────────────
  const downloadStem = async (
    fileName: string,
    key: string,
    songId: string,
    songTitle: string,
    type: 'instrumental' | 'vocal',
    baseStep: 'inst' | 'vocal',
    basePct: number,
    force: boolean,
  ): Promise<boolean> => {
    const alreadyCached = !force && await studioOfflineDB.hasAudio(key);

    if (alreadyCached) {
      const label = type === 'instrumental' ? '🎸 Instrumental — déjà en cache ✓' : '🎤 Guide vocal — déjà en cache ✓';
      setCacheProgress({ step: `${baseStep}_download` as any, label, pct: basePct + 47 });
      await new Promise(r => setTimeout(r, 300));
      return true;
    }

    // Vérifier que l'URL Mac est configurée AVANT de tenter le téléchargement
    const macUrl = ((window as any).__CC_MAC_URL as string) || '';
    if (!macUrl.startsWith('http')) {
      throw new Error(`Adresse Mac non configurée — configure l'URL du Mac dans les paramètres pour télécharger les stems`);
    }

    const urlToFetch = getMediaUrlFallbacks(fileName)[0];
    log(`⬇️ ${type === 'instrumental' ? '🎸' : '🎤'} Téléchargement: ${fileName}`);
    log(`   URL: ${urlToFetch}`);

    const converting = needsConversion(fileName);
    const emoji = type === 'instrumental' ? '🎸' : '🎤';
    const name  = type === 'instrumental' ? 'Instrumental' : 'Guide vocal';

    // Téléchargement via tryUrls (pas de for...of+await — compat Babel browser)
    const urls = getMediaUrlFallbacks(fileName);
    let blob: Blob;
    if (converting) {
      setCacheProgress({ step: `${baseStep}_convert` as any, label: `${emoji} ${name} — conversion...`, pct: basePct + 2 });
      const sim = setInterval(() => {
        setCacheProgress({ step: `${baseStep}_convert` as any, label: `${emoji} ${name} — conversion...`, pct: basePct + 20 });
      }, 400);
      try {
        blob = await tryUrls(urls, (dlPct) => {
          clearInterval(sim);
          setCacheProgress({ step: `${baseStep}_convert` as any, label: `${emoji} ${name} — ${dlPct}%`, pct: basePct + 10 + Math.round(dlPct * 0.35) });
        });
      } finally { clearInterval(sim); }
    } else {
      setCacheProgress({ step: `${baseStep}_download` as any, label: `${emoji} ${name} — 0%`, pct: basePct + 2 });
      blob = await tryUrls(urls,
        (dlPct) => setCacheProgress({ step: `${baseStep}_download` as any, label: `${emoji} ${name} — ${dlPct}%`, pct: basePct + 2 + Math.round(dlPct * 0.45) }),
      );
    }
    await studioOfflineDB.saveAudio(key, blob, { songId, songTitle, type });
    return true;
  };

  // ── Cache principal ───────────────────────────────────────────────────────
  const cacheSongForOffline = useCallback(async (song: Song, allSongs: Song[], force = false) => {
    if (cachingId) return; // déjà en cours
    setCachingId(song.id);
    setCacheProgress({ step: 'inst_download', label: 'Démarrage...', pct: 0 });
    setCacheError(null);

    try {
      await studioOfflineDB.saveSongs(allSongs);

      const inst  = song.versions?.find(v => v.trackType === TrackType.STEM_INSTRUMENTAL);
      const vocal = song.versions?.find(v => v.trackType === TrackType.STEM_VOCAL);

      if (inst?.fileName) {
        await downloadStem(inst.fileName, `inst_${song.id}`, song.id, song.title, 'instrumental', 'inst', 0, force);
      }
      if (vocal?.fileName) {
        await downloadStem(vocal.fileName, `vocal_${song.id}`, song.id, song.title, 'vocal', 'vocal', 50, force);
      }

      setCacheProgress({ step: 'done', label: '✓ Prêt hors-ligne', pct: 100 });
      await new Promise(r => setTimeout(r, 700));

      await studioOfflineDB.markSongCached(song.id);
      setCachedSongs(prev => new Set([...prev, song.id]));
      await refreshStorage();

    } catch (e: any) {
      const msg = !navigator.onLine
        ? 'WiFi coupé — reconnecte-toi et réessaie'
        : e.message || 'Erreur inconnue';
      console.warn('[StudioOffline] Erreur:', msg);
      setCacheError({ songId: song.id, message: msg });
      setCacheProgress(null);
    } finally {
      setCachingId(null);
      setCacheProgress(null);
    }
  }, [cachingId]);

  // ── Force re-téléchargement (stems corrompus) ─────────────────────────────
  const forceRefreshSong = useCallback(async (song: Song, allSongs: Song[]) => {
    // Supprimer les stems existants avant de re-télécharger
    await studioOfflineDB.deleteAllForSong(song.id).catch(() => {});
    setCachedSongs(prev => { const s = new Set(prev); s.delete(song.id); return s; });
    await cacheSongForOffline(song, allSongs, true);
  }, [cacheSongForOffline]);

  const clearCacheError = useCallback(() => setCacheError(null), []);

  const uncacheSong = useCallback(async (songId: string) => {
    await studioOfflineDB.deleteAllForSong(songId).catch(() => {});
    setCachedSongs(prev => { const s = new Set(prev); s.delete(songId); return s; });
    await refreshStorage();
  }, []);

  const clearAllCache = useCallback(async () => {
    await studioOfflineDB.clearAllAudio().catch(() => {});
    setCachedSongs(new Set());
    await refreshStorage();
  }, []);

  const importFileToCache = useCallback(async (song: Song, type: 'inst' | 'vocal', file: File) => {
    const key = type === 'inst' ? `inst_${song.id}` : `vocal_${song.id}`;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const rawType = file.type || 'audio/flac';
    // iOS ne supporte pas FLAC/WebM/OGG — forcer audio/mp4 pour que <audio> puisse lire
    const blobType = isIOS && !rawType.includes('mp4') && !rawType.includes('mpeg') && !rawType.includes('aac')
      ? 'audio/mp4' : rawType;
    log(`📂 Import manuel: ${file.name} (${(file.size/1024).toFixed(0)} Ko) → clé: ${key} type: ${blobType}`);
    const blob = new Blob([await file.arrayBuffer()], { type: blobType });
    await studioOfflineDB.saveAudio(key, blob, { songId: song.id, songTitle: song.title, type: type === 'inst' ? 'instrumental' : 'vocal' });
    log(`✅ ${type === 'inst' ? '🎸' : '🎤'} Sauvegardé dans IndexedDB: ${key} (${(blob.size/1024).toFixed(0)} Ko)`);
    // Si les deux stems existent maintenant, marquer la chanson comme cachée
    const hasInst  = await studioOfflineDB.hasAudio(`inst_${song.id}`).catch(() => false);
    const hasVocal = await studioOfflineDB.hasAudio(`vocal_${song.id}`).catch(() => false);
    const inst  = song.versions?.find((v: any) => v.trackType === TrackType.STEM_INSTRUMENTAL);
    const vocal = song.versions?.find((v: any) => v.trackType === TrackType.STEM_VOCAL);
    const needsInst  = !!inst?.fileName;
    const needsVocal = !!vocal?.fileName;
    log(`   inst=${hasInst} vocal=${hasVocal} (requis: inst=${needsInst} vocal=${needsVocal})`);
    if ((!needsInst || hasInst) && (!needsVocal || hasVocal)) {
      await studioOfflineDB.markSongCached(song.id);
      setCachedSongs(prev => new Set([...prev, song.id]));
      log(`✅ ${song.title} marquée Hors-ligne — les deux stems sont en cache`);
    }
    await refreshStorage();
  }, [refreshStorage]);

  return {
    isOnline, isInstalled, httpsUrl, installPrompt,
    cachedSongs, cachedCount, cachingId, cacheProgress, cacheError,
    storage, storageWarning,
    cacheHealth, missingModules, repairProgress,
    installPWA, cacheSongForOffline, forceRefreshSong,
    uncacheSong, clearAllCache, clearCacheError, repairCache,
    importFileToCache, setOfflineLog,
  };
}
