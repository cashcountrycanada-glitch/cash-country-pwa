/**
 * MixerScreen.tsx — v3 : Mixer visuel complet
 *
 * NOUVEAUTÉS :
 * - Section harmonies refaite : clavier visuel des 5 couches avec relation musicale
 * - Génération individuelle par harmonie (pas juste "tout régénérer")
 * - Waveform sur chaque piste générée
 * - Stack visuel des pistes empilées (vue timeline)
 * - Durée totale du projet dans le header
 * - Waveform du mix final après mixage
 * - Indicateur de niveau par piste dans la vue stack
 */
import React, { useState, useEffect } from 'react';
import {
  ChevronLeft, Plus, Layers, Scissors, Loader2, CheckCircle2,
  Send, Pause, Play, Sparkles, Music2, RefreshCw, BarChart2, Download, Shield,
} from 'lucide-react';
import { MobileRecording, TrackProject, Take, studioService } from '../../services/StudioService';
import { studioOfflineDB } from '../../services/StudioOfflineDB';
import { Song } from '../../types';
import { TRACK_PRESETS, formatTime, SectionMarker, SectionLabel, SECTION_LABELS, SECTION_COLORS } from './studio.types';
import TrackCard from './TrackCard';
import WaveformBar from './WaveformBar';

interface Props {
  selected:    Song;
  project:     TrackProject;
  playingId:   string | null;
  isMixing:    boolean;
  mixProgress: number;
  mixLabel:    string;
  mixDone:     boolean;
  isOnline:    boolean;
  uploading:   string | null;
  uploadDone:  string | null;
  playRef:     React.RefObject<HTMLAudioElement>;
  onBack:          () => void;
  onGoSongs:       () => void;
  onAddTrack:      () => void;
  onPlay:          (rec: MobileRecording) => void;
  onMute:          (trackIndex: number, muted: boolean) => void;
  onSolo:          (trackIndex: number) => void;
  onVolume:        (trackIndex: number, gain: number) => void;
  onPan:           (trackIndex: number, pan: number) => void;
  onDelete:        (trackIndex: number) => void;
  onMix:           (layerIds: string[]) => void;
  onPlayMix:       () => void;
  onMasterize:     (vocalBlob: Blob, instBlob: Blob | null) => void;
  onUploadMix:     () => void;
  onGoComp:        (takes: Take[]) => void;
  onProjectUpdate: (project: TrackProject) => void;
  instBlob:        Blob | null;
  takeSlot:        'A' | 'B' | 'C';
}

// Définition des harmonies avec info musicale
const HARMONY_DEFS = [
  { trackIndex: 1, label: 'Double',    pitch:  0,  color: '#f97316', emoji: '🎵', musicNote: 'Unisson',   desc: 'Épaissit la voix' },
  { trackIndex: 2, label: '+3',        pitch:  3,  color: '#eab308', emoji: '🎶', musicNote: 'Tierce m.', desc: 'Harmonie douce' },
  { trackIndex: 3, label: '+7',        pitch:  7,  color: '#22c55e', emoji: '🎼', musicNote: 'Quinte',    desc: 'Harmonie forte' },
  { trackIndex: 4, label: 'Oct ↓',    pitch: -12, color: '#3b82f6', emoji: '🔉', musicNote: 'Octave -1', desc: 'Voix grave' },
  { trackIndex: 5, label: '+5',        pitch:  5,  color: '#a855f7', emoji: '✨', musicNote: 'Quarte',    desc: 'Harmonie riche' },
];

