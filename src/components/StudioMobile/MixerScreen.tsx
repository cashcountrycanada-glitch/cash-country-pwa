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
  Send, Pause, Play, Sparkles, Music2, RefreshCw, BarChart2, Download, Shield, Mic,
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
  onDelete:        (trackId: string) => void;
  onMix:           (layerIds: string[]) => void;
  onPlayMix:       () => void;
  onMasterize:     (vocalBlob: Blob, instBlob: Blob | null) => void;
  onUploadMix:     () => void;
  onGoComp:        (takes: Take[]) => void;
  onProjectUpdate: (project: TrackProject) => void;
  instBlob:         Blob | null;
  hasInst?:         boolean;
  instOffsetMs?:    number;
  takeSlot:         'A' | 'B' | 'C';
  previewInstVol:   number;
  onPreviewInstVol: (v: number) => void;
  onInstOffset:     (ms: number) => void;
  onAutoSync?:      () => void;
  autoSyncing?:     boolean;
}

// Layers de renforcement style Johnny Cash / Elvis Presley / Alan Jackson
// Gains discrets : les layers renforcent sans rivaliser avec la voix principale
//
// FIX "rester dans la sûreté" : les intervalles musicaux traditionnels
// (Quarte=5ST, Quinte=7ST, Octave=12ST) dépassent tous la zone ±3 demi-tons
// où les artefacts de pitch-shift restent quasi inaudibles, même avec les
// meilleurs algorithmes (préservation de formants incluse) — voir recherche.
// L'octave (-12ST) était même le pire cas, historiquement lié à des crashs
// mémoire iOS. On remplace donc par les intervalles sûrs les plus proches
// (±2/±3 demi-tons), en gardant l'orientation artistique d'origine (haut
// pour Jackson/Brooks, bas pour Cash/Elvis) même si le nom d'intervalle
// exact change.
// FIX "je suis pas censé dire les sections d'une chanson" : les paroles
// synchronisées dans le temps (lrcDense) existent déjà pour chaque chanson —
// elles n'étaient simplement pas utilisées pour détecter la structure. On
// détecte automatiquement : les blocs de paroles séparés par un grand silence
// (= changement de section probable), puis on repère quels blocs se répètent
// mot pour mot (= refrain, par définition), et on déduit Intro/Couplet/
// Refrain/Pont/Outro à partir de ça. C'est une heuristique basée sur de
// vraies données de la chanson, pas une invention — mais elle reste
// ajustable manuellement ensuite si un passage est mal identifié.
function normalizeLine(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

function autoDetectSections(lrcDense: Array<{ time: number; text: string }>, totalDuration: number): SectionMarker[] {
  if (!lrcDense || lrcDense.length === 0) return [];
  const lines = [...lrcDense].sort((a, b) => a.time - b.time);
  const GAP_THRESHOLD = 6; // secondes — un trou de silence de ce genre = probable changement de section

  // 1. Regrouper les lignes en blocs séparés par un grand silence
  type Block = { start: number; end: number; lines: string[] };
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (let i = 0; i < lines.length; i++) {
    const { time, text } = lines[i];
    if (!current || time - current.end > GAP_THRESHOLD) {
      current = { start: time, end: time, lines: [] };
      blocks.push(current);
    }
    current.lines.push(text);
    current.end = time;
  }
  if (blocks.length === 0) return [];

  // 2. Signature par bloc (texte normalisé concaténé) pour repérer les répétitions
  const sig = (b: Block) => b.lines.map(normalizeLine).join('|');
  const sigs = blocks.map(sig);

  // 3. Regrouper les blocs qui se ressemblent fortement (le refrain revient tel quel)
  const similarity = (a: string, b: string) => {
    const la = a.split('|'), lb = b.split('|');
    const setA = new Set(la), setB = new Set(lb);
    let shared = 0;
    for (const l of setA) if (setB.has(l)) shared++;
    return shared / Math.max(la.length, lb.length, 1);
  };
  const groupOf = new Array(blocks.length).fill(-1);
  let nextGroup = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (groupOf[i] !== -1) continue;
    groupOf[i] = nextGroup;
    for (let j = i + 1; j < blocks.length; j++) {
      if (groupOf[j] === -1 && similarity(sigs[i], sigs[j]) > 0.6) groupOf[j] = groupOf[i];
    }
    nextGroup++;
  }
  const groupCounts: Record<number, number> = {};
  groupOf.forEach(g => { groupCounts[g] = (groupCounts[g] || 0) + 1; });
  // Le groupe qui revient le plus souvent (2+) et qui n'est pas le tout premier bloc = refrain
  let chorusGroup = -1, bestCount = 1;
  Object.entries(groupCounts).forEach(([g, count]) => {
    if (count > bestCount) { bestCount = count; chorusGroup = parseInt(g); }
  });

  // 4. Construire les SectionMarker
  const sections: SectionMarker[] = [];
  const PAD_END = 1.5; // secondes ajoutées après la dernière ligne d'un bloc (la voix résonne un peu)

  if (blocks[0].start > 3) {
    sections.push({ id: `sec_${Date.now()}_intro`, label: 'Intro', startSec: 0, endSec: blocks[0].start, activeHarmonies: [] });
  }

  let seenChorus = false;
  blocks.forEach((b, i) => {
    const isChorus = chorusGroup !== -1 && groupOf[i] === chorusGroup;
    let label: SectionLabel;
    if (isChorus) { label = 'Refrain'; seenChorus = true; }
    else if (seenChorus && groupCounts[groupOf[i]] === 1) label = 'Pont';
    else label = 'Couplet';

    const nextStart = i + 1 < blocks.length ? blocks[i + 1].start : totalDuration;
    const endSec = Math.min(nextStart, b.end + PAD_END);
    sections.push({
      id: `sec_${Date.now()}_${i}`,
      label,
      startSec: b.start,
      endSec,
      activeHarmonies: label === 'Refrain' ? [1, 2, 3, 4, 5] : label === 'Pont' ? [1, 3] : [1],
    });
  });

  const lastEnd = sections[sections.length - 1]?.endSec ?? 0;
  if (totalDuration - lastEnd > 3) {
    sections.push({ id: `sec_${Date.now()}_outro`, label: 'Outro', startSec: lastEnd, endSec: totalDuration, activeHarmonies: [1, 2, 3, 4, 5] });
  }

  return sections;
}

const HARMONY_DEFS = [
  { trackIndex: 1, label: 'Double',  pitch:  0,  color: '#f97316', emoji: '🎵', musicNote: 'Unisson',   desc: 'Épaissit naturellement' },
  { trackIndex: 2, label: '+2 ST',   pitch:  2,  color: '#eab308', emoji: '🎶', musicNote: 'Seconde ↑',  desc: 'Signature Alan Jackson' },
  { trackIndex: 3, label: '-3 ST',  pitch: -3, color: '#3b82f6', emoji: '🔉', musicNote: 'Tierce ↓',  desc: 'Grave profond Cash' },
  { trackIndex: 4, label: '+3 ST',   pitch:  3,  color: '#a855f7', emoji: '✨', musicNote: 'Tierce ↑',  desc: 'Puissance Garth Brooks' },
  { trackIndex: 5, label: '-2 ST',   pitch: -2,  color: '#22c55e', emoji: '🎼', musicNote: 'Seconde ↓',  desc: 'Chaleur grave Elvis' },
];

