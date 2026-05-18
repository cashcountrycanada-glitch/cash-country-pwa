/**
 * SongSelector.tsx — Écran sélection chanson v3
 *
 * NOUVEAUTÉS v3 :
 * - Bouton "Réessayer" quand un téléchargement échoue (WiFi coupé, etc.)
 * - Bouton "↺ Actualiser" sur les chansons en cache pour forcer le re-téléchargement
 * - Compteur "X / Y hors-ligne" dans l'entête
 * - Barre de progression détaillée par stem avec badge conversion iOS
 */
import React, { useState, useEffect, useRef } from 'react';
import {
  Mic, Music, Wifi, WifiOff, Radio, CheckCircle2,
  Loader2, Download, Trash2, AlertTriangle, HardDrive,
  ArrowDownToLine, RefreshCw, AlertCircle, RotateCcw,
} from 'lucide-react';
import { Song, TrackType } from '../../types';
import { studioService } from '../../services/StudioService';
import { studioOfflineDB } from '../../services/StudioOfflineDB';
import { CacheProgress, CacheError } from './useStudioOffline';

interface StorageInfo { used: number; quota: number; pct: number; }
function formatMB(b: number) { return (b / 1048576).toFixed(0) + ' MB'; }

interface Props {
  songs:          Song[];
  isOnline:       boolean;
  isInstalled:    boolean;
  httpsUrl:       string;
  cachedSongs:    Set<string>;
  cachedCount:    number;
  cachingId:      string | null;
  cacheProgress:  CacheProgress | null;
  cacheError:     CacheError | null;
  storage:        StorageInfo | null;
  storageWarning: boolean;
  pendingCount:   number;
  cacheHealth:    'ok' | 'incomplete' | 'checking' | 'repairing';
  missingModules: number;
  repairProgress: number;
  onSelect:           (song: Song) => void;
  onInstall:          () => void;
  onCache:            (song: Song) => void;
  onForceRefresh:     (song: Song) => void;
  onImportFile:       (song: Song, type: 'inst' | 'vocal', file: File) => Promise<void>;
  onUncache:          (songId: string) => void;
  onClearAll:         () => void;
  onViewRecordings:   () => void;
  onClearCacheError:  () => void;
  onRepairCache:      () => void;
}