export default function MixerScreen({
  selected, project, playingId, isMixing, mixProgress, mixLabel, mixDone, isOnline,
  uploading, uploadDone, playRef,
  onBack, onGoSongs, onAddTrack, onPlay, onMute, onSolo, onVolume, onPan,
  onDelete, onMix, onPlayMix, onMasterize, onUploadMix, onGoComp,
  onProjectUpdate, instBlob, takeSlot,
}: Props) {
  const [generatingIndex, setGeneratingIndex] = useState<number | null>(null);
  const [backupDone, setBackupDone]           = useState(false);
  const [autoBackupDone, setAutoBackupDone]   = useState(false);
  const [showRecovery, setShowRecovery]       = useState(false);
  const [recoveryItems, setRecoveryItems]     = useState<{key: string; label: string; size: number; date: string}[]>([]);
  const [recovering, setRecovering]           = useState<string | null>(null);
  const [exportingVoice, setExportingVoice]   = useState(false);
  const [layerSlots, setLayerSlots]           = useState<Set<string>>(new Set());
  const [generateLabel, setGenerateLabel]     = useState('');
  const [generatePct, setGeneratePct]         = useState(0);
  const [generatedDone, setGeneratedDone]     = useState<Set<number>>(new Set());
  const [mixWaveform, setMixWaveform]         = useState<number[]>([]);
  const [showStack, setShowStack]             = useState(false);
  const [showSections, setShowSections]       = useState(false);
  const [sections, setSections]               = useState<SectionMarker[]>(
    (project as any).sections || []
  );

  const tracks    = project?.tracks || [];
  // mainVoice = la voix du slot actif en priorité, sinon premier non-muté
  // slotVoices = une prise par slot (dédupliqué — garder la plus récente par takeSlot)
  const slotVoices = React.useMemo(() => {
    const all = tracks.filter(t => t.trackIndex === 0 && !(t as any).isGenerated);
    const bySlot = new Map<string, typeof all[0]>();
    for (const t of all) {
      const slot = t.takeSlot ?? 'A';
      const existing = bySlot.get(slot);
      // Garder la plus récente (recordedAt)
      if (!existing || (t.recordedAt ?? 0) > (existing.recordedAt ?? 0)) {
        bySlot.set(slot, t);
      }
    }
    return Array.from(bySlot.values());
  }, [tracks]);
  const mainVoice  = slotVoices.find(t => t.takeSlot === takeSlot && t.dataUrl)  // slot actif avec data ← PRIORITÉ
    ?? slotVoices.find(t => t.takeSlot === takeSlot)                               // slot actif sans data encore
    ?? slotVoices.find(t => !t.muted && t.dataUrl)                                 // non-muté avec data
    ?? slotVoices.find(t => t.dataUrl)                                             // premier avec data
    ?? slotVoices.find(t => !t.muted)                                              // non-muté sans data
    ?? slotVoices[0];                                                               // premier quoi qu'il arrive
  const totalDuration = mainVoice?.duration || Math.max(...tracks.map(t => t.duration), 0);

  // Charger la waveform du mix dès qu'il est prêt
  // mixedDataUrl peut être une blob: URL (URL.createObjectURL) ou une data: URL legacy
  useEffect(() => {
    if (!mixDone || !project.mixedDataUrl || mixWaveform.length > 0) return;
    const url = project.mixedDataUrl;
    if (url.startsWith('blob:')) {
      // Blob URL → fetch le blob puis analyser
      fetch(url)
        .then(r => r.blob())
        .then(blob => studioService.blobToDataUrl(blob))
        .then(dataUrl => studioService.analyzeWaveform(dataUrl, 100))
        .then(setMixWaveform)
        .catch(() => {});
    } else {
      studioService.analyzeWaveform(url, 100)
        .then(setMixWaveform)
        .catch(() => {});
    }
  }, [mixDone, project.mixedDataUrl]);

  // Préchargement actif du cache audio — remplace le polling passif qui bloquait après réouverture
  const [audioCacheReady, setAudioCacheReady] = React.useState(false);
  const [audioCacheError, setAudioCacheError] = React.useState(false);
  useEffect(() => {
    if (!mainVoice) return;
    // Si déjà en cache (même session), prêt immédiatement
    const already = !!(window as any).__lastRecDecodedBuf &&
                    (window as any).__lastRecDecodedId === mainVoice.id;
    if (already) { setAudioCacheReady(true); return; }
    // Sinon déclencher le chargement actif depuis OPFS/IDB
    setAudioCacheReady(false);
    setAudioCacheError(false);
    studioService.warmAudioCache(mainVoice).then(ok => {
      if (ok) setAudioCacheReady(true);
      else setAudioCacheError(true);
    });
  }, [mainVoice?.id]);


  const handleTrackUpdate = (updated: MobileRecording) => {
    const newTracks = project.tracks.map(t =>
      t.trackIndex === updated.trackIndex ? updated : t
    );
    onProjectUpdate({ ...project, tracks: newTracks });
  };

  const handleGoComp = () => {
    const takes: Take[] = tracks.map(t => ({ id: t.id, recording: t, regions: t.regions || [] }));
    onGoComp(takes);
  };

  // Backup automatique silencieux dans IndexedDB — clé séparée backup_voice_xxx
  const autoBackupToIndexedDB = async (voice: MobileRecording) => {
    if (!voice) return;
    try {
      // Récupérer le blob source (dataUrl ou IndexedDB)
      let blob: Blob | null = null;
      // resolveBlobAsync gère data:, blob:, opfs: et les clés IDB
      if (voice.dataUrl) {
        blob = await studioService.resolveBlobAsync(voice.dataUrl);
      }
      if (!blob || blob.size < 1000) {
        blob = await studioOfflineDB.getAudio(`rec_${voice.id}`);
      }
      if (!blob || blob.size < 1000) return;
      // Sauvegarder sous une clé backup_ séparée
      const backupKey = `backup_voice_${voice.id}`;
      await studioOfflineDB.saveAudio(backupKey, blob, {
        type: 'voice_backup',
        songId: voice.songId,
        songTitle: voice.songTitle,
        originalId: voice.id,
        backedUpAt: Date.now(),
      });
      setAutoBackupDone(true);
      console.log(`[Backup] ✅ Voix sauvegardée automatiquement: ${backupKey} (${(blob.size/1024).toFixed(0)} KB)`);
    } catch (e) {
      console.warn('[Backup] Erreur backup automatique:', e);
    }
  };

  // Charger tous les backups disponibles dans IndexedDB
  const loadRecoveryItems = async () => {
    try {
      const keys = await studioOfflineDB.listAllAudioKeys();
      const backupKeys = keys.filter(k => k.startsWith('backup_voice_') || k.startsWith('rec_'));
      const items = await Promise.all(backupKeys.map(async key => {
        try {
          const blob = await studioOfflineDB.getAudio(key);
          const isBackup = key.startsWith('backup_voice_');
          const id = key.replace('backup_voice_', '').replace('rec_', '');
          // Trouver les métadonnées dans le projet
          const allProjects = studioService.getProjects();
          const track = allProjects.flatMap(p => p.tracks).find(t => t.id === id);
          const label = track
            ? `${isBackup ? '🛡 Backup' : '🎙 Prise'} — ${track.songTitle} (${new Date(track.recordedAt).toLocaleDateString('fr-CA')} ${new Date(track.recordedAt).toLocaleTimeString('fr-CA', {hour:'2-digit',minute:'2-digit'})})`
            : `${isBackup ? '🛡 Backup' : '🎙 Prise'} — ${id.slice(-8)}`;
          return { key, label, size: blob?.size || 0, date: track ? new Date(track.recordedAt).toISOString() : '' };
        } catch { return null; }
      }));
      setRecoveryItems(items.filter(Boolean).filter(i => i!.size > 1000).sort((a,b) => b!.date.localeCompare(a!.date)) as any);
    } catch (e) { console.warn('Recovery load error:', e); }
  };

  // Restaurer un backup comme nouvelle voix principale
  const restoreFromBackup = async (key: string) => {
    setRecovering(key);
    try {
      const blob = await studioOfflineDB.getAudio(key);
      if (!blob || blob.size < 1000) { alert('Backup vide ou corrompu.'); return; }
      const dataUrl = await studioService.blobToDataUrl(blob);
      const id = `REC-RESTORED-${Date.now()}`;
      const rec: MobileRecording = {
        id, songId: selected.id, songTitle: selected.title,
        artist: (selected as any).artist || '',
        duration: 0, recordedAt: Date.now(), dataUrl,
        transferred: false,
        fileName: `RESTORED_${selected.title.replace(/\s+/g,'_')}_${Date.now()}.mp4`,
        trackIndex: 0, trackLabel: 'Voix principale (restaurée)',
        takeSlot: 'A', projectId: project.id,
      };
      await studioService.saveRecordingLocallyAsync(rec);
      onProjectUpdate(studioService.addTrackToProject(project.id, rec) || project);
      setShowRecovery(false);
      alert('✅ Voix restaurée dans le slot A !');
    } catch (e: any) { const isQ = e?.message?.toLowerCase().includes('quota'); if (!isQ) alert('Erreur restauration : ' + e.message); }
    finally { setRecovering(null); }
  };

  // Backup de la voix principale — export fichier audio directement
  // (localStorage trop limité pour les blobs audio sur iOS)
  const backupMainVoice = async () => {
    if (!mainVoice?.dataUrl) return;
    try {
      const res  = await fetch(mainVoice.dataUrl);
      const blob = await res.blob();
      const safeTitle = (mainVoice.songTitle || 'voix').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
      const ext  = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('mpeg') ? 'mp3' : 'wav';
      const ts   = new Date().toISOString().slice(0,16).replace('T','_').replace(':','h');
      const fileName = `BACKUP_${safeTitle}_${ts}.${ext}`;
      const file = new File([blob], fileName, { type: blob.type });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: `Backup — ${mainVoice.songTitle}`, files: [file] });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = fileName; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
      setBackupDone(true);
      setTimeout(() => setBackupDone(false), 4000);
    } catch (e: any) {
      if (!e.message?.includes('cancel') && e.name !== 'AbortError')
        const isQ = e?.message?.toLowerCase().includes('quota'); if (!isQ) alert('Erreur backup : ' + e.message);
    }
  };

  // Export audio de la voix principale vers iPhone
  const exportMainVoice = async () => {
    if (!mainVoice?.dataUrl || exportingVoice) return;
    setExportingVoice(true);
    try {
      const res  = await fetch(mainVoice.dataUrl);
      const blob = await res.blob();
      const safeTitle = (mainVoice.songTitle || 'voix').replace(/[^a-zA-Z0-9]/g, '_');
      const ext  = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('mpeg') ? 'mp3' : 'wav';
      const fileName = `${safeTitle}_VOIX_PRINCIPALE.${ext}`;
      const file = new File([blob], fileName, { type: blob.type });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: fileName, files: [file] });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = fileName; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
    } catch (e: any) {
      if (!e.message?.includes('cancel') && !e.message?.toLowerCase().includes('quota')) alert('Erreur export : ' + e.message);
    } finally { setExportingVoice(false); }
  };

  // Générer une harmonie individuelle
  const generateOne = async (harmonyDef: typeof HARMONY_DEFS[0]) => {
    if (!mainVoice || generatingIndex !== null) return;
    // Backup automatique silencieux avant génération
    autoBackupToIndexedDB(mainVoice);
    setGeneratingIndex(harmonyDef.trackIndex);
    setGeneratePct(0);
    setGenerateLabel(`${harmonyDef.emoji} ${harmonyDef.label}...`);

    try {
      // Passer un projet "fantôme" qui ne contient que la couche voulue
      // generateLayersFromVoice génère toutes les couches définies dans LAYERS_DEF
      // puis on filtre — mais au moins le FX est appliqué individuellement
      const generated = await studioService.generateLayersFromVoice(
        mainVoice,
        { ...project, tracks: [mainVoice] },
        (label, pct) => {
          setGenerateLabel(label);
          setGeneratePct(pct > 0 ? Math.round(pct) : generatePct); // ignorer pct=-1 (progress Worker)
        },
        { realPartition: (selected as any).realPartition, key: (selected as any).key },
        harmonyDef.trackIndex, // ← générer seulement cette harmonie
      );

      // Récupérer uniquement la couche demandée
      const wanted = generated.find(r => r.trackIndex === harmonyDef.trackIndex);
      if (wanted) {
        const u = studioService.addTrackToProject(project.id, wanted);
        if (u) {
          // Réinjecter la voix principale avec son dataUrl
          const uFixed = {
            ...u,
            tracks: u.tracks.map(t =>
              t.id === mainVoice.id ? { ...t, dataUrl: mainVoice.dataUrl } : t
            ),
          };
          onProjectUpdate(uFixed);
        }
        setGeneratedDone(prev => new Set([...prev, harmonyDef.trackIndex]));
        setTimeout(() => setGeneratedDone(prev => {
          const s = new Set(prev); s.delete(harmonyDef.trackIndex); return s;
        }), 3000);
      }
    } catch (e: any) {
      const isQuota = e?.name === 'QuotaExceededError'
        || (e?.message && e.message.toLowerCase().includes('quota'));
      if (isQuota) {
        console.warn('[Harmonie] Quota dépassé — harmonie conservée en mémoire:', e.message);
      } else {
        alert('Erreur génération : ' + e.message);
      }
    } finally {
      setGeneratingIndex(null);
      setGenerateLabel('');
      setGeneratePct(0);
    }
  };

  // Générer toutes les harmonies
  const generateAll = async () => {
    if (!mainVoice || generatingIndex !== null) return;
    // Backup automatique silencieux avant génération
    if (mainVoice) autoBackupToIndexedDB(mainVoice);
    setGeneratingIndex(-1);
    setGeneratePct(0);
    let currentProject = { ...project };

    try {
      const generated = await studioService.generateLayersFromVoice(
        mainVoice, project,
        (label, pct) => {
          setGenerateLabel(label);
          if (pct >= 0) setGeneratePct(Math.round(pct));
        },
        { realPartition: (selected as any).realPartition, key: (selected as any).key },
      );

      // Ajouter toutes les harmonies au projet et mettre à jour l'UI
      if (generated.length > 0) {
        let up = { ...currentProject };
        for (const rec of generated) {
          const u = studioService.addTrackToProject(project.id, rec);
          if (u) up = u;
        }
        // Réinjecter dataUrl de la voix principale (addTrackToProject ne stocke pas les dataUrls)
        up = {
          ...up,
          tracks: up.tracks.map(t =>
            t.id === mainVoice.id ? { ...t, dataUrl: mainVoice.dataUrl } : t
          ),
        };
        onProjectUpdate(up);
      }
    } catch (e: any) {
      const isQuota = e?.name === 'QuotaExceededError'
        || (e?.message && e.message.toLowerCase().includes('quota'));
      if (isQuota) {
        console.warn('[Harmonies] Quota dépassé — harmonies conservées en mémoire:', e.message);
      } else {
        alert('Erreur génération : ' + e.message);
      }
    } finally {
      setGeneratingIndex(null);
      setGenerateLabel('');
      setGeneratePct(0);
    }
  };

  const handleMasterize = () => {
    if (!project?.mixedDataUrl) return;
    const url = project.mixedDataUrl;
    if (url.startsWith('blob:')) {
      // blob: URL → récupérer le blob depuis __mixBlob en mémoire
      const blob = (window as any).__mixBlob as Blob | undefined;
      if (blob) onMasterize(blob, instBlob);
      else fetch(url).then(r => r.blob()).then(b => onMasterize(b, instBlob)).catch(() => {});
    } else {
      const resolved = await studioService.resolveBlobAsync(url);
      if (resolved) onMasterize(resolved, instBlob);
      else console.warn('[Masterize] Blob mix introuvable');
    }
  };

  const hasAnyHarmony = HARMONY_DEFS.some(h => tracks.some(t => t.trackIndex === h.trackIndex));

  return (
    <>
    {/* ── Overlay mixage plein écran ── */}
    {isMixing && (
      <div className="fixed inset-0 z-50 bg-[#020202] flex flex-col items-center justify-center gap-6 px-8">
        <div className="text-5xl">🎛️</div>
        <p className="text-white font-black text-[18px] uppercase tracking-widest text-center">
          Mixage en cours…
        </p>
        <p className="text-zinc-400 text-[13px] font-black text-center">
          {mixLabel || 'Traitement des pistes…'}
        </p>
        <div className="w-full max-w-xs space-y-2">
          <div className="flex justify-between">
            <span className="text-[11px] text-zinc-500 font-black uppercase tracking-widest">Progression</span>
            <span className="text-[12px] font-black text-red-400">{mixProgress}%</span>
          </div>
          <div className="h-2 bg-zinc-900 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-red-600 to-orange-500 rounded-full transition-all duration-500"
              style={{ width: `${Math.max(5, mixProgress)}%` }}
            />
          </div>
        </div>
        <p className="text-zinc-600 text-[10px] font-black uppercase tracking-widest text-center">
          Ne pas quitter l'application
        </p>
      </div>
    )}
    <div className="min-h-screen bg-[#020202] text-white flex flex-col">

      {/* ── Header ── */}
      <div className="shrink-0 flex items-center gap-3 px-5 pt-6 pb-4 border-b border-zinc-900">
        <button onClick={onBack} className="w-10 h-10 rounded-xl bg-zinc-900 flex items-center justify-center active:scale-90">
          <ChevronLeft size={20}/>
        </button>
        <div className="min-w-0 flex-1">
          <p className="font-bebas text-xl text-white tracking-widest leading-none">MIXER</p>
          <p className="text-[10px] text-zinc-500 font-black uppercase">
            {selected.title}
            {' · '}
            <span className="text-zinc-400">{tracks.length} piste{tracks.length > 1 ? 's' : ''}</span>
            {totalDuration > 0 && (
              <span className="text-zinc-600"> · {formatTime(totalDuration)}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tracks.length >= 2 && (
            <button onClick={handleGoComp}
              className="flex items-center gap-1.5 px-3 py-2 bg-red-900/30 border border-red-600/30 rounded-xl text-[11px] font-black text-red-400 active:scale-90">
              <Scissors size={13}/> Comp
            </button>
          )}
          {tracks.length > 0 && (
            <button
              onClick={() => setShowStack(v => !v)}
              className={`w-9 h-9 rounded-xl flex items-center justify-center active:scale-90 transition-all ${
                showStack ? 'bg-blue-600 text-white' : 'bg-zinc-900 text-zinc-500'
              }`}>
              <BarChart2 size={15}/>
            </button>
          )}
          <button onClick={onGoSongs} className="text-[11px] text-zinc-600 font-black uppercase px-3 py-2 active:scale-90">
            Chansons
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pt-4 pb-6 space-y-4" style={{ WebkitOverflowScrolling: 'touch' }}>

        {/* ── Vue Stack Timeline ── */}
        {showStack && tracks.length > 0 && (
          <div className="bg-zinc-950 border border-white/8 rounded-2xl p-4">
            <p className="text-[10px] text-zinc-500 font-black uppercase tracking-widest mb-3">
              Timeline — {tracks.length} piste{tracks.length > 1 ? 's' : ''}
            </p>
            <div className="space-y-2">
              {[...tracks].sort((a, b) => (a.trackIndex ?? 0) - (b.trackIndex ?? 0)).map(track => {
                const preset = TRACK_PRESETS.find(p => p.index === track.trackIndex) || TRACK_PRESETS[0];
                return (
                  <div key={track.id} className="flex items-center gap-2">
                    <div
                      className="w-20 shrink-0 flex items-center gap-1"
                      style={{ opacity: track.muted ? 0.3 : 1 }}>
                      <span className="text-base leading-none">{preset.emoji}</span>
                      <span className="text-[9px] font-black truncate" style={{ color: preset.color }}>
                        {track.trackLabel}
                      </span>
                    </div>
                    <div className="flex-1">
                      <WaveformBar
                        dataUrl={track.dataUrl}
                        color={preset.color}
                        height={22}
                        points={60}
                        playbackPct={playingId === track.id ? undefined : undefined}
                        dimmed={track.muted}
                      />
                    </div>
                    <div className="w-10 shrink-0 text-right">
                      <span className="text-[9px] text-zinc-600 font-black">
                        {Math.round((track.gain ?? 1) * 100)}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Ajouter une piste ── */}
        <button onClick={onAddTrack}
          className="w-full py-3 border border-dashed border-zinc-700 rounded-2xl flex items-center justify-center gap-2 text-zinc-600 font-black text-[12px] uppercase active:scale-95 transition-all">
          <Plus size={16}/> Enregistrer une piste
        </button>

        {/* ── Section Harmonies & Layers ── */}
        {mainVoice && (
          <div className="bg-zinc-950 border border-purple-600/20 rounded-2xl overflow-hidden">
            <div className="px-4 pt-4 pb-3">
              <div className="flex items-center gap-2 mb-1">
                <Sparkles size={14} className="text-purple-400"/>
                <p className="text-[12px] font-black text-white">Harmonies & Layers</p>
                <span className="ml-auto text-[9px] text-purple-500 font-black uppercase">
                  {HARMONY_DEFS.filter(h => tracks.some(t => t.trackIndex === h.trackIndex)).length}/{HARMONY_DEFS.length}
                </span>
              </div>
              <p className="text-[10px] text-zinc-500 leading-relaxed mb-4">
                Génère individuellement chaque harmonie ou toutes d'un coup.
              </p>

              {/* ── Tonalité suggérée (depuis métadonnées chanson) ── */}
              {(project as any).suggestedKey && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl mb-3"
                  style={{ background: '#a855f720', border: '1px solid #a855f730' }}>
                  <span className="text-base">🎵</span>
                  <div className="flex-1">
                    <p className="text-[10px] font-black text-purple-300">Tonalité détectée : {(project as any).suggestedKey}</p>
                    <p className="text-[9px] text-zinc-500">Les harmonies sont optimisées pour cette clé</p>
                  </div>
                </div>
              )}

              {/* ── Sections — activer harmonies par section ── */}
              {mainVoice && (
                <div className="mb-4">
                  <button
                    onClick={() => setShowSections(v => !v)}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-xl mb-2 active:scale-[0.98] transition-all"
                    style={{ background: showSections ? '#1e1e2e' : '#0f0f0f', border: '1px solid #2a2a2a' }}>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px]">🗺</span>
                      <span className="text-[10px] font-black text-zinc-300 uppercase tracking-wider">Harmonies par section</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {sections.length > 0 && (
                        <span className="text-[9px] font-black text-purple-400">{sections.length} section{sections.length > 1 ? 's' : ''}</span>
                      )}
                      <span className="text-zinc-600 text-[10px]">{showSections ? '▲' : '▼'}</span>
                    </div>
                  </button>

                  {showSections && (
                    <div className="space-y-2 px-1">
                      {/* Ajouter une section */}
                      <div className="flex gap-1.5 flex-wrap mb-2">
                        {SECTION_LABELS.filter(l => !sections.find(s => s.label === l)).map(label => (
                          <button
                            key={label}
                            onClick={() => {
                              const lastEnd = sections.length > 0
                                ? Math.max(...sections.map(s => s.endSec))
                                : 0;
                              const dur = totalDuration || 180;
                              const newSec: SectionMarker = {
                                id: `sec_${Date.now()}`,
                                label: label as SectionLabel,
                                startSec: lastEnd,
                                endSec: Math.min(lastEnd + 30, dur),
                                activeHarmonies: [1, 2, 3, 4, 5], // tout actif par défaut
                              };
                              const updated = [...sections, newSec].sort((a, b) => a.startSec - b.startSec);
                              setSections(updated);
                              onProjectUpdate({ ...project, sections: updated } as any);
                            }}
                            className="px-2 py-1 rounded-lg text-[9px] font-black uppercase active:scale-90 transition-all"
                            style={{ background: SECTION_COLORS[label as SectionLabel] + '20', color: SECTION_COLORS[label as SectionLabel], border: `1px solid ${SECTION_COLORS[label as SectionLabel]}40` }}>
                            + {label}
                          </button>
                        ))}
                      </div>

                      {sections.length === 0 && (
                        <p className="text-[9px] text-zinc-600 text-center py-2">Ajoute des sections pour activer les harmonies sélectivement</p>
                      )}

                      {sections.map(sec => (
                        <div key={sec.id} className="rounded-xl overflow-hidden"
                          style={{ background: '#0d0d0d', border: `1px solid ${SECTION_COLORS[sec.label]}30` }}>
                          <div className="flex items-center gap-2 px-3 py-2">
                            <span className="text-[10px] font-black" style={{ color: SECTION_COLORS[sec.label] }}>{sec.label}</span>
                            {/* Temps start/end */}
                            <div className="flex items-center gap-1 flex-1">
                              <input type="number" min="0" max={totalDuration} step="1"
                                value={Math.round(sec.startSec)}
                                onChange={e => {
                                  const updated = sections.map(s => s.id === sec.id ? { ...s, startSec: parseFloat(e.target.value) } : s);
                                  setSections(updated); onProjectUpdate({ ...project, sections: updated } as any);
                                }}
                                className="w-12 text-[9px] font-black text-center rounded-lg px-1 py-0.5 bg-zinc-900 text-zinc-300 border border-zinc-800"/>
                              <span className="text-zinc-700 text-[9px]">→</span>
                              <input type="number" min="0" max={totalDuration} step="1"
                                value={Math.round(sec.endSec)}
                                onChange={e => {
                                  const updated = sections.map(s => s.id === sec.id ? { ...s, endSec: parseFloat(e.target.value) } : s);
                                  setSections(updated); onProjectUpdate({ ...project, sections: updated } as any);
                                }}
                                className="w-12 text-[9px] font-black text-center rounded-lg px-1 py-0.5 bg-zinc-900 text-zinc-300 border border-zinc-800"/>
                              <span className="text-[8px] text-zinc-600">s</span>
                            </div>
                            <button onClick={() => {
                              const updated = sections.filter(s => s.id !== sec.id);
                              setSections(updated); onProjectUpdate({ ...project, sections: updated } as any);
                            }} className="text-zinc-700 active:text-red-500 text-[10px] px-1">✕</button>
                          </div>
                          {/* Harmonies actives pour cette section */}
                          <div className="flex gap-1.5 px-3 pb-2.5 flex-wrap">
                            {HARMONY_DEFS.map(h => {
                              const active = sec.activeHarmonies.includes(h.trackIndex);
                              return (
                                <button key={h.trackIndex}
                                  onClick={() => {
                                    const newActive = active
                                      ? sec.activeHarmonies.filter(i => i !== h.trackIndex)
                                      : [...sec.activeHarmonies, h.trackIndex];
                                    const updated = sections.map(s => s.id === sec.id ? { ...s, activeHarmonies: newActive } : s);
                                    setSections(updated); onProjectUpdate({ ...project, sections: updated } as any);
                                  }}
                                  className="px-2 py-1 rounded-lg text-[8px] font-black uppercase active:scale-90 transition-all"
                                  style={{
                                    background: active ? h.color + '25' : '#1a1a1a',
                                    color: active ? h.color : '#3f3f46',
                                    border: `1px solid ${active ? h.color + '50' : '#2a2a2a'}`,
                                  }}>
                                  {h.label}
                                </button>
                              );
                            })}
                          </div>

                          {/* ── Volumes par harmonie pour cette section ── */}
                          {sec.activeHarmonies.length > 0 && (
                            <div className="px-3 pb-3 space-y-1.5">
                              <span className="text-[7px] font-black text-zinc-700 uppercase tracking-widest">Volume par harmonie</span>
                              {HARMONY_DEFS.filter(h => sec.activeHarmonies.includes(h.trackIndex)).map(h => {
                                const vol = (sec as any).harmonyVolumes?.[h.trackIndex] ?? 0.75;
                                return (
                                  <div key={h.trackIndex} className="flex items-center gap-2">
                                    <span className="text-[8px] font-black w-16 shrink-0" style={{ color: h.color }}>
                                      {h.emoji} {h.label}
                                    </span>
                                    <input
                                      type="range" min="0" max="1" step="0.05"
                                      value={vol}
                                      onChange={e => {
                                        const newVol = parseFloat(e.target.value);
                                        const updated = sections.map(s => s.id === sec.id ? {
                                          ...s,
                                          harmonyVolumes: { ...((s as any).harmonyVolumes ?? {}), [h.trackIndex]: newVol }
                                        } : s);
                                        setSections(updated); onProjectUpdate({ ...project, sections: updated } as any);
                                      }}
                                      className="flex-1 h-1 rounded-full appearance-none cursor-pointer"
                                      style={{ accentColor: h.color }}
                                    />
                                    <span className="text-[7px] font-black tabular-nums w-6 text-right" style={{ color: h.color + 'cc' }}>
                                      {Math.round(vol * 100)}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── Clavier visuel des harmonies ── */}
              <div className="space-y-2 mb-4">
                {HARMONY_DEFS.map(h => {
                  const hasTrack      = tracks.some(t => t.trackIndex === h.trackIndex);
                  const existingTrack = tracks.find(t => t.trackIndex === h.trackIndex);
                  const isGen         = generatingIndex === h.trackIndex;
                  const isDone        = generatedDone.has(h.trackIndex);
                  const appliedFxId   = (existingTrack as any)?.fxPresetId as string | undefined;

                  return (
                    <div
                      key={h.trackIndex}
                      className={`rounded-xl border overflow-hidden transition-all ${
                        hasTrack
                          ? 'border-opacity-40'
                          : 'border-zinc-800'
                      }`}
                      style={{
                        borderColor: hasTrack ? h.color + '50' : undefined,
                        background: hasTrack ? h.color + '08' : '#0a0a0a',
                      }}>

                      <div className="flex items-center gap-3 px-3 py-2.5">
                        {/* Info harmonie */}
                        <div className="text-xl leading-none w-8 text-center shrink-0">{h.emoji}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-[12px] font-black text-white">{h.label}</p>
                            <span
                              className="text-[9px] font-black px-1.5 py-0.5 rounded-full"
                              style={{ background: h.color + '25', color: h.color }}>
                              {h.musicNote}
                            </span>
                            {appliedFxId && (
                              <span className="text-[8px] font-black px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-400">
                                ⚡ {appliedFxId.replace('_', ' ')}
                              </span>
                            )}
                            {h.pitch !== 0 && (
                              <span className="text-[9px] text-zinc-600 font-black">
                                {h.pitch > 0 ? `+${h.pitch}` : h.pitch} ST
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-zinc-500">{h.desc}</p>

                          {/* Waveform si générée */}
                          {hasTrack && existingTrack?.dataUrl && (
                            <div className="mt-2">
                              <WaveformBar
                                dataUrl={existingTrack.dataUrl}
                                color={h.color}
                                height={20}
                                points={50}
                                playbackPct={playingId === existingTrack.id ? undefined : undefined}
                              />
                            </div>
                          )}

                          {/* Progression génération */}
                          {isGen && (
                            <div className="mt-2">
                              <div className="flex justify-between mb-1">
                                <p className="text-[9px] font-black" style={{ color: h.color }}>{generateLabel}</p>
                                <p className="text-[9px] text-zinc-600">{generatePct}%</p>
                              </div>
                              <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
                                <div className="h-full rounded-full transition-all duration-200"
                                  style={{ width: `${generatePct}%`, background: h.color }}/>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Bouton générer / régénérer */}
                        <div className="shrink-0">
                          {isGen ? (
                            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: h.color + '20' }}>
                              <Loader2 size={14} className="animate-spin" style={{ color: h.color }}/>
                            </div>
                          ) : isDone ? (
                            <div className="w-9 h-9 rounded-xl bg-emerald-900/30 flex items-center justify-center">
                              <CheckCircle2 size={14} className="text-emerald-400"/>
                            </div>
                          ) : hasTrack ? (
                            <button
                              onClick={() => generateOne(h)}
                              disabled={generatingIndex !== null || !audioCacheReady}
                              className="w-9 h-9 rounded-xl flex items-center justify-center active:scale-90 disabled:opacity-30 transition-all"
                              style={{ background: h.color + '20' }}
                              title="Régénérer">
                              <RefreshCw size={13} style={{ color: h.color }}/>
                            </button>
                          ) : (
                            <button
                              onClick={() => generateOne(h)}
                              disabled={generatingIndex !== null || !audioCacheReady}
                              className="w-9 h-9 rounded-xl flex items-center justify-center active:scale-90 disabled:opacity-30 transition-all"
                              style={{ background: h.color + '25' }}
                              title="Générer">
                              <Sparkles size={13} style={{ color: h.color }}/>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Progression globale */}
              {generatingIndex === -1 && (
                <div className="mb-3">
                  <div className="flex justify-between mb-1">
                    <p className="text-[10px] text-purple-300 font-black">{generateLabel}...</p>
                    <p className="text-[10px] text-zinc-500">{generatePct}%</p>
                  </div>
                  <div className="h-1.5 bg-zinc-900 rounded-full overflow-hidden">
                    <div className="h-full bg-purple-600 rounded-full transition-all"
                      style={{ width: `${generatePct}%` }}/>
                  </div>
                </div>
              )}

              {/* ── Layering A/B/C ── */}
              {slotVoices.length > 1 && (
                <div className="mb-3 p-3 rounded-xl" style={{ background: '#0f172a', border: '1px solid #1e293b' }}>
                  <p className="text-[9px] text-zinc-500 font-black uppercase tracking-widest mb-2">🎙 Layering — inclure dans le mix</p>
                  <div className="flex gap-2">
                    {slotVoices.map(sv => {
                      const slot = sv.takeSlot as string;
                      const isMain = sv.id === mainVoice?.id;
                      const included = isMain || layerSlots.has(sv.id);
                      return (
                        <button key={sv.id}
                          onClick={() => {
                            if (isMain) return; // slot actif = toujours inclus
                            setLayerSlots(prev => {
                              const n = new Set(prev);
                              n.has(sv.id) ? n.delete(sv.id) : n.add(sv.id);
                              return n;
                            });
                          }}
                          className="flex-1 py-2 rounded-lg font-black text-[11px] uppercase tracking-widest transition-all active:scale-95 flex flex-col items-center gap-0.5"
                          style={{
                            background: included ? '#16a34a20' : '#141414',
                            border: `1.5px solid ${included ? '#16a34a' : '#27272a'}`,
                            color: included ? '#4ade80' : '#52525b',
                          }}>
                          <span>Slot {slot}</span>
                          <span className="text-[7px] font-black" style={{ color: included ? '#4ade80' : '#3f3f46' }}>
                            {isMain ? '● PRINCIPAL' : included ? '✓ INCLUS' : '+ AJOUTER'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {layerSlots.size > 0 && (
                    <p className="text-[8px] text-emerald-500 font-black uppercase mt-1.5">
                      ✓ {layerSlots.size + 1} voix mixées — appuie sur MIXER pour générer
                    </p>
                  )}
                </div>
              )}

              {/* Bouton récupération d'urgence */}
              <button
                onClick={() => { setShowRecovery(true); loadRecoveryItems(); }}
                className="w-full py-2 rounded-xl font-black text-[9px] uppercase tracking-widest text-zinc-600 border border-zinc-900 active:scale-95 transition-all flex items-center justify-center gap-1.5 mb-1">
                🔍 Récupérer une voix perdue
              </button>

              {/* Bouton backup + export voix principale */}
              {mainVoice && (
                <div className="flex gap-2 mb-2">
                  <button
                    onClick={backupMainVoice}
                    className={`flex-1 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest flex items-center justify-center gap-1.5 active:scale-95 transition-all ${
                      backupDone ? 'bg-green-800 text-green-300' : 'bg-zinc-800 text-zinc-400'
                    }`}>
                    {backupDone
                      ? <><CheckCircle2 size={12}/> Sauvegardé</>
                      : <><Shield size={12}/> Backup voix{autoBackupDone && <span className="ml-1 text-[8px] text-emerald-500">● auto</span>}</>
                    }
                  </button>
                  <button
                    onClick={exportMainVoice}
                    disabled={exportingVoice}
                    className="flex-1 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest flex items-center justify-center gap-1.5 active:scale-95 transition-all bg-zinc-800 text-zinc-400 disabled:opacity-50">
                    {exportingVoice
                      ? <><Loader2 size={12} className="animate-spin"/> Export...</>
                      : <><Download size={12}/> Exporter voix</>
                    }
                  </button>
                </div>
              )}

              {/* Indicateur cache audio */}
              {mainVoice && !audioCacheReady && !audioCacheError && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800 text-zinc-400 text-[11px] mb-1">
                  <Loader2 size={11} className="animate-spin text-purple-400"/>
                  <span>Chargement de la voix… (quelques secondes)</span>
                </div>
              )}
              {mainVoice && audioCacheError && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-950 text-red-400 text-[11px] mb-1">
                  <span>⚠️ Voix introuvable — re-enregistrez ou utilisez "Récupérer une voix perdue"</span>
                </div>
              )}

              {/* Bouton Tout générer */}
              <button
                onClick={generateAll}
                disabled={generatingIndex !== null || !audioCacheReady}
                className={`w-full py-3 rounded-xl font-black text-[12px] uppercase tracking-widest flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50 ${
                  hasAnyHarmony ? 'bg-zinc-800 text-zinc-300' : 'bg-purple-700 text-white'
                }`}>
                {generatingIndex === -1
                  ? <><Loader2 size={14} className="animate-spin"/> Génération...</>
                  : !audioCacheReady && !audioCacheError
                  ? <><Loader2 size={14} className="animate-spin"/> Chargement voix...</>
                  : audioCacheError
                  ? <>⚠️ Voix introuvable</>
                  : hasAnyHarmony
                  ? <><RefreshCw size={14}/> Tout régénérer</>
                  : <><Sparkles size={14}/> Générer toutes les harmonies</>
                }
              </button>
            </div>
          </div>
        )}

        {/* Guide si vide */}
        {!mainVoice && tracks.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 gap-3 opacity-40">
            <Layers size={40} className="text-zinc-700"/>
            <p className="text-[12px] text-zinc-600 font-black uppercase text-center">Enregistre la voix principale</p>
          </div>
        )}

        {/* ── Pistes ── */}
        {tracks.length > 0 && (
          <div className="space-y-2">
            {tracks.filter(t => !(t as any).isGenerated).length > 0 && (
              <p className="text-[9px] text-zinc-700 font-black uppercase tracking-widest px-1">
                🎤 Pistes enregistrées
              </p>
            )}
            {tracks.filter(t => !(t as any).isGenerated).map(track => {
              // Le slot actif = voix principale, les autres = prises alternatives
              const isActiveSlot = track.takeSlot === takeSlot || (track.trackIndex === 0 && track.takeSlot === undefined);
              const displayTrack = isActiveSlot ? track : { ...track, trackLabel: `Prise ${track.takeSlot || 'alt'} — ${track.songTitle || ''}` };
              return (
                <TrackCard key={track.id} track={displayTrack} playingId={playingId}
                  allTracks={tracks}
                  onPlay={onPlay} onMute={onMute} onSolo={onSolo} onVolume={onVolume} onPan={onPan} onDelete={onDelete}
                  onTrackUpdate={handleTrackUpdate}/>
              );
            })}

            {tracks.filter(t => (t as any).isGenerated).length > 0 && (
              <p className="text-[9px] text-zinc-700 font-black uppercase tracking-widest px-1 pt-2">
                ✨ Harmonies & layers générés
              </p>
            )}
            {tracks.filter(t => (t as any).isGenerated).map(track => (
              <TrackCard key={track.trackIndex} track={track} playingId={playingId}
                allTracks={tracks}
                onPlay={onPlay} onMute={onMute} onSolo={onSolo} onVolume={onVolume} onPan={onPan} onDelete={onDelete}
                onTrackUpdate={handleTrackUpdate}/>
            ))}
          </div>
        )}

        {/* ── Zone Mix + Export ── */}
        {tracks.length > 0 && (
          <div className="space-y-3 pt-2">

            {/* Bouton Mixer */}
            <button onClick={() => onMix([...layerSlots])} disabled={isMixing}
              className="w-full py-4 bg-red-600 rounded-2xl font-black text-[14px] uppercase tracking-widest flex items-center justify-center gap-3 active:scale-95 transition-all disabled:opacity-60">
              {isMixing
                ? <><Loader2 size={18} className="animate-spin"/> Mixage...</>
                : mixDone
                ? <><CheckCircle2 size={18}/> Re-mixer</>
                : <><Layers size={18}/> Mixer toutes les pistes</>}
            </button>

            {/* Waveform du mix + actions */}
            {mixDone && project.mixedDataUrl && (
              <div className="bg-zinc-950 border border-white/8 rounded-2xl overflow-hidden">
                {/* Header mix */}
                <div className="px-4 pt-3 pb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Music2 size={13} className="text-red-400"/>
                    <p className="text-[11px] font-black text-white">Mix vocal</p>
                    {totalDuration > 0 && (
                      <span className="text-[10px] text-zinc-500">{formatTime(totalDuration)}</span>
                    )}
                  </div>
                  <button onClick={onPlayMix}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 rounded-xl text-[11px] font-black text-white active:scale-90">
                    {playingId === 'mix' ? <><Pause size={12}/> Pause</> : <><Play size={12}/> Écouter</>}
                  </button>
                </div>

                {/* Waveform mix */}
                <div className="px-4 pb-3">
                  {mixWaveform.length > 0 ? (
                    <WaveformBar
                      waveform={mixWaveform}
                      color="#ef4444"
                      height={48}
                      points={100}
                      playbackPct={playingId === 'mix' ? undefined : undefined}
                      isPlaying={playingId === 'mix'}
                    />
                  ) : (
                    <div className="h-12 bg-zinc-900 rounded-lg animate-pulse"/>
                  )}
                </div>

                {/* Actions */}
                <div className="border-t border-white/5 divide-y divide-white/5">
                  <button onClick={handleMasterize}
                    className="w-full py-3.5 font-black text-[12px] uppercase tracking-widest flex items-center justify-center gap-2 text-purple-400 active:bg-zinc-900 transition-all">
                    🎛️ Masteriser & Exporter
                    <span className="text-[10px] opacity-60">{instBlob ? '+ instrumental' : 'voix seule'}</span>
                  </button>

                  {isOnline && (
                    <button onClick={onUploadMix} disabled={uploading === 'mix'}
                      className="w-full py-3.5 font-black text-[12px] uppercase tracking-widest flex items-center justify-center gap-2 text-emerald-400 active:bg-zinc-900 transition-all disabled:opacity-60">
                      {uploading === 'mix'
                        ? <><Loader2 size={14} className="animate-spin"/> Transfert...</>
                        : uploadDone === 'mix'
                        ? <><CheckCircle2 size={14}/> Transféré au Mac !</>
                        : <><Send size={14}/> Envoyer au Mac (brut)</>}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <audio ref={playRef} playsInline className="hidden"/>
    </div>
    {/* ── Modal récupération ── */}
    {showRecovery && (
      <div className="fixed inset-0 z-50 flex items-end justify-center" style={{background:'rgba(0,0,0,0.85)'}}>
        <div className="w-full max-w-lg bg-zinc-950 border border-zinc-800 rounded-t-2xl p-5 max-h-[80vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <p className="font-black text-[13px] uppercase tracking-widest text-white">🔍 Récupérer une voix</p>
            <button onClick={() => setShowRecovery(false)} className="text-zinc-600 text-[20px] leading-none active:scale-90">✕</button>
          </div>
          {recoveryItems.length === 0 ? (
            <p className="text-zinc-600 text-[12px] text-center py-8">Aucun backup trouvé dans le stockage local.</p>
          ) : (
            <div className="space-y-2">
              {recoveryItems.map(item => (
                <button key={item.key}
                  onClick={() => restoreFromBackup(item.key)}
                  disabled={!!recovering}
                  className="w-full text-left p-3 bg-zinc-900 border border-zinc-800 rounded-xl active:scale-98 transition-all disabled:opacity-50">
                  <p className="text-[12px] font-bold text-white">{item.label}</p>
                  <p className="text-[10px] text-zinc-600 mt-0.5">{(item.size / 1024).toFixed(0)} KB — {item.key}</p>
                  {recovering === item.key && <p className="text-[10px] text-emerald-400 mt-1 animate-pulse">⏳ Restauration en cours...</p>}
                </button>
              ))}
            </div>
          )}
          <p className="text-[9px] text-zinc-700 uppercase font-black mt-4">La voix sera restaurée dans le slot A de cette chanson</p>
        </div>
      </div>
    )}
    </>
  );
}