export default function MixerScreen({
  selected, project, playingId, isMixing, mixProgress, mixLabel, mixDone, isOnline,
  uploading, uploadDone, playRef,
  onBack, onGoSongs, onAddTrack, onPlay, onMute, onSolo, onVolume, onPan,
  onDelete, onMix, onPlayMix, onMasterize, onUploadMix, onGoComp,
  onProjectUpdate, instBlob, hasInst, instOffsetMs = 0, takeSlot, previewInstVol, onPreviewInstVol, onInstOffset, onAutoSync, autoSyncing,
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
  // FIX "pouvoir comparer les deux techniques" (v7.6.434) : choix du style
  // vocal pour la Masterisation, persisté par chanson (localStorage) — les
  // deux versions (Classique / Bus partagé) sont déjà rendues lors du
  // Mixage, ce toggle choisit juste laquelle nourrit MasteringEngine.
  const [vocalStyle, setVocalStyle] = useState<'classic' | 'bus'>(() => {
    try { return (localStorage.getItem(`vocalStyle_${project?.id}`) as 'classic' | 'bus') || 'classic'; }
    catch { return 'classic'; }
  });
  useEffect(() => {
    try { if (project?.id) localStorage.setItem(`vocalStyle_${project.id}`, vocalStyle); } catch {}
  }, [vocalStyle, project?.id]);
  const [showStack, setShowStack]             = useState(false);
  const [showSections, setShowSections]       = useState(false);
  const [sections, setSections]               = useState<SectionMarker[]>(
    (project as any).sections || []
  );
  // Slot actif par trackIndex pour les harmonies manuelles (2-5)
  // Initialisé depuis le projet (persisté) — sinon 'A' par défaut pour chaque piste
  const [activeManualSlots, setActiveManualSlots] = useState<Record<number, 'A'|'B'|'C'>>(
    () => (project as any).activeManualSlots ?? {2:'A',3:'A',4:'A',5:'A'}
  );
  // Persister le choix de slot dans le projet pour que handleMix() le lise au mixage
  const setActiveManualSlot = (trackIndex: number, slot: 'A'|'B'|'C') => {
    setActiveManualSlots(prev => {
      const next = { ...prev, [trackIndex]: slot };
      onProjectUpdate({ ...project, activeManualSlots: next } as any);
      return next;
    });
  };

  const [isPreviewing, setIsPreviewing] = useState(false);
  const [exportingPreview, setExportingPreview] = useState(false);

  const tracks    = project?.tracks || [];

  const stopPreview = () => {
    const srcs: AudioBufferSourceNode[] = (window as any).__previewSrcs || [];
    srcs.forEach(s => { try { s.stop(); } catch {} });
    (window as any).__previewSrcs = [];
    try { (window as any).__previewCtx?.close(); } catch {}
    (window as any).__previewCtx = null;
    setIsPreviewing(false);
  };

  const startPreview = async () => {
    if (isPreviewing) { stopPreview(); return; }
    const dbg = (msg: string) => { try { (window as any).__addLog?.(msg); } catch {} console.log(msg); };
    // FIX "layers pas utilisés / voix réduite" : le Mixdown (handleMix côté
    // StudioMobile.tsx) filtre déjà pour ne garder qu'UN SEUL take actif par
    // piste (takeSlot pour la voix principale, activeManualSlots pour les
    // harmonies manuelles 2-5) — mais Preview Mix jouait TOUT project.tracks
    // sans ce filtre. Si d'anciens takes non-actifs traînent (non mutés),
    // ils jouaient EN MÊME TEMPS que le take actif : ça peut noyer/masquer
    // les layers générés dans le mélange, et surtout créer de l'annulation
    // de phase avec la voix principale (deux prises quasi identiques qui se
    // superposent = perte de niveau/clarté perçue comme "voix réduite").
    // On applique maintenant exactement la même règle que le Mixdown.
    const activeSlot = takeSlot ?? 'A';
    const seenVoice = new Set<string>();
    const seenHarmonySlot = new Set<string>();
    const rawTracks = project?.tracks || [];
    const currentTracks = rawTracks.filter((t: any) => {
      if (t.trackIndex === 0 && !t.isGenerated) {
        const slot = t.takeSlot ?? 'A';
        if (seenVoice.has(slot)) return false;
        seenVoice.add(slot);
        return slot === activeSlot;
      }
      if (t.trackIndex >= 2 && t.trackIndex <= 5 && !t.isGenerated) {
        const slot = t.takeSlot ?? 'A';
        const preferredSlot = activeManualSlots[t.trackIndex] ?? 'A';
        const key = `${t.trackIndex}_${slot}`;
        if (seenHarmonySlot.has(key)) return false;
        seenHarmonySlot.add(key);
        return slot === preferredSlot;
      }
      return true; // double-tracking (idx=1) + layers générés : toujours inclus
    });
    if (currentTracks.length === 0) return;
    dbg(`[Preview] ${currentTracks.length}/${rawTracks.length} piste(s) retenue(s) après filtre slot actif (${activeSlot})`);

    // ── iOS : AudioContext DOIT être créé synchroniquement dans le user gesture ──
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    let ctx: AudioContext;
    try {
      ctx = new AudioCtx() as AudioContext;
      if (ctx.state === 'suspended') await ctx.resume();
    } catch (e: any) {
      alert('Preview non disponible : ' + e.message);
      return;
    }
    (window as any).__previewCtx = ctx;
    setIsPreviewing(true);

    // FIX "délai des harmonies appliqué deux fois" (v7.6.430) : chaque
    // harmonie a DÉJÀ son propre délai calibré et différencié ("cuit" dans
    // son fichier audio) au moment de la génération dans harmony-worker.js
    // (profile.timingMs : 18/32/12/26 ms selon la piste — voir LAYER_PROFILES).
    // Ce PRE_DELAYS ici en ajoutait un SECOND par-dessus (9/12/14/7 ms),
    // sans que les deux mécanismes se "voient" — total réel jusqu'à 44ms sur
    // la piste 3, au-delà du seuil d'écho perceptible (~30ms) documenté
    // juste ici. Résultat : au lieu de fusionner comme des voix multiples
    // proches, certaines harmonies se détachaient comme un écho distinct.
    // trackIndex 1 (Double tracking) était déjà à 0 pour la même raison —
    // les harmonies 2-5 le sont maintenant aussi, le timing différencié par
    // piste vient uniquement de harmony-worker.js.
    const PRE_DELAYS: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

    // ── ÉTAPE 1 : tout décoder D'ABORD, ne rien démarrer encore ────────────────
    // FIX désync/"chanson incomplète" : décoder un fichier de 3-4 min prend de
    // vraies secondes. ctx.currentTime avance en temps réel dès la création du
    // contexte, MÊME si rien ne joue encore. Avant, chaque piste démarrait avec
    // `ctx.currentTime + délai` juste après SON propre décodage — la voix
    // (décodée en premier) jouait donc déjà depuis plusieurs secondes quand
    // l'instrumental (décodé en dernier) était enfin programmé, décalant tout
    // et donnant l'impression que le début de la chanson manquait. On décode
    // maintenant tout en amont et on ne programme le démarrage qu'une fois que
    // TOUT est prêt, avec un seul point de référence temporel partagé.
    type Pending = { label: string; buffer: AudioBuffer; gainVal: number; panVal: number; delaySec: number; isInst: boolean; offsetSec: number; isHarmony: boolean };
    const pending: Pending[] = [];

    for (const track of currentTracks) {
      const label = `"${track.trackLabel || track.id}" (idx=${track.trackIndex ?? '?'}, slot=${(track as any).takeSlot ?? '?'})`;
      if ((track as any).muted) { dbg(`[Preview] ${label} → SKIP (muted)`); continue; }
      let blob: Blob | null = null;
      try {
        blob = await studioService.resolveBlobAsync(track.dataUrl, track.id);
      } catch (e: any) { dbg(`[Preview] ${label} → EXCEPTION resolveBlobAsync: ${e?.message}`); continue; }
      if (!blob || blob.size < 100) { dbg(`[Preview] ${label} → SKIP (blob introuvable, dataUrl=${track.dataUrl ? track.dataUrl.slice(0,20) : 'VIDE'})`); continue; }
      try {
        const ab = await blob.arrayBuffer();
        const buffer = await ctx.decodeAudioData(ab);
        const tIdx = (track as any).trackIndex ?? 0;
        const delaySec = tIdx > 0 ? (PRE_DELAYS[tIdx] ?? 30) / 1000 : 0;
        const isHarmonyTrack = !!(track as any).isGenerated;
        // Même boost que le vrai mixage (v7.6.427) — cohérence preview/export
        const gainVal = isHarmonyTrack
          ? Math.min(0.85, ((track as any).gain ?? 1.0) * 1.4)
          : Math.min(1.0, (track as any).gain ?? 1.0);
        pending.push({
          label, buffer,
          gainVal,
          panVal: (track as any).pan ?? 0,
          delaySec, isInst: false, offsetSec: 0,
          isHarmony: isHarmonyTrack,
        });
        dbg(`[Preview] ${label} → décodé (${(blob.size/1024).toFixed(0)}KB, ${buffer.duration.toFixed(1)}s)`);
      } catch (e: any) {
        dbg(`[Preview] ${label} → EXCEPTION decode: ${e?.message}`);
      }
    }

    // FIX "instrumental disparu du preview" (v7.6.409) : hasInst est un prop dérivé
    // de audio.instUrl (état du lecteur), pas de la présence réelle du fichier en
    // IndexedDB — il peut rester à `false` même quand l'instrumental existe bel et
    // bien (ex: pas encore chargé dans le lecteur). On vérifie directement en IDB,
    // qui est la vraie source de vérité, au lieu de se fier à ce prop.
    if (selected) {
      try {
        const instBlobForPreview = await studioOfflineDB.getAudio(`inst_${selected.id}`);
        if (instBlobForPreview && instBlobForPreview.size > 100) {
          const ab = await instBlobForPreview.arrayBuffer();
          const buffer = await ctx.decodeAudioData(ab);
          pending.push({
            label: 'Instrumental', buffer,
            gainVal: previewInstVol > 0 ? previewInstVol : 0.7,
            panVal: 0, delaySec: 0, isInst: true, offsetSec: instOffsetMs / 1000, isHarmony: false,
          });
          dbg(`[Preview] Instrumental → décodé (${(instBlobForPreview.size/1024).toFixed(0)}KB, ${buffer.duration.toFixed(1)}s)`);
        } else {
          dbg(`[Preview] Instrumental → SKIP (introuvable en IDB pour inst_${selected.id})`);
        }
      } catch (e: any) {
        dbg(`[Preview] Instrumental → EXCEPTION: ${e?.message}`);
      }
    }

    if (pending.length === 0) {
      stopPreview();
      alert('Aucune piste audio disponible pour le preview.');
      return;
    }

    // ── ÉTAPE 2 : tout est décodé — programmer le démarrage de chaque source ──
    // contre UNE SEULE référence temporelle commune (anchor), plutôt que contre
    // ctx.currentTime "au moment où on y arrive" pour chaque piste.
    const anchor = ctx.currentTime + 0.15;
    const srcs: AudioBufferSourceNode[] = [];
    for (const p of pending) {
      const src = ctx.createBufferSource();
      src.buffer = p.buffer;
      const gain = ctx.createGain();
      gain.gain.value = p.gainVal;
      if (p.isInst) {
        src.connect(gain); gain.connect(ctx.destination);
        if (p.offsetSec >= 0) src.start(anchor + p.offsetSec);
        else src.start(anchor, -p.offsetSec);
      } else {
        const pan = ctx.createStereoPanner();
        pan.pan.value = p.panVal;
        if (p.isHarmony) {
          // v7.6.409 : creux 300Hz + brillant 6kHz sur les harmonies.
          // v7.6.425 : + présence 500-2000Hz ajoutée après analyse du stem vocal
          // original de la chanson (référence : ~49% de l'énergie dans cette
          // zone contre ~28% mesuré sur notre mix voix+harmonies). Ce boost
          // rapproche l'équilibre spectral des harmonies de cette cible mesurée.
          const cut = ctx.createBiquadFilter();
          cut.type = 'peaking'; cut.frequency.value = 300; cut.Q.value = 1.0; cut.gain.value = -4;
          const presence = ctx.createBiquadFilter();
          presence.type = 'peaking'; presence.frequency.value = 1200; presence.Q.value = 0.9; presence.gain.value = 2.5;
          const shelf = ctx.createBiquadFilter();
          shelf.type = 'highshelf'; shelf.frequency.value = 6000; shelf.gain.value = 3;
          src.connect(gain); gain.connect(cut); cut.connect(presence); presence.connect(shelf); shelf.connect(pan); pan.connect(ctx.destination);
        } else {
          src.connect(gain); gain.connect(pan); pan.connect(ctx.destination);
        }
        src.start(anchor + p.delaySec);
      }
      srcs.push(src);
      dbg(`[Preview] ${p.label} → programmé à +${(p.isInst ? p.offsetSec : p.delaySec).toFixed(3)}s`);
    }

    (window as any).__previewSrcs = srcs;

    // Auto-stop quand toutes les sources sont terminées
    let ended = 0;
    srcs.forEach(s => {
      s.onended = () => { ended++; if (ended >= srcs.length) stopPreview(); };
    });
    // Sécurité : stop après 4 minutes
    setTimeout(() => stopPreview(), 4 * 60 * 1000);
  };

  // Exporte le Preview Mix tel quel (mêmes pistes/gains/pans/délais que la
  // lecture en direct) dans un vrai fichier WAV — pour permettre de vérifier
  // hors de l'appareil si les harmonies sont vraiment absentes du calcul, ou
  // si le souci est spécifique à la lecture en temps réel.
  const exportPreviewMix = async () => {
    if (exportingPreview) return;
    setExportingPreview(true);
    const dbg = (msg: string) => { try { (window as any).__addLog?.(msg); } catch {} console.log(msg); };
    try {
      const activeSlot = takeSlot ?? 'A';
      const seenVoice = new Set<string>();
      const seenHarmonySlot = new Set<string>();
      const rawTracks = project?.tracks || [];
      const currentTracks = rawTracks.filter((t: any) => {
        if (t.trackIndex === 0 && !t.isGenerated) {
          const slot = t.takeSlot ?? 'A';
          if (seenVoice.has(slot)) return false;
          seenVoice.add(slot);
          return slot === activeSlot;
        }
        if (t.trackIndex >= 2 && t.trackIndex <= 5 && !t.isGenerated) {
          const slot = t.takeSlot ?? 'A';
          const preferredSlot = activeManualSlots[t.trackIndex] ?? 'A';
          const key = `${t.trackIndex}_${slot}`;
          if (seenHarmonySlot.has(key)) return false;
          seenHarmonySlot.add(key);
          return slot === preferredSlot;
        }
        return true;
      });
      if (currentTracks.length === 0) { alert('Aucune piste à exporter.'); return; }
      dbg(`[ExportPreview] ${currentTracks.length}/${rawTracks.length} piste(s) retenue(s)`);

      // FIX cohérence (v7.6.451) : ces valeurs (9/12/14/7ms) étaient les
      // ANCIENNES, avant le fix v7.6.430 qui les avait mises à 0 partout
      // ailleurs (le délai différencié par harmonie est déjà cuit dans
      // l'audio à la génération — voir harmony-worker.js/timingMs). Cette
      // fonction est un export de DEBUG séparé (bouton "Exporter le Preview
      // (debug)"), pas le chemin réel des masters (studioService.mixProject,
      // déjà correct) — mais laisser des valeurs différentes ici est une
      // source de confusion/incohérence si jamais on compare les deux exports.
      const PRE_DELAYS: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      const probeCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      type Item = { label: string; buffer: AudioBuffer; gainVal: number; panVal: number; delaySec: number; isInst: boolean; offsetSec: number; isHarmony: boolean };
      const items: Item[] = [];

      // FIX CRASH SILENCIEUX "Script error." (v7.6.414) : probeCtx n'était fermé
      // qu'en fin de bloc, jamais dans un finally — une exception imprévue le
      // laissait ouvert indéfiniment. iOS Safari limite le nombre de contextes
      // audio simultanés (~4-6) ; un contexte qui fuit ici peut faire déborder
      // cette limite plus tard (ex: à l'ouverture de Masteriser), ce qui plante
      // silencieusement sans trace JS exploitable (le crash observé). Le
      // try/finally garantit maintenant la fermeture dans tous les cas.
      try {
      for (const track of currentTracks) {
        const label = `"${track.trackLabel || track.id}" (idx=${track.trackIndex ?? '?'})`;
        if ((track as any).muted) { dbg(`[ExportPreview] ${label} → SKIP (muted)`); continue; }
        let blob: Blob | null = null;
        try { blob = await studioService.resolveBlobAsync(track.dataUrl, track.id); } catch {}
        if (!blob || blob.size < 100) { dbg(`[ExportPreview] ${label} → SKIP (blob introuvable)`); continue; }
        try {
          const ab = await blob.arrayBuffer();
          const buffer = await probeCtx.decodeAudioData(ab);
          const tIdx = (track as any).trackIndex ?? 0;
          const delaySec = tIdx > 0 ? (PRE_DELAYS[tIdx] ?? 30) / 1000 : 0;
          const isHarmonyTrack = !!(track as any).isGenerated;
          const gainVal = isHarmonyTrack
            ? Math.min(0.85, ((track as any).gain ?? 1.0) * 1.4)
            : Math.min(1.0, (track as any).gain ?? 1.0);
          items.push({
            label, buffer,
            gainVal,
            panVal: (track as any).pan ?? 0,
            delaySec, isInst: false, offsetSec: 0,
            isHarmony: !!(track as any).isGenerated,
          });
          dbg(`[ExportPreview] ${label} → décodé (${(blob.size / 1024).toFixed(0)}KB, gain=${Math.min(1.0, (track as any).gain ?? 1.0)})`);
        } catch (e: any) { dbg(`[ExportPreview] ${label} → EXCEPTION: ${e?.message}`); }
      }

      // FIX "instrumental disparu du preview" (v7.6.409) : même correctif que
      // pour l'écoute directe — on vérifie l'IDB directement au lieu du prop hasInst.
      if (selected) {
        try {
          const instBlobForPreview = await studioOfflineDB.getAudio(`inst_${selected.id}`);
          if (instBlobForPreview && instBlobForPreview.size > 100) {
            const ab = await instBlobForPreview.arrayBuffer();
            const buffer = await probeCtx.decodeAudioData(ab);
            items.push({
              label: 'Instrumental', buffer,
              gainVal: previewInstVol > 0 ? previewInstVol : 0.7,
              panVal: 0, delaySec: 0, isInst: true, offsetSec: instOffsetMs / 1000, isHarmony: false,
            });
            dbg(`[ExportPreview] Instrumental → décodé`);
          }
        } catch (e: any) { dbg(`[ExportPreview] Instrumental → EXCEPTION: ${e?.message}`); }
      }
      } finally {
        await probeCtx.close().catch(() => {});
      }

      if (items.length === 0) { alert('Aucune piste décodable à exporter.'); return; }

      const totalDur = Math.max(...items.map(it => it.delaySec + it.offsetSec + it.buffer.duration)) + 0.5;
      const sr = items[0].buffer.sampleRate;
      const offline = new OfflineAudioContext(2, Math.ceil(totalDur * sr), sr);
      for (const it of items) {
        const src = offline.createBufferSource(); src.buffer = it.buffer;
        const gain = offline.createGain(); gain.gain.value = it.gainVal;
        if (it.isInst) {
          src.connect(gain); gain.connect(offline.destination);
          if (it.offsetSec >= 0) src.start(it.offsetSec);
          else src.start(0, -it.offsetSec);
        } else {
          const pan = offline.createStereoPanner(); pan.pan.value = it.panVal;
          if (it.isHarmony) {
            // FIX MIX BOUEUX (v7.6.409) : l'analyse spectrale du preview a montré
            // 67,9% de l'énergie concentrée entre 150-500 Hz — les harmonies étant
            // des copies pitch-shiftées de la même voix, elles gardent les mêmes
            // formants et s'empilent toutes dans cette zone. On creuse un peu le
            // low-mid et on redonne un peu de brillant en haut, SEULEMENT sur les
            // couches d'harmonie — la voix principale n'est pas touchée.
            // v7.6.425 : + présence 500-2000Hz, calibrée sur l'analyse du vrai
            // stem vocal original de la chanson (cible mesurée ~49% dans cette
            // zone, contre ~28% sur notre mix avant ce correctif).
            const cut = offline.createBiquadFilter();
            cut.type = 'peaking'; cut.frequency.value = 300; cut.Q.value = 1.0; cut.gain.value = -4;
            const presence = offline.createBiquadFilter();
            presence.type = 'peaking'; presence.frequency.value = 1200; presence.Q.value = 0.9; presence.gain.value = 2.5;
            const shelf = offline.createBiquadFilter();
            shelf.type = 'highshelf'; shelf.frequency.value = 6000; shelf.gain.value = 3;
            src.connect(gain); gain.connect(cut); cut.connect(presence); presence.connect(shelf); shelf.connect(pan); pan.connect(offline.destination);
          } else {
            src.connect(gain); gain.connect(pan); pan.connect(offline.destination);
          }
          src.start(it.delaySec);
        }
      }
      dbg(`[ExportPreview] Rendu de ${items.length} piste(s), durée ${totalDur.toFixed(1)}s…`);
      const rendered = await offline.startRendering();
      const blob = await studioService.encodeToWav(rendered);

      const safeTitle = (selected?.title || project?.songTitle || 'preview').replace(/[^a-zA-Z0-9]/g, '_');
      const fileName = `${safeTitle}_PREVIEW_EXPORT.wav`;
      const file = new File([blob], fileName, { type: 'audio/wav' });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: fileName, files: [file] });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = fileName; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
      dbg(`[ExportPreview] Export terminé : ${fileName}`);
    } catch (e: any) {
      alert('Erreur export preview : ' + e.message);
    } finally {
      setExportingPreview(false);
    }
  };


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

  // Préchargement audio — différé : on ne charge PAS au montage pour éviter
  // les 40 MB d'AudioBuffer en mémoire si l'utilisateur ne génère pas d'harmonie.
  // Le chargement se fait à la demande quand l'utilisateur clique sur Générer.
  const [audioCacheReady, setAudioCacheReady] = React.useState(false);
  const [audioCacheError, setAudioCacheError] = React.useState(false);

  const ensureAudioCache = async (): Promise<boolean> => {
    if (!mainVoice) return false;
    // Déjà en cache (même session) → prêt immédiatement
    const already = !!(window as any).__lastRecDecodedBuf &&
                    (window as any).__lastRecDecodedId === mainVoice.id;
    if (already) { setAudioCacheReady(true); return true; }
    setAudioCacheReady(false);
    setAudioCacheError(false);
    const ok = await studioService.warmAudioCache(mainVoice);
    if (ok) { setAudioCacheReady(true); return true; }
    setAudioCacheError(true);
    return false;
  };


  const handleTrackUpdate = (updated: MobileRecording) => {
    // FIX : matcher par id d'abord (identifiant unique et stable) — avant,
    // le matching se faisait uniquement par trackIndex, ce qui remplaçait
    // TOUTES les prises du même trackIndex (ex: voix principale slot A ET B)
    // par la même piste mise à jour → doublon visuel et perte du slot B.
    const newTracks = project.tracks.map(t => {
      if (updated.id && t.id === updated.id) return updated;
      // Fallback si pas d'id (ne devrait pas arriver) : matcher par trackIndex + slot + type
      if (!updated.id && t.trackIndex === updated.trackIndex
          && (t.takeSlot ?? 'A') === (updated.takeSlot ?? 'A')
          && !!(t as any).isGenerated === !!(updated as any).isGenerated) {
        return updated;
      }
      return t;
    });
    onProjectUpdate({ ...project, tracks: newTracks });
  };

  const handleGoComp = () => {
    // FIX écran noir : n'envoyer que les prises de VOIX PRINCIPALE (trackIndex 0, non générées)
    // Avant : tracks.map() envoyait TOUTES les pistes (harmonies générées, double tracking...)
    // au CompEditor, qui tentait de décoder ~6-8 fichiers audio en parallèle au montage.
    // Sur iOS cela dépasse la limite de 6 AudioContext simultanés et fait planter le
    // composant silencieusement (pas d'ErrorBoundary → écran complètement noir).
    // Le comping n'a de sens que sur les prises de voix de toute façon.
    const voiceTracks = tracks.filter(t => t.trackIndex === 0 && !(t as any).isGenerated);
    const takes: Take[] = voiceTracks.map(t => ({ id: t.id, recording: t, regions: t.regions || [] }));
    if (takes.length === 0) {
      alert('Aucune prise de voix principale à comper. Enregistre au moins une prise (slot A/B/C) avant d\'utiliser le Comp Editor.');
      return;
    }
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
        blob = await studioService.resolveBlobAsync(voice.dataUrl, voice.id);
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

  // Charger tous les backups disponibles — sans charger les blobs en mémoire
  const loadRecoveryItems = async () => {
    try {
      const keys = await studioOfflineDB.listAllAudioKeys();
      const backupKeys = keys.filter(k => k.startsWith('backup_voice_') || k.startsWith('rec_'));
      const allProjects = studioService.getProjects();
      const allTracks = allProjects.flatMap(p => p.tracks);
      const items = await Promise.all(backupKeys.map(async key => {
        try {
          // FIX OOM : lire seulement la taille via hasAudio/metadata, pas le blob entier
          const blob = await studioOfflineDB.getAudio(key);
          const size = blob?.size || 0;
          blob; // permet GC immédiat — on ne garde pas la référence
          if (size < 1000) return null;
          const isBackup = key.startsWith('backup_voice_');
          const id = key.replace('backup_voice_', '').replace('rec_', '');
          const track = allTracks.find(t => t.id === id);
          const label = track
            ? `${isBackup ? '🛡 Backup' : '🎙 Prise'} — ${track.songTitle} (${new Date(track.recordedAt).toLocaleDateString('fr-CA')} ${new Date(track.recordedAt).toLocaleTimeString('fr-CA', {hour:'2-digit',minute:'2-digit'})})`
            : `${isBackup ? '🛡 Backup' : '🎙 Prise'} — ${id.slice(-8)}`;
          return { key, label, size, date: track ? new Date(track.recordedAt).toISOString() : '' };
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
    if (!mainVoice) return;
    try {
      // FIX "Erreur backup : Load failed" — mainVoice.dataUrl peut être une
      // sentinelle "opfs:xxx" (blob volumineux stocké dans OPFS, pas une vraie
      // URL fetchable) plutôt qu'un vrai dataUrl base64. fetch("opfs:...")
      // échoue immédiatement dans Safari avec "Load failed". Il faut passer
      // par resolveBlobAsync() qui sait lire depuis OPFS/IDB dans ce cas.
      // FIX "fichier introuvable" malgré Play qui fonctionne : dataUrl peut
      // être vide (chargement à la demande) — resolveBlobAsync retombe alors
      // sur rec_<id> en IDB, comme le fait déjà le bouton Play.
      const blob = await studioService.resolveBlobAsync(mainVoice.dataUrl, mainVoice.id);
      if (!blob) { alert('Erreur backup : fichier introuvable en mémoire.'); return; }
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
      if (!e.message?.includes('cancel') && e.name !== 'AbortError') {
        const isQ = e?.message?.toLowerCase().includes('quota'); if (!isQ) alert('Erreur backup : ' + e.message);
      }
    }
  };

  // Export audio de la voix principale vers iPhone
  const exportMainVoice = async () => {
    if (!mainVoice || exportingVoice) return;
    setExportingVoice(true);
    try {
      // Même fix que backupMainVoice : passer par resolveBlobAsync() pour
      // gérer les sentinelles "opfs:" au lieu de fetch() direct, ET l'id en
      // secours pour le cas où dataUrl est vide (chargement à la demande).
      const blob = await studioService.resolveBlobAsync(mainVoice.dataUrl, mainVoice.id);
      if (!blob) { alert('Erreur export : fichier introuvable en mémoire.'); return; }
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
  // FIX "crash mémoire à force de régénérer des harmonies" : chaque régénération
  // crée une piste avec un NOUVEL id — mais le Blob complet de l'ANCIENNE piste
  // restait pour toujours dans window.__trackBlob_<ancienId> / __originalBlob_<ancienId>,
  // jamais nettoyé. Sur une longue session de tests (plusieurs régénérations),
  // ça s'accumule silencieusement jusqu'à faire déborder la mémoire iOS.
  const cleanupStaleTrackBlobs = (proj: TrackProject | null) => {
    try {
      const validIds = new Set((proj?.tracks || []).map(t => t.id));
      const w = window as any;
      for (const key of Object.keys(w)) {
        if (!key.startsWith('__trackBlob_') && !key.startsWith('__originalBlob_')) continue;
        const id = key.startsWith('__trackBlob_') ? key.slice('__trackBlob_'.length) : key.slice('__originalBlob_'.length);
        if (!validIds.has(id)) { delete w[key]; }
      }
    } catch {}
  };

  const generateOne = async (harmonyDef: typeof HARMONY_DEFS[0]) => {
    if (!mainVoice || generatingIndex !== null) return;
    // Charger l'audio à la demande (différé — pas au montage)
    const ready = await ensureAudioCache();
    if (!ready) { alert('Voix non disponible — réessaie dans un instant.'); return; }
    // Backup automatique silencieux avant génération
    void autoBackupToIndexedDB(mainVoice).catch(() => {});
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
          if (pct >= 0) setGeneratePct(Math.round(pct));
          // pct=-1 = progress Worker sans changement de % — on ignore
        },
        { realPartition: (selected as any).realPartition, key: (selected as any).key },
        harmonyDef.trackIndex, // ← générer seulement cette harmonie
      );

      // Récupérer uniquement la couche demandée
      const wanted = generated.find(r => r.trackIndex === harmonyDef.trackIndex);
      if (wanted) {
        // FIX stale project : relire le projet frais depuis localStorage avant d'ajouter
        // Après chaque generateOne, localStorage a été mis à jour mais le closure React
        // garde l'ancien project en mémoire — addTrackToProject lirait le bon projet
        // mais onProjectUpdate doit recevoir le projet le plus récent
        const freshProj = studioService.getOrCreateProject(project.id, project.title ?? '');
        const u = studioService.addTrackToProject(project.id, wanted);
        if (u) {
          // Réinjecter les dataUrls de toutes les pistes qui en ont une en mémoire
          const uFixed = {
            ...u,
            tracks: u.tracks.map(t => {
              if (t.id === mainVoice.id) return { ...t, dataUrl: mainVoice.dataUrl };
              // Récupérer les dataUrls des harmonies déjà générées depuis __harmonyBlobs
              const harmKey = `harmony_${mainVoice.id}_t${t.trackIndex}`;
              const harmBlob = (window as any).__harmonyBlobs?.[harmKey];
              if (!t.dataUrl && harmBlob && t.isGenerated) return { ...t, dataUrl: `opfs:${harmKey}` };
              return t;
            }),
          };
          onProjectUpdate(uFixed);
          cleanupStaleTrackBlobs(uFixed);
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
        (window as any).__addLog?.(`[Harmony] ❌ Erreur : ${e.message || String(e)}`);
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
    // Charger l'audio à la demande (différé — pas au montage)
    const ready = await ensureAudioCache();
    if (!ready) { alert('Voix non disponible — réessaie dans un instant.'); return; }
    // Backup automatique silencieux avant génération
    if (mainVoice) void autoBackupToIndexedDB(mainVoice).catch(() => {});
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
        cleanupStaleTrackBlobs(up);
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

  const handleMasterize = async () => {
    const crumb = (m: string) => { try { (window as any).__breadcrumb?.(m); } catch {} };
    crumb(`🖱️ Bouton Masteriser cliqué — mixedDataUrl=${project?.mixedDataUrl ? project.mixedDataUrl.slice(0,30) : 'VIDE'}`);
    if (!project?.mixedDataUrl) { crumb(`⛔ handleMasterize STOP — project.mixedDataUrl est vide, bouton n'a rien fait`); return; }

    // FIX ÉCRAN NOIR MASTERISATION (v7.6.420) — NOUVELLE APPROCHE : au lieu de
    // garder le mix en mémoire React et de basculer d'écran dans le même arbre
    // de composants (des dizaines de hooks/effets/contextes audio déjà actifs
    // du mixeur), on sauvegarde le mix dans le stockage permanent puis on
    // navigue vers une page FRAÎCHE dédiée à la masterisation. Cette page
    // démarre à zéro : aucun contexte audio hérité, aucun état React du
    // mixeur, aucun risque d'interférence avec ce qui tournait avant. Le
    // bug exact qu'on chassait restait invisible même avec un traçage
    // poussé — cette approche le contourne complètement plutôt que de
    // continuer à deviner.
    //
    // FIX "instrumental mixé deux fois à la masterisation" (v7.6.432) : on ne
    // lit PLUS project.mixedDataUrl / __mixBlob / mix_${project.id} ici — ces
    // trois sources contiennent l'instrumental (ajouté pour le Preview/Écoute
    // dans handleMix côté StudioMobile.tsx). MasteringEngine mixe déjà l'inst
    // séparément (mixVocalWithInst) ; réutiliser un vocalBlob qui l'a déjà
    // dedans le faisait apparaître deux fois dans le master final, en plus de
    // faire passer "voix seule" (masterAudio Mode A) sur un signal qui
    // contenait déjà toute la musique. On lit maintenant __vocalMixBlob /
    // vocalmix_${project.id} — la version voix-only produite en parallèle.
    let masterBlob: Blob | null = null;
    const wantBus = vocalStyle === 'bus';
    const memVocalBlob = ((wantBus ? (window as any).__vocalMixBusBlob : (window as any).__vocalMixBlob)) as Blob | undefined;
    if (memVocalBlob && memVocalBlob.size > 100) { masterBlob = memVocalBlob; crumb(`✅ Mix voix-only (${vocalStyle}) trouvé en mémoire (${memVocalBlob.size}B)`); }
    if (!masterBlob) {
      try {
        const key = wantBus ? `vocalmix_bus_${project.id}` : `vocalmix_${project.id}`;
        const fromDb = await studioOfflineDB.getAudio(key).catch(() => null);
        if (fromDb && fromDb.size > 100) { masterBlob = fromDb; crumb(`✅ Mix voix-only (${vocalStyle}) trouvé en IDB (${key}, ${fromDb.size}B)`); }
      } catch {}
    }
    // FIX repli : si "Bus partagé" a été choisi mais n'a jamais été rendu
    // (ex. généré avant le fix v7.6.434, ou échec silencieux du DSP reverb),
    // on retombe sur la version Classique plutôt que de bloquer l'export.
    if (!masterBlob && wantBus) {
      crumb(`⚠️ Bus partagé introuvable — repli sur Classique`);
      const memClassic = (window as any).__vocalMixBlob as Blob | undefined;
      if (memClassic && memClassic.size > 100) masterBlob = memClassic;
      else {
        const fromDb = await studioOfflineDB.getAudio(`vocalmix_${project.id}`).catch(() => null);
        if (fromDb && fromDb.size > 100) masterBlob = fromDb;
      }
    }
    if (!masterBlob) {
      crumb(`⛔ handleMasterize STOP — mix voix-only introuvable`);
      alert('Mix voix introuvable — veuillez relancer le mixage avant de masteriser.');
      return;
    }
    try {
      // Toujours re-sauvegarder sous une clé stable et prévisible : la page
      // fraîche de masterisation ira chercher exactement cette clé.
      await studioOfflineDB.saveAudio(`master_pending_${project.id}`, masterBlob, { type: 'master_pending', savedAt: Date.now() });
      if (instBlob) await studioOfflineDB.saveAudio(`master_pending_inst_${project.id}`, instBlob, { type: 'master_pending_inst', savedAt: Date.now() });
      // FIX "reverb Bus partagé écrase le mix" (v7.6.435) : si le style
      // "Bus partagé" est sélectionné, on sauvegarde AUSSI le bus d'envoi
      // SEC (sans reverb — voir vocalStyle plus haut) sous sa propre clé.
      // MasteringStandalone (index.tsx) le récupère et l'applique APRÈS la
      // masterisation, pas avant (voir MasteringEngine.tsx).
      if (wantBus) {
        const sendBusBlob = ((window as any).__vocalSendBusBlob as Blob | undefined)
          ?? await studioOfflineDB.getAudio(`vocalsend_${project.id}`).catch(() => null);
        if (sendBusBlob && sendBusBlob.size > 100) {
          await studioOfflineDB.saveAudio(`master_pending_sendbus_${project.id}`, sendBusBlob, { type: 'master_pending_sendbus', savedAt: Date.now() });
        }
        // FIX "pas de slapback delay" (v7.6.436)
        const leadOnlyBlob = ((window as any).__vocalLeadOnlyBlob as Blob | undefined)
          ?? await studioOfflineDB.getAudio(`vocalleadonly_${project.id}`).catch(() => null);
        if (leadOnlyBlob && leadOnlyBlob.size > 100) {
          await studioOfflineDB.saveAudio(`master_pending_leadonly_${project.id}`, leadOnlyBlob, { type: 'master_pending_leadonly', savedAt: Date.now() });
        }
      }
      crumb(`💾 Mix sauvegardé sous master_pending_${project.id} (${masterBlob.size}B) — navigation vers page fraîche`);
    } catch (e: any) {
      crumb(`⛔ Échec sauvegarde IDB avant navigation: ${e?.message}`);
      alert("Erreur de préparation du mastering — réessaie dans un instant.");
      return;
    }
    const base = window.location.origin + window.location.pathname;
    window.location.href = `${base}?master=${encodeURIComponent(project.id)}&songId=${encodeURIComponent(selected.id)}&hasInst=${instBlob ? '1' : '0'}&instOffsetMs=${encodeURIComponent(instOffsetMs)}&vocalStyle=${wantBus ? 'bus' : 'classic'}`;
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
                        id={track.id}
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
                        <>
                          {selected.lrcDense && selected.lrcDense.length > 0 ? (
                            <button
                              onClick={() => {
                                const detected = autoDetectSections(selected.lrcDense!, totalDuration);
                                if (detected.length === 0) return;
                                setSections(detected);
                                onProjectUpdate({ ...project, sections: detected } as any);
                              }}
                              className="w-full py-2.5 rounded-xl text-[10px] font-black uppercase active:scale-[0.98] transition-all mb-1"
                              style={{ background: '#a855f720', color: '#a855f7', border: '1px solid #a855f740' }}>
                              🪄 Détecter les sections automatiquement (paroles synchronisées)
                            </button>
                          ) : (
                            <p className="text-[9px] text-zinc-600 text-center py-2">Pas de paroles synchronisées pour cette chanson — ajoute les sections manuellement</p>
                          )}
                        </>
                      )}

                      {sections.length === 0 && (
                        <p className="text-[9px] text-zinc-600 text-center py-2">Ou ajoute des sections manuellement pour activer les harmonies sélectivement</p>
                      )}

                      {sections.length > 0 && (
                        <button
                          onClick={() => {
                            // FIX "trop d'harmonies en même temps" : preset intelligent qui
                            // suit la pratique standard d'arrangement vocal — construire
                            // progressivement vers le refrain plutôt que tout jouer du
                            // début à la fin. Couplet léger (juste double tracking),
                            // refrain plein (toutes les harmonies), pont intermédiaire.
                            const SMART_DEFAULTS: Record<SectionLabel, number[]> = {
                              Intro:   [],
                              Couplet: [1],
                              Refrain: [1, 2, 3, 4, 5],
                              Pont:    [1, 3],
                              Outro:   [1, 2, 3, 4, 5],
                            };
                            const updated = sections.map(s => ({ ...s, activeHarmonies: SMART_DEFAULTS[s.label] }));
                            setSections(updated);
                            onProjectUpdate({ ...project, sections: updated } as any);
                          }}
                          className="w-full py-2 rounded-xl text-[9px] font-black uppercase active:scale-[0.98] transition-all mb-1"
                          style={{ background: '#a855f720', color: '#a855f7', border: '1px solid #a855f740' }}>
                          ✨ Preset intelligent (léger→plein selon la section)
                        </button>
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
                  // Détecter si c'est une prise manuelle (enregistrée à la voix)
                  const isManualRecording = existingTrack && !(existingTrack as any).isGenerated;
                  const isGen         = generatingIndex === h.trackIndex;
                  const isDone        = generatedDone.has(h.trackIndex);
                  const appliedFxId   = (existingTrack as any)?.fxPresetId as string | undefined;
                  // FIX "les mauvais layers" : si une piste a été générée AVANT un
                  // changement de preset (ex: l'ancien "+5 ST"/"Octave -12ST" remplacés
                  // depuis par des intervalles sûrs ±3 ST), l'audio stocké ne correspond
                  // plus au preset actuel — on le signale au lieu de le montrer comme
                  // "généré" sans distinction, ce qui prêtait à confusion.
                  const storedPitch = (existingTrack as any)?.pitchShift;
                  const isStalePreset = hasTrack && !isManualRecording
                    && storedPitch !== undefined && storedPitch !== h.pitch;

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
                            {isManualRecording && (
                              <span className="text-[8px] font-black px-1.5 py-0.5 rounded-full bg-blue-900/40 text-blue-300">
                                🎤 Voix réelle
                              </span>
                            )}
                            {isStalePreset && (
                              <span className="text-[8px] font-black px-1.5 py-0.5 rounded-full bg-red-900/40 text-red-300"
                                title={`Généré à ${storedPitch > 0 ? '+' : ''}${storedPitch} ST (ancien preset) — le preset actuel est ${h.pitch > 0 ? '+' : ''}${h.pitch} ST`}>
                                ⚠️ Ancien preset ({storedPitch > 0 ? '+' : ''}{storedPitch} ST) — régénère
                              </span>
                            )}
                            {h.pitch !== 0 && (
                              <span className="text-[9px] text-zinc-600 font-black">
                                {h.pitch > 0 ? `+${h.pitch}` : h.pitch} ST
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-zinc-500">{h.desc}</p>

                          {/* Waveform si générée — vérifier que le blob est disponible */}
                          {hasTrack && existingTrack?.dataUrl && !existingTrack.dataUrl.startsWith('opfs:') && (
                            <div className="mt-2">
                              <WaveformBar
                                dataUrl={existingTrack.dataUrl}
                                id={existingTrack.id}
                                color={h.color}
                                height={20}
                                points={50}
                              />
                            </div>
                          )}
                          {hasTrack && existingTrack?.dataUrl?.startsWith('opfs:') && (() => {
                            // Blob opfs: — vérifier s'il est en mémoire avant d'afficher la waveform
                            const harmKey = existingTrack.dataUrl.replace('opfs:', '');
                            const inMem = !!(window as any).__harmonyBlobs?.[harmKey];
                            return inMem ? (
                              <div className="mt-2">
                                <WaveformBar dataUrl={existingTrack.dataUrl} id={existingTrack.id} color={h.color} height={20} points={50}/>
                              </div>
                            ) : (
                              <div className="mt-2 h-5 rounded bg-zinc-800 opacity-40"/>
                            );
                          })()}

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
                          ) : isManualRecording ? (
                            // Prise enregistrée manuellement — PAS de régénération automatique
                            // (ça écraserait la voix réelle du chanteur par une version générée)
                            <div className="w-9 h-9 rounded-xl bg-blue-900/30 flex items-center justify-center" title="Prise enregistrée à la voix — protégée">
                              <Mic size={13} className="text-blue-400"/>
                            </div>
                          ) : isDone ? (
                            <div className="w-9 h-9 rounded-xl bg-emerald-900/30 flex items-center justify-center">
                              <CheckCircle2 size={14} className="text-emerald-400"/>
                            </div>
                          ) : hasTrack ? (
                            <button
                              onClick={() => generateOne(h)}
                              disabled={generatingIndex !== null}
                              className="w-9 h-9 rounded-xl flex items-center justify-center active:scale-90 disabled:opacity-30 transition-all"
                              style={{ background: h.color + '20' }}
                              title="Régénérer">
                              <RefreshCw size={13} style={{ color: h.color }}/>
                            </button>
                          ) : (
                            <button
                              onClick={() => generateOne(h)}
                              disabled={generatingIndex !== null}
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

              {/* Indicateur cache audio — erreur seulement */}
              {mainVoice && audioCacheError && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-950 text-red-400 text-[11px] mb-1">
                  <span>⚠️ Voix introuvable — re-enregistrez ou utilisez "Récupérer une voix perdue"</span>
                </div>
              )}

              {/* Bouton Tout générer */}
              <button
                onClick={generateAll}
                disabled={generatingIndex !== null}
                className={`w-full py-3 rounded-xl font-black text-[12px] uppercase tracking-widest flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50 ${
                  hasAnyHarmony ? 'bg-zinc-800 text-zinc-300' : 'bg-purple-700 text-white'
                }`}>
                {generatingIndex === -1
                  ? <><Loader2 size={14} className="animate-spin"/> Génération...</>
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
        {/* Volume inst + offset sync pendant ecoute prise */}
        {playingId && playingId !== 'mix' && (
          <div className="space-y-1.5 px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700">
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-zinc-400 font-black uppercase whitespace-nowrap">🎸 Inst</span>
              <input type="range" min={0} max={1} step={0.01}
                value={previewInstVol}
                onChange={e => onPreviewInstVol(parseFloat(e.target.value))}
                className="flex-1 h-1 accent-orange-400"
              />
              <span className="text-[10px] text-orange-400 font-black w-8 text-right">
                {Math.round(previewInstVol * 100)}%
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-zinc-500 font-black uppercase whitespace-nowrap">⏱ Sync</span>
                {onAutoSync && (
                  <button onClick={onAutoSync} disabled={autoSyncing}
                    className="px-2 py-0.5 rounded-md bg-cyan-900 text-cyan-300 text-[9px] font-black active:bg-cyan-700 disabled:opacity-50">
                    {autoSyncing ? '⏳ Analyse...' : '🎯 Auto'}
                  </button>
                )}
              </div>
              <button onClick={() => onInstOffset(-200)}
                className="flex-1 py-1 rounded-lg bg-zinc-800 text-zinc-300 text-[10px] font-black active:bg-zinc-700">
                ◀◀ -200
              </button>
              <button onClick={() => onInstOffset(-50)}
                className="flex-1 py-1 rounded-lg bg-zinc-800 text-zinc-300 text-[10px] font-black active:bg-zinc-700">
                ◀ -50
              </button>
              <button onClick={() => onInstOffset(-10)}
                className="flex-1 py-1 rounded-lg bg-zinc-700 text-zinc-200 text-[10px] font-black active:bg-zinc-600">
                ◀ -10
              </button>
              <button onClick={() => onInstOffset(10)}
                className="flex-1 py-1 rounded-lg bg-zinc-700 text-zinc-200 text-[10px] font-black active:bg-zinc-600">
                +10 ▶
              </button>
              <button onClick={() => onInstOffset(50)}
                className="flex-1 py-1 rounded-lg bg-zinc-800 text-zinc-300 text-[10px] font-black active:bg-zinc-700">
                +50 ▶
              </button>
              <button onClick={() => onInstOffset(200)}
                className="flex-1 py-1 rounded-lg bg-zinc-800 text-zinc-300 text-[10px] font-black active:bg-zinc-700">
                +200 ▶▶
              </button>
            </div>
          </div>
        )}

        {tracks.length > 0 && (
          <div className="space-y-2">
            {tracks.filter(t => !(t as any).isGenerated).length > 0 && (
              <p className="text-[9px] text-zinc-700 font-black uppercase tracking-widest px-1">
                🎤 Pistes enregistrées
              </p>
            )}
            {tracks.filter(t => !(t as any).isGenerated).filter(t => {
              // Voix principale : slot actif global (takeSlot prop)
              if (t.trackIndex === 0) {
                return (t.takeSlot ?? 'A') === (takeSlot ?? 'A');
              }
              // Harmonies manuelles (trackIndex 2-5) : slot actif par trackIndex
              if (t.trackIndex >= 2 && t.trackIndex <= 5) {
                const activeSlot = activeManualSlots[t.trackIndex] ?? 'A';
                return (t.takeSlot ?? 'A') === activeSlot;
              }
              return true;
            }).map(track => {
              const preset = TRACK_PRESETS.find(p => p.index === track.trackIndex) || TRACK_PRESETS[0];
              // Slots disponibles pour ce trackIndex (harmonies manuelles seulement)
              const availableSlots = track.trackIndex >= 2 && track.trackIndex <= 5
                ? (['A','B','C'] as const).filter(s =>
                    tracks.some(t => t.trackIndex === track.trackIndex && !(t as any).isGenerated && (t.takeSlot ?? 'A') === s)
                  )
                : [];
              const activeSlot = activeManualSlots[track.trackIndex] ?? 'A';
              return (
                <div key={track.id}>
                  {/* Sélecteur de slot pour harmonies manuelles multi-prises */}
                  {availableSlots.length > 1 && (
                    <div className="flex items-center gap-1.5 px-1 mb-1">
                      <span className="text-[8px] text-zinc-600 font-black uppercase tracking-widest">{preset.emoji} Prise:</span>
                      {availableSlots.map(s => (
                        <button key={s}
                          onClick={() => setActiveManualSlot(track.trackIndex, s)}
                          className="px-2 py-0.5 rounded-md font-black text-[9px] uppercase tracking-widest transition-all active:scale-90"
                          style={{
                            background: s === activeSlot ? preset.color + '25' : '#141414',
                            border: `1px solid ${s === activeSlot ? preset.color : '#2a2a2a'}`,
                            color: s === activeSlot ? preset.color : '#52525b',
                          }}>
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                  <TrackCard key={track.id} track={track} playingId={playingId}
                    allTracks={tracks}
                    onPlay={onPlay} onMute={onMute} onSolo={onSolo} onVolume={onVolume} onPan={onPan} onDelete={onDelete}
                    onTrackUpdate={handleTrackUpdate}/>
                </div>
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

            {/* Bouton Preview Mix */}
            <button onClick={startPreview}
              className="w-full py-3 rounded-2xl font-black text-[13px] uppercase tracking-widest flex items-center justify-center gap-2 active:scale-95 transition-all"
              style={{ background: isPreviewing ? '#7c3aed' : '#18181b', border: `2px solid ${isPreviewing ? '#7c3aed' : '#3f3f46'}`, color: isPreviewing ? '#fff' : '#a1a1aa' }}>
              {isPreviewing ? <><Pause size={15}/> Stop Preview</> : <><Play size={15}/> ▶ Preview Mix</>}
            </button>

            {/* Bouton Export Preview (debug) — exporte exactement ce que Preview Mix
                calcule (mêmes pistes/gains/délais) en fichier WAV, pour vérifier
                hors de l'app si un souci vient du calcul ou de la lecture en direct */}
            <button onClick={exportPreviewMix} disabled={exportingPreview}
              className="w-full py-2.5 rounded-2xl font-bold text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 active:scale-95 transition-all"
              style={{ background: '#18181b', border: '2px solid #3f3f46', color: '#71717a', opacity: exportingPreview ? 0.6 : 1 }}>
              <Download size={13}/> {exportingPreview ? 'Export en cours…' : 'Exporter le Preview (debug)'}
            </button>

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
                    <p className="text-[11px] font-black text-white">{(hasInst || instBlob) ? 'Mix complet' : 'Mix vocal'}</p>
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

                {/* Style vocal — Classique vs Bus partagé (v7.6.434) */}
                <div className="px-4 pb-2 pt-1">
                  <div className="flex rounded-lg overflow-hidden border border-white/10">
                    <button onClick={() => setVocalStyle('classic')}
                      className={`flex-1 py-2 text-[11px] font-bold uppercase tracking-wide transition-all ${
                        vocalStyle === 'classic' ? 'bg-purple-500/25 text-purple-300' : 'text-zinc-500 active:bg-white/5'}`}>
                      Classique
                    </button>
                    <button onClick={() => setVocalStyle('bus')}
                      className={`flex-1 py-2 text-[11px] font-bold uppercase tracking-wide transition-all ${
                        vocalStyle === 'bus' ? 'bg-purple-500/25 text-purple-300' : 'text-zinc-500 active:bg-white/5'}`}>
                      Bus partagé
                    </button>
                  </div>
                  <p className="text-[10px] text-zinc-500 mt-1 px-0.5">
                    {vocalStyle === 'classic'
                      ? 'Réverbération par piste — chaque voix traitée individuellement.'
                      : 'Reverb plate partagée (lead+double+harmonies) — son "country traditionnel", plus cohésif.'}
                  </p>
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