// ── Composant config URL Mac ─────────────────────────────────────────────────
// Composant ligne de stem — défini au niveau module pour éviter la redéfinition à chaque render
interface StemRowProps {
  songId: string;
  type: 'inst' | 'vocal';
  fileName: string | null;
  inCache: boolean | null;
  importing: string | null;
  testingAudio: string | null;
  onTest: (songId: string, type: 'inst' | 'vocal') => void;
  onImport: (e: React.ChangeEvent<HTMLInputElement>) => void;
}
function StemRow({ songId, type, fileName, inCache, importing, testingAudio, onTest, onImport }: StemRowProps) {
  const isInst   = type === 'inst';
  const testKey  = `${songId}:${type}`;
  const isTesting = testingAudio === testKey;
  const isImporting = importing === `${songId}:${type}`;
  return (
    <div className="mb-4">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-[9px] font-black uppercase tracking-widest text-zinc-500">
          {isInst ? '🎸 Instrumental' : '🎤 Vocal stem'}
        </span>
        {inCache === null  && <span className="text-[9px] text-zinc-600 animate-pulse">…vérif</span>}
        {inCache === true  && <span className="text-[9px] font-black text-emerald-400 bg-emerald-900/30 px-1.5 py-0.5 rounded-full">✓ En cache</span>}
        {inCache === false && <span className="text-[9px] font-black text-orange-400 bg-orange-900/20 px-1.5 py-0.5 rounded-full">⚠ Absent</span>}
      </div>
      {fileName
        ? <p className="text-[10px] font-mono text-zinc-300 bg-zinc-800/80 border border-zinc-700 rounded-lg px-2.5 py-1.5 mb-2 break-all leading-relaxed">{fileName}</p>
        : <p className="text-[10px] font-mono text-zinc-600 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 mb-2 italic">Aucun fichier associé</p>
      }
      <div className="flex gap-2">
        <button
          onClick={e => { e.stopPropagation(); onTest(songId, type); }}
          disabled={!inCache}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl font-black text-[11px] uppercase transition-all active:scale-95 ${
            !inCache   ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed opacity-40' :
            isTesting  ? 'bg-amber-600 text-white' :
            isInst     ? 'bg-blue-900/60 border border-blue-600/40 text-blue-300' :
                         'bg-emerald-900/60 border border-emerald-600/40 text-emerald-300'
          }`}>
          {isTesting ? '⏹ Stop' : '🔊 Écouter'}
        </button>
        <label className="flex-1">
          <input type="file" accept="audio/*,.flac,.wav,.mp3,.m4a,.mp4" className="hidden" onChange={onImport}/>
          <span className={`flex items-center justify-center gap-1.5 py-2 rounded-xl font-black text-[11px] uppercase active:scale-95 cursor-pointer transition-all ${
            isImporting ? 'bg-zinc-700 text-zinc-400' :
            isInst      ? 'bg-blue-700 text-white' : 'bg-emerald-700 text-white'
          }`}>
            {isImporting ? '⏳ Import...' : '📂 Remplacer'}
          </span>
        </label>
      </div>
    </div>
  );
}

function MacUrlConfig() {
  const [macUrl, setMacUrl] = React.useState<string>(() => (window as any).__CC_MAC_URL || '');
  const [editing, setEditing] = React.useState(false);
  const [input, setInput] = React.useState('');
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<'ok'|'fail'|null>(null);
  const [autoDetecting, setAutoDetecting] = React.useState(false);

  React.useEffect(() => {
    const existing = (window as any).__CC_MAC_URL as string | undefined;
    if (existing && existing.startsWith('http')) return;
    setAutoDetecting(true);
    fetch('/api/local-ip', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        const url = d.studioUrl || d.httpsUrl;
        if (url && url.startsWith('http')) {
          const clean = url.replace(/\?.*$/, '').replace(/\/$/, '');
          (window as any).__CC_MAC_URL = clean;
          // Aussi stocker version HTTP pour les téléchargements (pas besoin SSL)
          (window as any).__CC_MAC_HTTP_URL = clean.replace('https://', 'http://').replace(':8443', ':8080');
          localStorage.setItem('cc_mac_url', clean);
          setMacUrl(clean);
        }
      })
      .catch(() => {})
      .finally(() => setAutoDetecting(false));
  }, []);

  const save = async () => {
    let url = input.trim().replace(/\/$/, '');
    if (url && !url.startsWith('http')) url = 'https://' + url;
    setTesting(true); setTestResult(null);
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${url}/api/songs`, { signal: controller.signal, cache: 'no-store' });
      clearTimeout(tid);
      if (res.ok) {
        (window as any).__CC_MAC_URL = url;
        localStorage.setItem('cc_mac_url', url);
        setMacUrl(url); setTestResult('ok');
        setTimeout(() => { setEditing(false); setTestResult(null); }, 1500);
      } else { setTestResult('fail'); }
    } catch { setTestResult('fail'); }
    finally { setTesting(false); }
  };

  const clear = () => {
    (window as any).__CC_MAC_URL = '';
    localStorage.removeItem('cc_mac_url');
    setMacUrl(''); setEditing(false);
  };

  if (editing) return (
    <div className="mx-5 mt-4 bg-blue-950/30 border border-blue-600/40 rounded-2xl px-4 py-3">
      <p className="text-[12px] font-black text-blue-300 mb-2">⚙️ Adresse du Mac</p>
      <input type="url" placeholder="https://192.168.x.x:8443" value={input}
        onChange={e => { setInput(e.target.value); setTestResult(null); }}
        className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2 text-[13px] text-white font-black mb-3" style={{ fontFamily: 'monospace' }}/>
      {testResult === 'fail' && <p className="text-[10px] text-red-400 font-black mb-2">❌ Mac non joignable</p>}
      {testResult === 'ok'   && <p className="text-[10px] text-emerald-400 font-black mb-2">✅ Mac connecté !</p>}
      <div className="flex gap-2">
        <button onClick={save} disabled={!input.trim() || testing} className="flex-1 py-2 bg-blue-600 rounded-xl font-black text-[12px] text-white uppercase active:scale-95 disabled:opacity-50">
          {testing ? 'Test...' : 'Connecter'}
        </button>
        <button onClick={() => setEditing(false)} className="px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-xl font-black text-[12px] text-zinc-400 active:scale-95">Annuler</button>
      </div>
    </div>
  );

  if (autoDetecting) return (
    <div className="mx-5 mt-4 bg-zinc-900/40 border border-zinc-800 rounded-2xl px-4 py-2 flex items-center gap-3">
      <span className="text-lg animate-pulse">💻</span>
      <p className="text-[11px] font-black text-zinc-500 uppercase tracking-widest">Détection Mac...</p>
    </div>
  );

  if (macUrl) return (
    <div className="mx-5 mt-4 bg-zinc-900/40 border border-zinc-800 rounded-2xl px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-emerald-400 text-[11px]">💻</span>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-black text-zinc-400 uppercase tracking-wider">Mac connecté</p>
          <p className="text-[9px] text-zinc-600 font-mono truncate">{macUrl}</p>
        </div>
        <button onClick={() => { setInput(macUrl); setEditing(true); }} className="px-2 py-1 rounded-lg text-[10px] font-black text-zinc-500 active:text-zinc-300">⚙️</button>
        <button onClick={clear} className="px-2 py-1 rounded-lg text-[10px] font-black text-red-800 active:text-red-400">✕</button>
      </div>
      <a href={`${macUrl}/api/songs`} target="_blank" rel="noopener noreferrer"
        className="block mt-2 text-center py-1.5 bg-blue-900/40 border border-blue-700/40 rounded-xl text-[10px] font-black text-blue-300 active:scale-95">
        🔒 Approuver le certificat SSL (1 fois requis)
      </a>
    </div>
  );

  return (
    <div className="mx-5 mt-4 bg-amber-950/30 border border-amber-600/30 rounded-2xl px-4 py-3 flex items-center gap-3">
      <span className="text-xl shrink-0">💻</span>
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-black text-amber-300">Mac non configuré</p>
        <p className="text-[10px] text-zinc-500 leading-relaxed">Même WiFi que ton Mac requis.</p>
      </div>
      <button onClick={() => { setInput(''); setEditing(true); }} className="shrink-0 px-3 py-2 bg-amber-600 rounded-xl font-black text-[11px] text-white uppercase active:scale-90">Configurer</button>
    </div>
  );
}

