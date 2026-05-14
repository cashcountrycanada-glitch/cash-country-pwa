/**
 * RecordScreen.tsx — v7.8
 *
 * UI de sélection micro pour 3 setups :
 *   Setup 1 : Micro cravate (récepteur Lightning/USB-C) + écouteurs BT → badge "Externe ✓"
 *   Setup 2 : Carte son V8 (USB-C) + micro condensateur → badge "V8 ✓"
 *   Setup 3 : Aucun externe, écouteurs BT → badge "Builtin (A2DP protégé)"
 *
 * Mode Auto : priorité externe > builtin-si-BT > défaut iOS
 * Mode Manuel : sélection toujours respectée, avertissement si BT choisi manuellement
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronLeft, Mic, Square, Headphones, AlertCircle, Layers, Loader2, VolumeX, Radio, RefreshCw, Wifi } from 'lucide-react';
import { ReverbType, TrackProject } from '../../services/StudioService';
import { Song } from '../../types';
import { TRACK_PRESETS, TrackPreset, REVERB_LABELS, REVERB_TYPES, formatTime, SectionMarker, SECTION_COLORS } from './studio.types';
import VUMeter from './VUMeter';
import { AudioDevice, AutoSelectReason } from './useStudioRecorder';

interface Props {
  selected: Song; project: TrackProject | null; currentPreset: TrackPreset; reverb: ReverbType;
  isRecording: boolean; isSaving: boolean; duration: number; analyser: AnalyserNode | null;
  vuLevel: number; monitoring: boolean; permError: boolean; httpsUrl: string;
  instUrl: string | null; instLoading: boolean; instCached: boolean;
  vocalGuideUrl: string | null; vocalLoading: boolean; vocalCached: boolean;
  vocalGuideVol: number; showLyrics: boolean;
  instRef: React.RefObject<HTMLAudioElement>; vocalGuideRef: React.RefObject<HTMLAudioElement>;
  onBack: () => void; onGoMixer: () => void; onPresetChange: (preset: TrackPreset) => void;
  onReverbChange: (r: ReverbType) => void; onStartRecording: () => void; onStopRecording: () => void;
  takeSlot: 'A' | 'B' | 'C'; onTakeSlotChange: (slot: 'A' | 'B' | 'C') => void;
  slotTakes: { A?: any; B?: any; C?: any };
  onToggleMonitor: () => void; onVocalVolumeChange: (v: number) => void; onToggleLyrics: () => void;
  onPreviewStems: () => void; onPreWarmMic: () => Promise<void>; isPreviewing: boolean;
  audioDevices: AudioDevice[]; selectedDevice: string | null; onSelectDevice: (id: string | null) => void;
  onRefreshDevices: () => void; punchIn: number | null; punchOut: number | null;
  onSetPunchIn: (v: number | null) => void; onSetPunchOut: (v: number | null) => void;
  stemDuration: number; sections: SectionMarker[];
  autoSelectReason: AutoSelectReason;
  activeDeviceLabel: string;
}

function parseLyricsWithChords(raw: string): { text: string; isChord: boolean; isSection: boolean }[] {
  return raw.split('\
').map(line => {
    const isChord = /^[\s][A-G][#b]?[^\s,!?.]{0,6}(\s+[A-G][#b]?[^\s,!?.]{0,6})\s*$/.test(line);
    const isSection = /^[.+]$|^(Couplet|Refrain|Pont|Intro|Outro|Verse|Chorus|Bridge)/i.test(line.trim());
    return { text: line, isChord, isSection };
  }).filter(l => !l.isChord && l.text.trim() !== '');
}
function parseLrcFile(raw: string): Array<{ time: number; text: string }> {
  const lines: Array<{ time: number; text: string }> = [];
  for (const line of raw.split('\
')) {
    const m = line.match(/^\[(\d+):(\d+(?:[.:]?\d+)?)\]\s*(.*)/);
    if (!m) continue;
    const mins = parseInt(m[1], 10); const secs = parseFloat(m[2]); const text = m[3].trim();
    if (text) lines.push({ time: mins * 60 + secs, text });
  }
  return lines.sort((a, b) => a.time - b.time);
}

// Raccourcit le label d'un device pour l'affichage dans un bouton compact
function shortLabel(label: string, category: string): string {
  if (/external microphone/i.test(label)) return 'Micro ext.';
  if (/built.?in microphone|iphone microphone|microphone intégré/i.test(label)) return 'Micro int.';
  if (/headset microphone/i.test(label)) return 'Casque';
  if (/usb audio codec/i.test(label)) return 'USB Audio';
  if (/v8/i.test(label)) return 'V8';
  if (/airpods/i.test(label)) return 'AirPods';
  if (category === 'bluetooth') return label.replace(/microphone|mic|audio/gi, '').trim().slice(0, 14) || 'BT';
  if (category === 'external') return label.slice(0, 14);
  return label.replace(/microphone|mic/gi, '').trim().slice(0, 12) || label.slice(0, 10);
}

// Couleur et icône selon la catégorie + raison auto
function deviceStyle(dev: AudioDevice, isSelected: boolean, isAuto: boolean, autoReason: AutoSelectReason, presetColor: string) {
  if (dev.category === 'bluetooth') {
    return {
      bg:     isSelected ? '#7c3aed20' : '#1a1a1a',
      border: isSelected ? '#7c3aed' : '#2a2a2a',
      color:  isSelected ? '#a78bfa' : '#52525b',
      icon:   '\ud83c\udfa7',
    };
  }
  if (dev.category === 'external') {
    return {
      bg:     isSelected ? '#16a34a20' : '#1a1a1a',
      border: isSelected ? '#16a34a' : '#2a2a2a',
      color:  isSelected ? '#4ade80' : '#52525b',
      icon:   '\ud83c\udf99',
    };
  }
  if (dev.category === 'builtin') {
    const isHfpProtect = isAuto && autoReason === 'builtin_hfp';
    return {
      bg:     isSelected ? (isHfpProtect ? '#92400e20' : presetColor + '20') : '#1a1a1a',
      border: isSelected ? (isHfpProtect ? '#d97706' : presetColor) : '#2a2a2a',
      color:  isSelected ? (isHfpProtect ? '#fbbf24' : presetColor) : '#52525b',
      icon:   '\ud83d\udcf1',
    };
  }
  return { bg: isSelected ? presetColor + '20' : '#1a1a1a', border: isSelected ? presetColor : '#2a2a2a', color: isSelected ? presetColor : '#52525b', icon: '\ud83c\udf99' };
}

export default function RecordScreen({
  selected, project, currentPreset, reverb, isRecording, isSaving, duration, analyser, vuLevel,
  monitoring, permError, httpsUrl, instUrl, instLoading, instCached, vocalGuideUrl, vocalLoading, vocalCached,
  vocalGuideVol, showLyrics, instRef, vocalGuideRef,
  takeSlot, onTakeSlotChange, slotTakes,
  onBack, onGoMixer, onPresetChange, onReverbChange,
  onStartRecording, onStopRecording, onToggleMonitor, onVocalVolumeChange, onToggleLyrics,
  onPreviewStems, isPreviewing, onPreWarmMic,
  audioDevices, selectedDevice, onSelectDevice, onRefreshDevices,
  punchIn, punchOut, onSetPunchIn, onSetPunchOut, stemDuration, sections,
  autoSelectReason, activeDeviceLabel,
}: Props) {
  const localVolRef = useRef<number>(vocalGuideVol);
  const [localVol, setLocalVol] = useState<number>(vocalGuideVol);
  useEffect(() => { localVolRef.current = vocalGuideVol; setLocalVol(vocalGuideVol); }, [vocalGuideVol]);

  const handleVolChange = useCallback((v: number) => {
    localVolRef.current = v; setLocalVol(v); onVocalVolumeChange(v);
    // .volume est read-only sur iOS — le volume est géré via GainNode dans useStudioAudio
    // On appelle setVocalGuideVol qui passe par updateVocalVol → setVolumeIOS
    // Pas d'assignation directe .volume ici
  }, [onVocalVolumeChange, vocalGuideRef]);

  const [lrcIndex, setLrcIndex] = useState(0);
  const [serverLrc, setServerLrc] = useState<Array<{ time: number; text: string }> | null>(null);
  const [serverLrcLoading, setServerLrcLoading] = useState(false);
  const lyricsScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setServerLrc(null); setLrcIndex(0); if (!selected) return;
    const lrcVersion = selected.versions?.find(v => (v as any).fileName?.toLowerCase().endsWith('.lrc'));
    if (!lrcVersion) return;
    const url = `/api/media/${encodeURIComponent((lrcVersion as any).fileName as string)}`;
    setServerLrcLoading(true);
    fetch(url).then(r => r.ok ? r.text() : null).then(txt => { if (txt) { const p = parseLrcFile(txt); if (p.length > 0) setServerLrc(p); } }).catch(() => {}).finally(() => setServerLrcLoading(false));
  }, [selected?.id]);

  const lrcLines = selected.lrcData || serverLrc || selected.lrcDense || [];
  const staticLines = selected.lyricsWithChords ? parseLyricsWithChords(selected.lyricsWithChords) : [];
  const hasLrc = lrcLines.length > 0;

  useEffect(() => {
    if (!hasLrc || !instRef.current) return;
    const el = instRef.current;
    const onTime = () => {
      const t = el.currentTime; let idx = 0;
      for (let i = 0; i < lrcLines.length; i++) { if (lrcLines[i].time <= t) idx = i; else break; }
      setLrcIndex(idx);
    };
    el.addEventListener('timeupdate', onTime);
    return () => el.removeEventListener('timeupdate', onTime);
  }, [hasLrc, lrcLines, instUrl]);

  useEffect(() => {
    if (!lyricsScrollRef.current) return;
    const active = lyricsScrollRef.current.querySelector('[data-active="true"]') as HTMLElement;
    if (active) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [lrcIndex]);

  const trackCount = project?.tracks.length || 0;

  // Analyser l'état actuel des devices pour les avertissements
  const hasExternalMic = audioDevices.some(d => d.category === 'external');
  const hasBluetooth   = audioDevices.some(d => d.category === 'bluetooth');
  const selectedDev    = audioDevices.find(d => d.deviceId === selectedDevice);
  const selectedIsBT   = selectedDev?.category === 'bluetooth';

  // Badge statut auto-sélection
  function renderAutoStatusBadge() {
    if (isRecording) {
      const color = autoSelectReason === 'external' ? '#4ade80'
        : autoSelectReason === 'builtin_hfp' ? '#fbbf24'
        : '#a1a1aa';
      const icon = autoSelectReason === 'external' ? '\ud83c\udf99'
        : autoSelectReason === 'builtin_hfp' ? '\ud83d\udee1'
        : '\ud83d\udcf1';
      return (
        <div className="mx-4 mb-2 rounded-xl px-3 py-2 flex items-center gap-2" style={{ background: color + '15', border: `1px solid ${color}50` }}>
          <span style={{ fontSize: 11 }}>{icon}</span>
          <span className="text-[9px] font-black uppercase tracking-wider" style={{ color }}>{activeDeviceLabel}</span>
          {autoSelectReason === 'builtin_hfp' && <span className="text-[8px] font-black ml-auto" style={{ color: '#fbbf24' }}>A2DP ✓</span>}
          {autoSelectReason === 'external' && <span className="text-[8px] font-black ml-auto" style={{ color: '#4ade80' }}>HD ✓</span>}
        </div>
      );
    }
    return null;
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#0a0a0a' }}>
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-4 pt-5 pb-3" style={{ borderBottom: '1px solid #1a1a1a' }}>
        <button onClick={onBack} className="w-9 h-9 rounded-xl flex items-center justify-center active:scale-90" style={{ background: '#1a1a1a' }}>
          <ChevronLeft size={18} className="text-zinc-400" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="font-bebas text-lg text-white tracking-widest leading-none truncate">{selected.title}</p>
          <p className="text-[9px] text-zinc-600 font-black uppercase truncate">{selected.artist}</p>
        </div>
        <div className="shrink-0 px-3 py-1.5 rounded-xl" style={{ background: isRecording ? '#dc262620' : '#1a1a1a', border: `1px solid ${isRecording ? '#dc2626' : '#2a2a2a'}` }}>
          <p className="font-bebas text-2xl tracking-widest tabular-nums leading-none" style={{ color: isRecording ? '#ef4444' : '#71717a' }}>{formatTime(duration)}</p>
        </div>
        {trackCount > 0 && (
          <button onClick={onGoMixer} className="flex items-center gap-1.5 px-3 py-2 rounded-xl active:scale-90" style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}>
            <Layers size={13} className="text-zinc-400" /><span className="text-[11px] font-black text-zinc-300">{trackCount}</span>
          </button>
        )}
      </div>

      {/* Erreur permission */}
      {permError && (
        <div className="mx-4 mt-3 rounded-2xl px-4 py-3 flex items-start gap-3" style={{ background: '#dc262615', border: '1px solid #dc262640' }}>
          <AlertCircle size={15} className="text-red-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-[12px] text-red-400 font-black mb-1">Accès micro refusé</p>
            {httpsUrl
              ? <><p className="text-[11px] text-zinc-400 mb-2">Safari iOS exige HTTPS.</p><a href={httpsUrl} className="block text-center py-2 bg-red-600 rounded-xl font-black text-[11px] text-white">\ud83d\udd12 Ouvrir en HTTPS</a></>
              : <p className="text-[11px] text-zinc-400">Réglages → Safari → Microphone → Autoriser</p>}
          </div>
        </div>
      )}

      {/* Badge statut pendant l'enregistrement */}
      {renderAutoStatusBadge()}

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Sélection piste */}
        {/* ── Sélecteur A/B/C — Voix principale uniquement ── */}
        {currentPreset.index === 0 && (
          <div className="shrink-0 px-4 pt-3 pb-2">
            <p className="text-[9px] text-zinc-700 font-black uppercase tracking-widest mb-2">Prise</p>
            <div className="flex gap-2">
              {(['A', 'B', 'C'] as const).map(slot => {
                const hasTake = !!slotTakes[slot];
                const isActive = takeSlot === slot;
                return (
                  <button key={slot}
                    onClick={() => !isRecording && !isSaving && onTakeSlotChange(slot)}
                    disabled={isRecording || isSaving}
                    className="flex-1 py-2 rounded-xl font-black text-[13px] transition-all active:scale-95 disabled:opacity-40 flex flex-col items-center gap-1"
                    style={{
                      background: isActive ? currentPreset.color + '20' : '#141414',
                      border: `2px solid ${isActive ? currentPreset.color : hasTake ? '#22c55e40' : '#222'}`,
                    }}>
                    <span style={{ color: isActive ? currentPreset.color : hasTake ? '#22c55e' : '#52525b' }}>{slot}</span>
                    <span className="text-[7px] font-black" style={{ color: hasTake ? '#22c55e' : '#3f3f46' }}>
                      {hasTake ? '● PRISE' : 'vide'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="shrink-0 px-4 pt-4 pb-2">
          <p className="text-[9px] text-zinc-700 font-black uppercase tracking-widest mb-2">Piste</p>
          <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
            {TRACK_PRESETS.map(preset => {
              const hasTrack = project?.tracks.some(t => t.trackIndex === preset.index);
              const isActive = currentPreset.index === preset.index;
              return (
                <button key={preset.index} onClick={() => !isRecording && !isSaving && onPresetChange(preset)} disabled={isRecording || isSaving}
                  className="shrink-0 flex flex-col items-center gap-1 px-3 py-2 rounded-xl transition-all active:scale-95"
                  style={{ background: isActive ? preset.color + '20' : '#141414', border: `1px solid ${isActive ? preset.color + '60' : '#222'}`, minWidth: 72 }}>
                  <span className="text-lg leading-none">{preset.emoji}</span>
                  <span className="text-[9px] font-black whitespace-nowrap" style={{ color: isActive ? preset.color : '#52525b' }}>
                    {preset.label.replace('Harmonie ', '+').replace('Voix principale', 'Voix').replace('Double tracking', 'Double').replace('Octave bas', 'Oct↓')}
                  </span>
                  {hasTrack && <span className="text-[7px] font-black" style={{ color: '#22c55e' }}>✓</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* Zone principale */}
        <div className="shrink-0 mx-4 rounded-2xl overflow-hidden" style={{ background: '#111', border: `1px solid ${isRecording ? currentPreset.color + '40' : '#1e1e1e'}` }}>

          {/* ── SÉLECTION MICRO ────────────────────────────────────────────── */}
          {audioDevices.length > 0 && (
            <div className="px-4 pt-3 pb-3" style={{ borderBottom: '1px solid #1a1a1a' }}>
              <div className="flex items-center gap-2 mb-2">
                <Radio size={9} className="text-zinc-600 shrink-0" />
                <span className="text-[8px] font-black uppercase tracking-widest text-zinc-700">Micro</span>
                {/* Avertissement BT sélectionné manuellement */}
                {selectedIsBT && !isRecording && (
                  <span className="text-[8px] font-black ml-2 px-1.5 py-0.5 rounded" style={{ background: '#7c3aed20', color: '#c4b5fd' }}>
                    ⚠️ BT → son téléphonie possible
                  </span>
                )}
                <button onClick={onRefreshDevices} disabled={isRecording}
                  className="shrink-0 w-5 h-5 flex items-center justify-center rounded-lg active:scale-90 disabled:opacity-30 ml-auto"
                  style={{ background: '#1a1a1a' }}>
                  <RefreshCw size={8} className="text-zinc-600" />
                </button>
              </div>

              <div className="flex gap-1.5 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
                {/* Bouton Auto */}
                <button
                  onClick={() => !isRecording && onSelectDevice(null)}
                  disabled={isRecording}
                  className="shrink-0 flex flex-col items-center gap-0.5 px-2.5 py-1.5 rounded-xl transition-all active:scale-90 disabled:opacity-40"
                  style={{
                    background: selectedDevice === null ? '#3b82f620' : '#141414',
                    border: `1px solid ${selectedDevice === null ? '#3b82f6' : '#222'}`,
                    minWidth: 52,
                  }}>
                  <span className="text-[9px]">⚡</span>
                  <span className="text-[8px] font-black uppercase" style={{ color: selectedDevice === null ? '#60a5fa' : '#52525b' }}>Auto</span>
                  {selectedDevice === null && (
                    <span className="text-[6px] font-black" style={{ color: '#3b82f6aa' }}>
                      {autoSelectReason === 'external' ? 'EXT' : autoSelectReason === 'builtin_hfp' ? 'HFP\ud83d\udee1' : 'DEF'}
                    </span>
                  )}
                </button>

                {/* Devices disponibles */}
                {audioDevices.map(dev => {
                  const isSelected = selectedDevice === dev.deviceId;
                  const isAutoSelected = selectedDevice === null; // En mode auto, aucun bouton device n'est "actif"
                  const style = deviceStyle(dev, isSelected, isAutoSelected, autoSelectReason, currentPreset.color);
                  const label = shortLabel(dev.label, dev.category);
                  return (
                    <button
                      key={dev.deviceId}
                      onClick={() => !isRecording && onSelectDevice(dev.deviceId)}
                      disabled={isRecording}
                      className="shrink-0 flex flex-col items-center gap-0.5 px-2.5 py-1.5 rounded-xl transition-all active:scale-90 disabled:opacity-40"
                      style={{ background: style.bg, border: `1px solid ${style.border}`, minWidth: 52 }}
                      title={dev.label}>
                      <span className="text-[9px]">{style.icon}</span>
                      <span className="text-[8px] font-black uppercase text-center leading-tight max-w-[60px] truncate" style={{ color: style.color }}>
                        {label}
                      </span>
                      {dev.category === 'bluetooth' && (
                        <span className="text-[6px] font-black" style={{ color: '#7c3aed80' }}>BT</span>
                      )}
                      {dev.category === 'external' && (
                        <span className="text-[6px] font-black" style={{ color: '#16a34a' }}>EXT</span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Résumé du setup détecté — affiché seulement avant l'enregistrement */}
              {!isRecording && !isSaving && (
                <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                  {hasExternalMic && (
                    <span className="text-[8px] font-black px-2 py-0.5 rounded-full" style={{ background: '#16a34a20', color: '#4ade80', border: '1px solid #16a34a40' }}>
                      \ud83c\udf99 Externe détecté — qualité HD
                    </span>
                  )}
                  {hasBluetooth && !hasExternalMic && selectedDevice === null && (
                    <span className="text-[8px] font-black px-2 py-0.5 rounded-full" style={{ background: '#92400e20', color: '#fbbf24', border: '1px solid #92400e40' }}>
                      \ud83c\udfa7 BT → Micro iPhone auto (A2DP protégé)
                    </span>
                  )}
                  {hasBluetooth && !hasExternalMic && selectedIsBT && (
                    <span className="text-[8px] font-black px-2 py-0.5 rounded-full" style={{ background: '#7c3aed20', color: '#c4b5fd', border: '1px solid #7c3aed40' }}>
                      ⚠️ Micro BT actif — qualité peut être réduite (HFP)
                    </span>
                  )}
                  {!hasBluetooth && !hasExternalMic && (
                    <span className="text-[8px] font-black px-2 py-0.5 rounded-full" style={{ background: '#1a1a1a', color: '#52525b', border: '1px solid #222' }}>
                      \ud83d\udcf1 Micro iPhone
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* VU Meter */}
          <div className="px-4 pt-4 pb-2">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[9px] text-zinc-700 font-black uppercase tracking-widest">Niveau</p>
              {isRecording && <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" /><span className="text-[9px] font-black text-red-400 uppercase tracking-widest">REC</span></div>}
            </div>
            <VUMeter analyser={analyser} vuLevel={vuLevel} active={isRecording} />
          </div>

          {/* Stems */}
          <div className="flex gap-2 px-4 pb-3 flex-wrap items-center">
            {instLoading
              ? <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg" style={{ background: '#1a1a1a' }}><Loader2 size={9} className="text-zinc-600 animate-spin" /><span className="text-[9px] text-zinc-600 font-black">Instrum...</span></div>
              : instUrl
                ? <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg" style={{ background: instCached ? '#1e3a5f' : '#2a1f00', border: `1px solid ${instCached ? '#1d4ed880' : '#92400e80'}` }}>
                    <Headphones size={9} className={instCached ? 'text-blue-400' : 'text-amber-500'} />
                    <span className={`text-[9px] font-black uppercase ${instCached ? 'text-blue-400' : 'text-amber-500'}`}>
                      INSTRUM {instCached ? '📦' : '🌐'}
                    </span>
                  </div>
                : null
            }
            {vocalLoading
              ? <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg" style={{ background: '#1a1a1a' }}><Loader2 size={9} className="text-zinc-600 animate-spin" /><span className="text-[9px] text-zinc-600 font-black">Guide...</span></div>
              : vocalGuideUrl
                ? <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg" style={{ background: vocalCached ? '#1e3a1e' : '#2a1f00', border: `1px solid ${vocalCached ? '#16a34a80' : '#92400e80'}` }}>
                    <Mic size={9} className={vocalCached ? 'text-emerald-400' : 'text-amber-500'} />
                    <span className={`text-[9px] font-black uppercase ${vocalCached ? 'text-emerald-400' : 'text-amber-500'}`}>
                      GUIDE {vocalCached ? '📦' : '🌐'}
                    </span>
                  </div>
                : null
            }
            {(instUrl || vocalGuideUrl) && !isRecording && !isSaving && (() => {
              const allCached = (!instUrl || instCached) && (!vocalGuideUrl || vocalCached);
              const noneCached = (instUrl && !instCached) || (vocalGuideUrl && !vocalCached);
              return (
                <button
                  onClick={onPreviewStems}
                  className="ml-auto flex items-center gap-1.5 px-3 py-1 rounded-lg active:scale-90 transition-all"
                  style={{
                    background: isPreviewing ? '#7c3aed20' : allCached ? '#0f2a0f' : noneCached ? '#2a1800' : '#1a1a1a',
                    border: `1px solid ${isPreviewing ? '#7c3aed80' : allCached ? '#16a34a60' : noneCached ? '#d9770660' : '#2a2a2a'}`,
                  }}>
                  {isPreviewing
                    ? <Square size={9} fill="currentColor" className="text-violet-400" />
                    : <Headphones size={9} className={allCached ? 'text-emerald-400' : noneCached ? 'text-amber-500' : 'text-zinc-400'} />
                  }
                  <span className="text-[9px] font-black uppercase" style={{ color: isPreviewing ? '#a78bfa' : allCached ? '#4ade80' : noneCached ? '#f59e0b' : '#71717a' }}>
                    {isPreviewing ? 'Stop' : allCached ? 'Écouter 📦' : noneCached ? 'Écouter 🌐' : 'Écouter'}
                  </span>
                </button>
              );
            })()}
          </div>

          {/* Sections punch */}
          {sections.length > 0 && !isRecording && (
            <div className="px-4 pb-2" style={{ borderTop: '1px solid #1a1a1a', paddingTop: 10 }}>
              <div className="flex items-center gap-1.5 mb-2"><span className="text-[8px] font-black text-zinc-600 uppercase tracking-widest">Section →</span></div>
              <div className="flex gap-1.5 flex-wrap">
                {[...sections].sort((a, b) => a.startSec - b.startSec).map(sec => {
                  const color = SECTION_COLORS[sec.label as keyof typeof SECTION_COLORS] ?? '#71717a';
                  const isActive = punchIn === sec.startSec && punchOut === sec.endSec;
                  return (
                    <button key={sec.id} onClick={() => { if (isActive) { onSetPunchIn(null); onSetPunchOut(null); } else { onSetPunchIn(sec.startSec); onSetPunchOut(sec.endSec); } }}
                      className="flex flex-col items-start px-2.5 py-1.5 rounded-xl active:scale-90 transition-all" style={{ background: isActive ? color + '25' : '#111', border: `1px solid ${isActive ? color + '80' : '#222'}`, minWidth: 60 }}>
                      <span className="text-[9px] font-black uppercase" style={{ color: isActive ? color : '#52525b' }}>{sec.label}</span>
                      <span className="text-[7px] tabular-nums" style={{ color: isActive ? color + 'cc' : '#3f3f46' }}>{formatTime(sec.startSec)}→{formatTime(sec.endSec)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Punch In/Out */}
          {(instUrl || vocalGuideUrl) && !isRecording && (
            <div className="px-4 pb-3 flex items-center gap-2" style={{ borderTop: '1px solid #1a1a1a', paddingTop: 10 }}>
              <span className="text-[9px] text-zinc-600 font-black uppercase shrink-0">Punch</span>
              <div className="flex items-center gap-1 flex-1">
                <span className="text-[8px] text-zinc-700 font-black uppercase w-4">IN</span>
                <input type="range" min="0" max={stemDuration > 0 ? stemDuration : 300} step="1" value={punchIn ?? 0}
                  onChange={e => { const v = parseFloat(e.target.value); onSetPunchIn(v === 0 ? null : v); }} disabled={isRecording}
                  className="flex-1 h-1 rounded-full appearance-none cursor-pointer"
                  style={{ accentColor: '#f97316', background: `linear-gradient(to right, #f97316 ${stemDuration > 0 ? ((punchIn ?? 0) / stemDuration) * 100 : 0}%, #1e1e1e ${stemDuration > 0 ? ((punchIn ?? 0) / stemDuration) * 100 : 0}%)` }} />
                <span className="text-[8px] font-black w-7 text-right" style={{ color: punchIn ? '#f97316' : '#3f3f46' }}>{punchIn ? formatTime(punchIn) : '--'}</span>
              </div>
              <span className="text-zinc-800 text-[10px]">→</span>
              <div className="flex items-center gap-1 flex-1">
                <span className="text-[8px] text-zinc-700 font-black uppercase w-5">OUT</span>
                <input type="range" min="0" max={stemDuration > 0 ? stemDuration : 300} step="1" value={punchOut ?? (stemDuration || 300)}
                  onChange={e => { const v = parseFloat(e.target.value); onSetPunchOut(v >= (stemDuration || 300) ? null : v); }} disabled={isRecording}
                  className="flex-1 h-1 rounded-full appearance-none cursor-pointer"
                  style={{ accentColor: '#ef4444', background: `linear-gradient(to right, #1e1e1e ${stemDuration > 0 ? ((punchOut ?? stemDuration) / stemDuration) * 100 : 100}%, #ef4444 ${stemDuration > 0 ? ((punchOut ?? stemDuration) / stemDuration) * 100 : 100}%)` }} />
                <span className="text-[8px] font-black w-7 text-right" style={{ color: punchOut ? '#ef4444' : '#3f3f46' }}>{punchOut ? formatTime(punchOut) : '--'}</span>
              </div>
              {(punchIn || punchOut) && <button onClick={() => { onSetPunchIn(null); onSetPunchOut(null); }} className="text-[8px] font-black text-zinc-700 active:text-zinc-400 px-1">✕</button>}
            </div>
          )}

          {/* Volume guide vocal */}
          {vocalGuideUrl && (
            <div className="px-4 pb-3 flex items-center gap-3" style={{ borderTop: '1px solid #1e1e1e', paddingTop: 10 }}>
              <Mic size={12} className="text-emerald-400 shrink-0" />
              <span className="text-[9px] text-zinc-600 font-black uppercase w-10 shrink-0">Guide</span>
              <input type="range" min="0" max="1" step="0.05" value={localVol}
                onChange={e => handleVolChange(parseFloat(e.target.value))}
                className="flex-1 h-1 rounded-full appearance-none cursor-pointer"
                style={{ accentColor: '#22c55e', background: `linear-gradient(to right, #22c55e ${localVol * 100}%, #27272a ${localVol * 100}%)` }} />
              <span className="text-[10px] font-black text-emerald-400 w-8 text-right shrink-0">{Math.round(localVol * 100)}%</span>
              {localVol === 0 && <VolumeX size={11} className="text-zinc-700 shrink-0" />}
            </div>
          )}
        </div>

        {/* Boutons actions */}
        <div className="shrink-0 px-4 py-4">
          {/* Reverb (post-prod uniquement, masqué pendant REC) */}
          {!isRecording && !isSaving && (
            <div className="flex items-center gap-2 mb-4">
              <span className="text-[9px] text-zinc-700 font-black uppercase w-16 shrink-0">Reverb (post)</span>
              <div className="flex gap-1.5 flex-1">
                {REVERB_TYPES.map(r => (
                  <button key={r} onClick={() => onReverbChange(r)} disabled={isRecording || isSaving}
                    className="flex-1 py-1.5 rounded-lg font-black text-[9px] uppercase tracking-wider transition-all"
                    style={{ background: reverb === r ? currentPreset.color : '#141414', color: reverb === r ? '#fff' : '#52525b', border: `1px solid ${reverb === r ? currentPreset.color + '80' : '#222'}` }}>
                    {REVERB_LABELS[r]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Boutons Monitoring + REC */}
          <div className="flex items-center justify-center gap-6">
            <button onClick={onToggleMonitor} className="flex flex-col items-center gap-1.5 active:scale-90 transition-all">
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: monitoring ? '#1e3a5f' : '#141414', border: `1px solid ${monitoring ? '#3b82f6' : '#222'}` }}>
                <Headphones size={20} style={{ color: monitoring ? '#3b82f6' : '#52525b' }} />
              </div>
              <span className="text-[8px] font-black uppercase tracking-wider" style={{ color: monitoring ? '#3b82f6' : '#3f3f46' }}>{monitoring ? 'Écoute ON' : 'Écoute'}</span>
            </button>

            {isSaving
              ? <div className="w-24 h-24 rounded-full flex flex-col items-center justify-center gap-1" style={{ background: '#141414', border: '2px solid #27272a' }}>
                  <Loader2 size={24} className="text-zinc-500 animate-spin" />
                  <span className="text-[8px] font-black text-zinc-600 uppercase">Sauvegarde</span>
                </div>
              : isRecording
              ? <button onClick={onStopRecording} className="w-24 h-24 rounded-full flex items-center justify-center active:scale-90 transition-all" style={{ background: '#fff', boxShadow: '0 0 40px rgba(255,255,255,0.15)' }}>
                  <Square size={32} className="text-black" fill="currentColor" />
                </button>
              : <button onClick={async () => { await onPreWarmMic(); onStartRecording(); }} className="w-24 h-24 rounded-full flex items-center justify-center active:scale-90 transition-all" style={{ background: currentPreset.color, boxShadow: `0 0 30px ${currentPreset.color}50` }}>
                  <Mic size={36} className="text-white" />
                </button>
            }

            <div className="w-12 h-12 flex flex-col items-center gap-1.5 justify-center">
              {isRecording && <><div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" /><span className="text-[8px] font-black text-red-400 uppercase tabular-nums">{formatTime(duration)}</span></>}
            </div>
          </div>

          <p className="text-center text-[10px] font-black uppercase tracking-widest mt-3" style={{ color: isRecording ? currentPreset.color : '#3f3f46' }}>
            {isSaving ? '⏳ Traitement...' : isRecording ? `● ${currentPreset.emoji} ${currentPreset.label}` : `${currentPreset.emoji} ${currentPreset.label}`}
          </p>
        </div>

        {/* Paroles */}
        {(hasLrc || staticLines.length > 0) && showLyrics && (
          <div className="flex flex-col overflow-hidden mx-4 mb-4 rounded-2xl" style={{ background: '#080808', border: '1px solid #222', height: 260, flexShrink: 0 }}>
            <div className="shrink-0 flex items-center justify-between px-4 py-2.5" style={{ borderBottom: '1px solid #1e1e1e' }}>
              <div className="flex items-center gap-2">
                <span className="text-[9px] text-zinc-600 font-black uppercase tracking-widest">Paroles</span>
                {serverLrcLoading && <span className="text-[8px] text-zinc-600 font-black uppercase animate-pulse">● chargement...</span>}
                {hasLrc && !serverLrcLoading && <span className="text-[8px] font-black uppercase" style={{ color: '#16a34a' }}>● {selected.lrcData ? 'Sync' : serverLrc ? 'LRC' : 'Gemini'}</span>}
              </div>
              <button onClick={onToggleLyrics} className="px-3 py-1 rounded-lg text-[9px] font-black uppercase active:scale-90" style={{ background: '#1a1a1a', color: '#52525b' }}>Masquer</button>
            </div>
            <div ref={lyricsScrollRef} className="overflow-y-auto px-5 py-4" style={{ WebkitOverflowScrolling: 'touch', flex: 1, minHeight: 0 }}>
              {hasLrc
                ? <div className="space-y-3">{lrcLines.map((line, i) => {
                    const isActive = i === lrcIndex; const isPast = i < lrcIndex; const isNext = i === lrcIndex + 1; const isAfterNext = i === lrcIndex + 2;
                    if (isPast || (!isActive && !isNext && !isAfterNext)) return null;
                    return (
                      <p key={i} data-active={isActive ? 'true' : 'false'} className="transition-all duration-300 leading-snug"
                        style={{ fontSize: isActive ? 26 : isNext ? 20 : 14, fontWeight: isActive ? 900 : isNext ? 700 : 400, color: isActive ? '#ffffff' : isNext ? '#d4d4d8' : '#52525b', textShadow: isActive ? '0 0 28px rgba(255,255,255,0.3)' : 'none', transform: isActive ? 'translateX(6px)' : 'none', marginBottom: isActive ? 16 : isNext ? 12 : 6 }}>
                        {line.text}
                      </p>
                    );
                  })}</div>
                : <div className="space-y-2">{staticLines.map((line, i) => (
                    <p key={i} className="leading-relaxed"
                      style={{ fontSize: line.isSection ? 11 : 19, fontWeight: line.isSection ? 900 : 600, color: line.isSection ? '#ef4444' : '#e4e4e7', textTransform: line.isSection ? 'uppercase' : 'none', letterSpacing: line.isSection ? '0.2em' : 'normal', marginTop: line.isSection ? 20 : 0, opacity: line.isSection ? 0.8 : 1 }}>
                      {line.text}
                    </p>
                  ))}</div>
              }
              <div style={{ height: 40 }} />
            </div>
          </div>
        )}
        {(hasLrc || staticLines.length > 0) && !showLyrics && (
          <button onClick={onToggleLyrics} className="shrink-0 mx-4 mb-4 py-3 rounded-xl text-[11px] font-black uppercase tracking-widest active:scale-95 transition-all" style={{ background: '#141414', border: '1px solid #333', color: '#a1a1aa' }}>
            \ud83c\udfb5 Afficher les paroles
          </button>
        )}
      </div>
    </div>
  );
}