export default function SongSelector({
  songs, isOnline, isInstalled, httpsUrl, cachedSongs, cachedCount,
  cachingId, cacheProgress, cacheError, storage, storageWarning, pendingCount,
  cacheHealth, missingModules, repairProgress,
  onSelect, onInstall, onCache, onForceRefresh, onImportFile, onUncache, onClearAll,
  onViewRecordings, onClearCacheError, onRepairCache,
}: Props) {
  const [confirmUncache, setConfirmUncache]       = useState<string | null>(null);
  const [showRefreshMenu, setShowRefreshMenu]     = useState<string | null>(null);
  const [showImport, setShowImport]               = useState<string | null>(null);
  const [importing, setImporting]                 = useState<string | null>(null);
  const [importingLrc, setImportingLrc]           = useState<string | null>(null); // songId en cours d'import LRC

  const handleLrcImport = (song: Song, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportingLrc(song.id);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result as string;
        const lines: { time: number; text: string }[] = [];
        text.split('\n').forEach(line => {
          const m = line.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
          if (m) lines.push({ time: parseInt(m[1]) * 60 + parseFloat(m[2]), text: m[3].trim() });
        });
        if (lines.length === 0) { setImportingLrc(null); return; }
        const blob = new Blob([JSON.stringify(lines)], { type: 'application/json' });
        studioOfflineDB.saveAudio(`lrc_${song.id}`, blob, { songId: song.id, songTitle: song.title, type: 'lrc' })
          .then(() => { setImportingLrc(null); })
          .catch(() => { setImportingLrc(null); });
      } catch {
        setImportingLrc(null);
      }
    };
    reader.onerror = () => setImportingLrc(null);
    reader.readAsText(file);
    e.target.value = '';
  };
  // Cache status pour le panneau d'import: { inst: bool|null, vocal: bool|null }
  const [stemCacheStatus, setStemCacheStatus]     = useState<Record<string, { inst: boolean|null; vocal: boolean|null }>>({});
  const [testingAudio, setTestingAudio]           = useState<string | null>(null); // 'songId:inst' | 'songId:vocal'
  const audioTestRef                              = useRef<HTMLAudioElement | null>(null);
  const stemBlobCache                             = useRef<Record<string, Blob>>({});

  const handleFileImport = async (song: Song, type: 'inst' | 'vocal', e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(`${song.id}:${type}`);
    try {
      await onImportFile(song, type, file);
      // Pré-charger le blob fraîchement importé
      const fresh = await studioOfflineDB.getAudio(`${type}_${song.id}`).catch(() => null);
      if (fresh) stemBlobCache.current[`${type}_${song.id}`] = fresh;
      // Rafraîchir le statut cache après import
      const hasInst  = !!stemBlobCache.current[`inst_${song.id}`]  || await studioOfflineDB.hasAudio(`inst_${song.id}`).catch(() => false);
      const hasVocal = !!stemBlobCache.current[`vocal_${song.id}`] || await studioOfflineDB.hasAudio(`vocal_${song.id}`).catch(() => false);
      setStemCacheStatus(prev => ({ ...prev, [song.id]: { inst: hasInst, vocal: hasVocal } }));
    }
    finally { setImporting(null); e.target.value = ''; }
  };

  // Vérifie la présence réelle dans IndexedDB pour une chanson + pré-charge les blobs
  const checkStemCache = async (songId: string) => {
    setStemCacheStatus(prev => ({ ...prev, [songId]: { inst: null, vocal: null } }));
    const [instBlob, vocalBlob] = await Promise.all([
      studioOfflineDB.getAudio(`inst_${songId}`).catch(() => null),
      studioOfflineDB.getAudio(`vocal_${songId}`).catch(() => null),
    ]);
    if (instBlob)  stemBlobCache.current[`inst_${songId}`]  = instBlob;
    if (vocalBlob) stemBlobCache.current[`vocal_${songId}`] = vocalBlob;
    setStemCacheStatus(prev => ({ ...prev, [songId]: { inst: !!instBlob, vocal: !!vocalBlob } }));
  };

  // Lit un stem directement depuis IndexedDB pour le tester
  const testStemAudio = (songId: string, type: 'inst' | 'vocal') => {
    const key    = `${songId}:${type}`;
    const dbKey  = `${type}_${songId}`;

    // Stop si déjà en lecture
    if (testingAudio === key) {
      audioTestRef.current?.pause();
      if (audioTestRef.current?.src) URL.revokeObjectURL(audioTestRef.current.src);
      audioTestRef.current = null;
      setTestingAudio(null);
      return;
    }

    // Utiliser le blob pré-chargé — SYNCHRONE, pas de .then()
    const blob = stemBlobCache.current[dbKey];
    if (!blob) {
      // Blob pas encore chargé — tenter le chargement et réessayer
      studioOfflineDB.getAudio(dbKey).then(b => {
        if (b) { stemBlobCache.current[dbKey] = b; }
      }).catch(() => {});
      return;
    }

    // Tout synchrone dans le callstack du tap — iOS l'accepte
    audioTestRef.current?.pause();
    if (audioTestRef.current?.src) URL.revokeObjectURL(audioTestRef.current.src);

    const url   = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audioTestRef.current = audio;
    setTestingAudio(key);

    // Résumer le contexte audio global si nécessaire
    const ctx = (window as any).__warmContext as AudioContext | undefined;
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});

    audio.onended = () => { setTestingAudio(null); URL.revokeObjectURL(url); audioTestRef.current = null; };
    audio.onerror = (e) => { setTestingAudio(null); URL.revokeObjectURL(url); audioTestRef.current = null; };
    audio.play().catch((e) => {
      // Fallback via AudioContext si play() bloqué
      const actx = (window as any).__warmContext as AudioContext | undefined;
      if (!actx) { setTestingAudio(null); return; }
      blob.arrayBuffer().then(buf => actx.decodeAudioData(buf)).then(decoded => {
        const src = actx.createBufferSource();
        src.buffer = decoded;
        src.connect(actx.destination);
        src.onended = () => { setTestingAudio(null); audioTestRef.current = null; };
        src.start(0);
      }).catch(() => setTestingAudio(null));
    });
  };

  // Cleanup audio au démontage
  useEffect(() => { return () => { audioTestRef.current?.pause(); }; }, []);

  const progressColor = (progress: CacheProgress | null) => {
    if (!progress) return '#22c55e';
    if (progress.step === 'inst_convert' || progress.step === 'vocal_convert') return '#f97316';
    if (progress.step === 'done') return '#22c55e';
    return '#3b82f6';
  };

  return (
    <div className="min-h-screen bg-[#020202] text-white flex flex-col">

      {/* Header */}
      <div className="shrink-0 px-5 pt-6 pb-4 border-b border-zinc-900">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-red-600 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(220,38,38,0.4)]">
              <Mic size={16} className="text-white"/>
            </div>
            <div>
              <p className="font-bebas text-2xl text-white tracking-widest leading-none">BUNKER STUDIO</p>
              <p className="text-[9px] text-zinc-600 font-black uppercase tracking-widest">Multi-piste mobile</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Compteur chansons hors-ligne */}
            {cachedCount > 0 && (
              <div className="flex items-center gap-1 px-2 py-1 bg-emerald-900/20 border border-emerald-600/20 rounded-full">
                <HardDrive size={9} className="text-emerald-500"/>
                <span className="text-[9px] font-black text-emerald-400">{cachedCount}/{songs.length}</span>
              </div>
            )}
            <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[9px] font-black uppercase ${isOnline ? 'bg-emerald-900/30 text-emerald-400' : 'bg-zinc-900 text-zinc-600'}`}>
              {isOnline ? <Wifi size={10}/> : <WifiOff size={10}/>}
              {isOnline ? 'WiFi' : 'Hors-ligne'}
            </div>

            {/* Indicateur santé du cache — visible si incomplet */}
            {cacheHealth === 'incomplete' && (
              <button
                onClick={onRepairCache}
                className="flex items-center gap-1.5 px-2 py-1 rounded-full active:scale-90 transition-all"
                style={{ background: '#7c2d1220', border: '1px solid #dc262640' }}>
                <span className="text-[9px]">⚠️</span>
                <span className="text-[9px] font-black text-amber-500 uppercase">{missingModules} module{missingModules > 1 ? 's' : ''} manquant{missingModules > 1 ? 's' : ''}</span>
              </button>
            )}
            {cacheHealth === 'repairing' && (
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-full" style={{ background: '#1e3a5f' }}>
                <span className="text-[9px]">🔧</span>
                <span className="text-[9px] font-black text-blue-400 uppercase">Réparation {repairProgress}%</span>
              </div>
            )}
            {cacheHealth === 'ok' && missingModules === 0 && (
              <div className="flex items-center gap-1 px-1.5 py-1 rounded-full" style={{ background: '#14532d20' }}>
                <CheckCircle2 size={9} className="text-emerald-600"/>
              </div>
            )}

            {pendingCount > 0 && (
              <button onClick={onViewRecordings} className="flex items-center gap-1.5 bg-red-900/30 border border-red-600/30 px-2 py-1 rounded-full active:scale-90 transition-all">
                <Radio size={10} className="text-red-500 animate-pulse"/>
                <span className="text-[9px] font-black text-red-400 uppercase">{pendingCount}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* MAC URL CONFIG */}
      <MacUrlConfig />

      {/* HTTPS warning */}
      {window.location.protocol === 'http:' && httpsUrl && (
        <div className="mx-5 mt-4 bg-amber-950/30 border border-amber-600/40 rounded-2xl px-4 py-3">
          <p className="text-[12px] font-black text-amber-400 mb-1">⚠️ Micro bloqué — Safari exige HTTPS</p>
          <a href={httpsUrl} className="block text-center py-2 bg-amber-600 rounded-xl font-black text-[12px] text-white uppercase tracking-widest">
            🔒 Ouvrir en HTTPS
          </a>
          <p className="text-[10px] text-zinc-600 mt-1.5 text-center">Accepte le certificat → "Continuer quand même"</p>
        </div>
      )}

      {/* Bannière PWA */}
      {!isInstalled ? (
        <div className="mx-5 mt-4 bg-red-950/30 border border-red-600/30 rounded-2xl px-4 py-3 flex items-center gap-3">
          <div className="w-10 h-10 bg-red-600 rounded-xl flex items-center justify-center shrink-0"><span className="text-xl">🎤</span></div>
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-black text-white">Installer l'app sur iPhone</p>
            <p className="text-[10px] text-zinc-400 mt-0.5">Hors-ligne, micro, enregistrements</p>
          </div>
          <button onClick={onInstall} className="shrink-0 px-3 py-2 bg-red-600 rounded-xl font-black text-[11px] uppercase text-white active:scale-90 transition-all">
            Installer
          </button>
        </div>
      ) : (
        <div className="mx-5 mt-4 bg-emerald-950/30 border border-emerald-600/30 rounded-2xl px-4 py-2 flex items-center gap-2">
          <CheckCircle2 size={14} className="text-emerald-500 shrink-0"/>
          <p className="text-[11px] text-emerald-400 font-black">App installée — fonctionne hors-ligne ✓</p>
        </div>
      )}

      {/* Panneau de stockage iPhone */}
      {storage && (
        <div className={`mx-5 mt-3 rounded-2xl px-4 py-3 border ${storageWarning ? 'bg-red-950/30 border-red-600/40' : 'bg-zinc-900/40 border-zinc-800'}`}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              {storageWarning ? <AlertTriangle size={11} className="text-red-400"/> : <HardDrive size={11} className="text-zinc-500"/>}
              <p className={`text-[10px] font-black uppercase tracking-widest ${storageWarning ? 'text-red-400' : 'text-zinc-500'}`}>
                {storageWarning ? '⚠️ Stockage presque plein' : 'Stockage iPhone'}
              </p>
            </div>
            <p className={`text-[10px] font-black ${storageWarning ? 'text-red-400' : 'text-zinc-400'}`}>
              {formatMB(storage.quota - storage.used)} libre
            </p>
          </div>

          {/* Barre principale iPhone */}
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden mb-2">
            <div
              className={`h-full rounded-full transition-all duration-500 ${storageWarning ? 'bg-red-500' : storage.pct > 70 ? 'bg-amber-500' : 'bg-emerald-500'}`}
              style={{ width: `${Math.min(storage.pct, 100)}%` }}/>
          </div>

          {/* Détail chiffres */}
          <div className="flex justify-between text-[9px] font-black mb-2">
            <span className="text-zinc-600">App: <span className="text-zinc-400">{formatMB(storage.used)}</span></span>
            <span className="text-zinc-600">Quota: <span className="text-zinc-400">{formatMB(storage.quota)}</span></span>
            <span className="text-zinc-600">Libre: <span className={storageWarning ? 'text-red-400' : 'text-emerald-400'}>{formatMB(storage.quota - storage.used)}</span></span>
          </div>

          {/* Conseil si faible espace */}
          {storageWarning && (
            <div className="bg-red-950/40 rounded-xl px-3 py-2 mb-2">
              <p className="text-[9px] text-red-300 leading-relaxed">
                💡 Libère de l'espace dans <span className="font-black">Réglages → Général → Stockage iPhone</span> pour éviter les blocages durant l'enregistrement.
              </p>
            </div>
          )}

          {/* Boutons libérer */}
          <div className="flex gap-2">
            {storageWarning && (
              <button onClick={onClearAll} className="flex-1 py-1.5 bg-red-900/30 border border-red-600/40 rounded-xl text-[10px] font-black text-red-400 uppercase active:scale-95">
                🗑 Vider cache ({cachedSongs.size} chansons)
              </button>
            )}
            <button
              onClick={async () => { await studioOfflineDB.clearOldRecordings?.(5); }}
              className="flex-1 py-1.5 bg-zinc-800 border border-zinc-700 rounded-xl text-[10px] font-black text-zinc-400 uppercase active:scale-95">
              🎙 Nettoyer vieilles prises
            </button>
          </div>
        </div>
      )}

      {/* Liste chansons */}
      <div className="flex-1 overflow-y-auto px-5 pt-5 pb-28" style={{ WebkitOverflowScrolling: 'touch' }}>
        <p className="text-[10px] text-zinc-600 font-black uppercase tracking-widest mb-4">
          {songs.length} chanson{songs.length > 1 ? 's' : ''} · {cachedCount} hors-ligne
        </p>

        {songs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-4 opacity-30">
            <Music size={48} className="text-zinc-700"/>
            <p className="text-[12px] text-zinc-600 font-black uppercase text-center">Aucune chanson originale</p>
          </div>
        ) : (
          <div className="space-y-3">
            {songs.map(s => {
              const hasProject   = studioService.getProjects().some(p => p.songId === s.id && p.tracks.length > 0);
              const isCached     = cachedSongs.has(s.id);
              const isCaching    = cachingId === s.id;
              const hasError     = cacheError?.songId === s.id;
              const needsConfirm = confirmUncache === s.id;
              const showMenu     = showRefreshMenu === s.id;
              const progress     = isCaching ? cacheProgress : null;
              const isConverting = progress?.step === 'inst_convert' || progress?.step === 'vocal_convert';

              return (
                <div key={s.id} className="relative">
                  <div
                    role="button"
                    tabIndex={0}
                    onPointerDown={(e) => {
                      // Ignorer si la cible est un bouton/label/input imbriqué
                      const tag = (e.target as HTMLElement).closest('button, label, input, a');
                      if (tag) return;
                      if (showMenu) { setShowRefreshMenu(null); return; }
                      if (showImport === s.id) { setShowImport(null); return; }
                      if (!isCaching && !hasError) onSelect(s);
                    }}
                    className={`w-full flex items-center gap-4 p-4 bg-zinc-900/60 border rounded-2xl transition-all text-left cursor-pointer select-none ${
                      isCaching   ? 'border-blue-600/30 cursor-default' :
                      hasError    ? 'border-red-600/30' :
                      showMenu    ? 'border-zinc-600' :
                      'border-zinc-800 active:scale-[0.98] hover:border-zinc-700'
                    }`}>

                    {/* Pochette */}
                    {s.posterUrl
                      ? <img src={s.posterUrl} className="w-14 h-14 rounded-xl object-cover shrink-0" loading="lazy"/>
                      : <div className="w-14 h-14 rounded-xl bg-zinc-800 flex items-center justify-center shrink-0"><Music size={22} className="text-zinc-600"/></div>
                    }

                    {/* Infos */}
                    <div className="flex-1 min-w-0">
                      <p className="text-[15px] font-black text-white truncate">{s.title}</p>
                      <p className="text-[11px] text-zinc-500 truncate mt-0.5">{s.artist}</p>
                      {s.tempo && !isCaching && !hasError && (
                        <p className="text-[10px] text-zinc-700 font-black uppercase mt-1">{s.tempo} BPM · {s.key}</p>
                      )}

                      {/* État normal */}
                      {!isCaching && !hasError && (
                        <div className="flex items-center gap-2 mt-1">
                          {hasProject && <p className="text-[10px] text-red-400 font-black">🎛 Projet en cours</p>}
                          {isCached   && <p className="text-[10px] text-emerald-500 font-black">✓ Hors-ligne</p>}
                        </div>
                      )}

                      {/* ── Progression ── */}
                      {isCaching && progress && (
                        <div className="mt-2">
                          <div className="flex items-center gap-1.5 mb-1.5">
                            {isConverting
                              ? <RefreshCw size={10} className="text-orange-400 animate-spin shrink-0"/>
                              : progress.step === 'done'
                              ? <CheckCircle2 size={10} className="text-emerald-400 shrink-0"/>
                              : <ArrowDownToLine size={10} className="text-blue-400 shrink-0"/>
                            }
                            <p className={`text-[11px] font-black truncate ${
                              isConverting ? 'text-orange-400' :
                              progress.step === 'done' ? 'text-emerald-400' : 'text-blue-400'
                            }`}>{progress.label}</p>
                            <p className="text-[10px] text-zinc-600 ml-auto shrink-0">{progress.pct}%</p>
                          </div>
                          <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div className="h-full rounded-full transition-all duration-300"
                              style={{ width: `${progress.pct}%`, background: progressColor(progress) }}/>
                          </div>
                          {isConverting && (
                            <p className="text-[9px] text-orange-500/70 mt-1 font-black uppercase tracking-widest">
                              Conversion FLAC → MP3 pour iPhone
                            </p>
                          )}
                        </div>
                      )}

                      {/* ── Erreur + Réessayer ── */}
                      {hasError && (
                        <div className="mt-2">
                          <div className="flex items-center gap-1.5 mb-2">
                            <AlertCircle size={11} className="text-red-400 shrink-0"/>
                            <p className="text-[11px] text-red-400 font-black truncate">{cacheError!.message}</p>
                          </div>
                          <button
                            onClick={e => { e.stopPropagation(); onClearCacheError(); onCache(s); }}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 rounded-xl text-[11px] font-black text-white uppercase active:scale-95">
                            <RotateCcw size={11}/> Réessayer
                          </button>
                        </div>
                      )}

                      {/* ── Menu actualiser ── */}
                      {showMenu && isCached && !isCaching && (
                        <div className="mt-2 flex gap-2">
                          <button
                            onClick={e => { e.stopPropagation(); setShowRefreshMenu(null); onForceRefresh(s); }}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-700 rounded-xl text-[11px] font-black text-white active:scale-95">
                            <RefreshCw size={11}/> Actualiser les stems
                          </button>
                          <button
                            onClick={e => { e.stopPropagation(); setShowRefreshMenu(null); onUncache(s.id); }}
                            className="px-3 py-1.5 bg-red-900/40 border border-red-700/40 rounded-xl text-[11px] font-black text-red-400 active:scale-95">
                            🗑 Effacer le lien
                          </button>
                        </div>
                      )}
                    </div>

                    {/* ── Boutons droite ── */}
                    <div className="shrink-0 flex flex-col items-center gap-2">
                      <div className="w-10 h-10 rounded-full bg-red-600/20 border border-red-600/30 flex items-center justify-center">
                        <Mic size={16} className="text-red-500"/>
                      </div>

                      {isCaching ? (
                        <div className="w-10 h-10 rounded-full bg-blue-900/30 border border-blue-600/30 flex items-center justify-center">
                          {isConverting
                            ? <RefreshCw size={14} className="text-orange-400 animate-spin"/>
                            : <Loader2 size={14} className="animate-spin text-blue-400"/>
                          }
                        </div>

                      ) : hasError ? (
                        <div className="w-10 h-10 rounded-full bg-red-900/30 border border-red-600/30 flex items-center justify-center">
                          <AlertCircle size={14} className="text-red-400"/>
                        </div>

                      ) : isCached ? (
                        showMenu ? (
                          <button
                            onClick={e => { e.stopPropagation(); setShowRefreshMenu(null); }}
                            className="w-10 h-10 rounded-full bg-zinc-700 flex items-center justify-center active:scale-90">
                            <RefreshCw size={14} className="text-white"/>
                          </button>
                        ) : needsConfirm ? (
                          <button
                            onClick={e => { e.stopPropagation(); onUncache(s.id); setConfirmUncache(null); }}
                            className="w-10 h-10 rounded-full bg-red-600 flex items-center justify-center active:scale-90 transition-all">
                            <Trash2 size={13} className="text-white"/>
                          </button>
                        ) : (
                          // Long press → menu, tap normal → confirm suppression
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              setShowRefreshMenu(s.id);
                              setTimeout(() => setShowRefreshMenu(null), 5000);
                            }}
                            className="w-10 h-10 rounded-full bg-emerald-900/30 border border-emerald-500/50 flex items-center justify-center active:scale-90 transition-all">
                            <CheckCircle2 size={14} className="text-emerald-400"/>
                          </button>
                        )
                      ) : (
                        <div className="flex flex-col items-center gap-2">
                          <button
                            onClick={e => { e.stopPropagation(); onCache(s); }}
                          disabled={!isOnline}
                          title={isOnline ? 'Télécharger pour hors-ligne' : 'Hors-ligne — impossible'}
                          className={`w-10 h-10 rounded-full flex items-center justify-center transition-all active:scale-90 border ${
                            !isOnline ? 'bg-zinc-900 border-zinc-800 opacity-30' : 'bg-zinc-800 border-zinc-700 hover:border-zinc-500'
                          }`}>
                          <Download size={14} className="text-zinc-500"/>
                        </button>
                          <button
                            onClick={e => { e.preventDefault(); e.stopPropagation(); const next = showImport === s.id ? null : s.id; setShowImport(next); if (next) checkStemCache(next); }}
                          className="w-10 h-10 rounded-full flex items-center justify-center active:scale-90 border bg-zinc-900 border-zinc-800">
                          <span className="text-[15px]">📁</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Import depuis Fichiers */}
                  {showImport === s.id && !isCaching && (() => {
                    const _inst  = s.versions?.find((v: any) => v.trackType === 'Instrumental Stem (Export ZIP)' || (v.trackType === TrackType.STEM_INSTRUMENTAL || v.trackType === 'Instrumental Stem (Export ZIP)' || v.trackType === 'Instrumentale Pure (Copie IA)'));
                    const _vocal = s.versions?.find((v: any) => v.trackType === 'Vocal Stem (Export ZIP)'        || v.trackType === TrackType.STEM_VOCAL);
                    const _iName = _inst?.fileName  || null;
                    const _vName = _vocal?.fileName || null;
                    const cst    = stemCacheStatus[s.id];
                    const iHas   = cst ? cst.inst   : null;
                    const vHas   = cst ? cst.vocal  : null;
                    return (
                      <div className="mx-1 mb-2 bg-zinc-900/90 border border-zinc-700 rounded-2xl px-4 py-3" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between mb-3">
                          <p className="text-[11px] font-black text-zinc-300 uppercase tracking-widest">📁 Stems — {s.title}</p>
                          <div className="flex items-center gap-2">
                            <button onClick={e => { e.stopPropagation(); checkStemCache(s.id); }} className="text-[9px] text-zinc-500 font-black active:text-zinc-300 border border-zinc-700 px-2 py-1 rounded-lg">↺ Vérifier</button>
                            <button onClick={e => { e.stopPropagation(); setShowImport(null); }} className="text-[10px] text-zinc-600 font-black active:text-zinc-400">✕</button>
                          </div>
                        </div>
                        <StemRow
                          songId={s.id} type="inst" fileName={_iName} inCache={iHas}
                          importing={importing} testingAudio={testingAudio}
                          onTest={testStemAudio}
                          onImport={e => handleFileImport(s, 'inst', e)}
                        />
                        <StemRow
                          songId={s.id} type="vocal" fileName={_vName} inCache={vHas}
                          importing={importing} testingAudio={testingAudio}
                          onTest={testStemAudio}
                          onImport={e => handleFileImport(s, 'vocal', e)}
                        />

                        {/* Import LRC */}
                        <div className="mt-2 pt-3 border-t border-zinc-800">
                          <div className="flex items-center gap-1.5 mb-2">
                            <span className="text-[9px] font-black uppercase tracking-widest text-zinc-500">🎵 Paroles synchronisées (.lrc)</span>
                          </div>
                          <label className="block">
                            <input type="file" accept=".lrc,.txt" className="hidden" onChange={e => handleLrcImport(s, e)}/>
                            <span className={`flex items-center justify-center gap-2 py-2 rounded-xl font-black text-[11px] uppercase active:scale-95 cursor-pointer transition-all ${
                              importingLrc === s.id ? 'bg-zinc-700 text-zinc-400' : 'bg-purple-900/60 border border-purple-600/40 text-purple-300'
                            }`}>
                              {importingLrc === s.id ? '⏳ Import...' : '📄 Importer fichier .lrc'}
                            </span>
                          </label>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Tooltip confirmation suppression */}
                  {needsConfirm && !showMenu && (
                    <div className="absolute right-4 -bottom-7 z-10 bg-red-900 border border-red-600 px-2 py-1 rounded-lg">
                      <p className="text-[9px] text-red-200 font-black uppercase">Appuie encore pour supprimer</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Bouton bas — mes enregistrements */}
      {studioService.getProjects().length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-[#020202]/95 backdrop-blur border-t border-zinc-900">
          <button
            onClick={onViewRecordings}
            className="w-full py-4 bg-zinc-900 border border-zinc-700 rounded-2xl font-black text-[13px] uppercase tracking-widest text-white flex items-center justify-center gap-3 active:scale-95 transition-all">
            <Radio size={16} className="text-red-500"/>
            Mes enregistrements
            {pendingCount > 0 && (
              <span className="bg-red-600 text-white text-[10px] px-2 py-0.5 rounded-full">{pendingCount} à transférer</span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
