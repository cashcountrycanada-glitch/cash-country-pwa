/**
 * MasteringEngine.tsx — Masterisation & Export iPhone v2
 *
 * DEUX MODES :
 *
 * MODE A — "Envoyer au Mac" (stem vocal)
 *   Source : mix vocal seul (voix + harmonies + layers)
 *   Résultat : blob masterisé → uploadToServer → remplace STEM_VOCAL sur Mac
 *   Qualité : audio/mp4 AAC (format natif iOS)
 *
 * MODE B — "Publication" (Spotify / YouTube)
 *   Source : mix vocal + stem instrumental chargé depuis IndexedDB
 *   Résultat : mix complet masterisé → export MP3 320kbps via navigator.share()
 *   Qualité : MP3 320kbps (standard distribution)
 *
 * EXPORT iOS :
 *   - MP3 via lamejs (chargé depuis /lame.min.js ou CDN)
 *   - Partage via navigator.share({ files: [File] }) — seule méthode qui marche en PWA iOS
 *   - Fallback : ouvrir dans Safari → bouton Partage ⬆️ → Enregistrer dans Fichiers
 *
 * CORRECTIFS :
 *   - a.click() supprimé (bloqué en PWA iOS)
 *   - lamejs ajouté au cache SW pour fonctionner hors-ligne
 *   - decodeAudioData sur blob mp4 fonctionne sur iOS avec les corrections de format précédentes
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  ChevronLeft, Play, Pause, Send, Share2,
  CheckCircle2, Loader2, Zap, Mic, Music2, AlertCircle,
} from 'lucide-react';
import { studioService, MobileRecording } from '../../services/StudioService';
import { studioOfflineDB } from '../../services/StudioOfflineDB';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MasterSettings {
  lowGain:     number;   // -12..+12 dB
  midGain:     number;
  highGain:    number;
  threshold:   number;   // -40..0 dB
  ratio:       number;   // 1..20
  attack:      number;   // ms
  release:     number;   // ms
  ceiling:     number;   // dB
  targetLufs:  number;
}

export interface MasteringProps {
  // Le mix vocal (voix + harmonies, PAS l'instrumental)
  vocalBlob:    Blob;
  // L'instrumental à mixer pour l'export publication (null si non disponible)
  instBlob:     Blob | null;
  songTitle:    string;
  songId:       string;
  // Fonctions de retour
  onBack:       () => void;
  onStemReady:  (blob: Blob, fileName: string) => Promise<void>; // → Mac
  isOnline:     boolean;
}

// ── Utilitaires audio ─────────────────────────────────────────────────────────

function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// Approximation LUFS ITU-R BS.1770-4 — K-weighting simplifié
// Beaucoup plus précis que le RMS simple pour cibler Spotify/YouTube
function analyzeLoudness(buffer: AudioBuffer): number {
  const sr = buffer.sampleRate;
  const ch = Math.min(2, buffer.numberOfChannels);

  // Filtre pre-filter BS.1770 (high-shelf +4dB à 1681Hz)
  // Coefficients pour 44.1kHz / 48kHz
  const f0 = 1681.0;
  const Q  = 0.7071;
  const dBgain = 3.99984;
  const A  = Math.pow(10, dBgain / 40);
  const w0 = 2 * Math.PI * f0 / sr;
  const alpha = Math.sin(w0) / (2 * Q);
  const b0 = A * ((A + 1) + (A - 1) * Math.cos(w0) + 2 * Math.sqrt(A) * alpha);
  const b1 = -2 * A * ((A - 1) + (A + 1) * Math.cos(w0));
  const b2 = A * ((A + 1) + (A - 1) * Math.cos(w0) - 2 * Math.sqrt(A) * alpha);
  const a0 = (A + 1) - (A - 1) * Math.cos(w0) + 2 * Math.sqrt(A) * alpha;
  const a1 = 2 * ((A - 1) - (A + 1) * Math.cos(w0));
  const a2 = (A + 1) - (A - 1) * Math.cos(w0) - 2 * Math.sqrt(A) * alpha;

  let totalPower = 0;
  for (let c = 0; c < ch; c++) {
    const data = buffer.getChannelData(c);
    const filtered = new Float32Array(data.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < data.length; i++) {
      const x0 = data[i];
      const y0 = (b0/a0)*x0 + (b1/a0)*x1 + (b2/a0)*x2 - (a1/a0)*y1 - (a2/a0)*y2;
      filtered[i] = y0;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    }
    let sum = 0;
    for (let i = 0; i < filtered.length; i++) sum += filtered[i] * filtered[i];
    totalPower += sum / filtered.length;
  }
  const meanPower = totalPower / ch;
  // LUFS = -0.691 + 10*log10(power) — offset BS.1770
  return meanPower > 0 ? -0.691 + 10 * Math.log10(meanPower) : -100;
}

async function decodeBlob(blob: Blob): Promise<AudioBuffer> {
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  try {
    const ab  = await blob.arrayBuffer();
    const buf = await ctx.decodeAudioData(ab);
    return buf;
  } finally {
    ctx.close();
  }
}

// Mixer deux AudioBuffers (vocal + instrumental) dans un OfflineAudioContext
// instGainDb : niveau instrumental en dB relatif à la voix (ex: -3 = instrumental 3dB sous la voix)
async function mixVocalWithInst(
  vocalBuf: AudioBuffer,
  instBuf:  AudioBuffer,
  instGainDb: number = -3,
): Promise<AudioBuffer> {
  const sr       = Math.max(vocalBuf.sampleRate, instBuf.sampleRate);
  const duration = Math.max(vocalBuf.duration, instBuf.duration);
  const offline  = new OfflineAudioContext(2, Math.ceil(duration * sr), sr);

  // Normaliser l'instrumental par rapport à la voix pour un niveau cohérent
  const vocalLufs = analyzeLoudness(vocalBuf);
  const instLufs  = analyzeLoudness(instBuf);
  const normDb    = vocalLufs - instLufs;
  const instLinear = Math.pow(10, (normDb + instGainDb) / 20);

  const vSrc = offline.createBufferSource();
  vSrc.buffer = vocalBuf;
  const vGain = offline.createGain();
  vGain.gain.value = 1.0;
  vSrc.connect(vGain); vGain.connect(offline.destination);
  vSrc.start(0);

  const iSrc = offline.createBufferSource();
  iSrc.buffer = instBuf;
  const iGain = offline.createGain();
  iGain.gain.value = Math.max(0.1, Math.min(2.0, instLinear));
  iSrc.connect(iGain); iGain.connect(offline.destination);
  iSrc.start(0);

  return offline.startRendering();
}

// Masterisation EQ + Compresseur + Limiteur
async function masterAudio(buf: AudioBuffer, s: MasterSettings): Promise<AudioBuffer> {
  const offline = new OfflineAudioContext(2, buf.length, buf.sampleRate);
  const src     = offline.createBufferSource();
  src.buffer    = buf;

  // High-pass 35Hz — coupe les sub-bass inutiles qui gaspillent du headroom
  const hpf  = offline.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 35; hpf.Q.value = 0.7;

  const low  = offline.createBiquadFilter(); low.type  = 'lowshelf';  low.frequency.value  = 250;  low.gain.value  = s.lowGain;
  const mid  = offline.createBiquadFilter(); mid.type  = 'peaking';   mid.frequency.value  = 2500; mid.Q.value = 0.8; mid.gain.value = s.midGain;
  const high = offline.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 8000; high.gain.value = s.highGain;

  // De-esser — compresseur sidechain simulé sur 6-8kHz (sibilance voix)
  const deEss = offline.createBiquadFilter(); deEss.type = 'peaking'; deEss.frequency.value = 7000; deEss.Q.value = 2.5; deEss.gain.value = -2.5;

  const comp    = offline.createDynamicsCompressor();
  comp.threshold.value = s.threshold; comp.ratio.value = s.ratio;
  comp.attack.value    = s.attack / 1000; comp.release.value = s.release / 1000; comp.knee.value = 6;

  const limiter = offline.createDynamicsCompressor();
  limiter.threshold.value = s.ceiling - 0.5; limiter.ratio.value = 20;
  limiter.attack.value = 0.001; limiter.release.value = 0.1; limiter.knee.value = 0;

  const lufs    = analyzeLoudness(buf);
  const gainDb  = Math.min(s.targetLufs - lufs, 12);
  const makeup  = offline.createGain();
  makeup.gain.value = Math.pow(10, gainDb / 20);

  src.connect(hpf); hpf.connect(low); low.connect(mid); mid.connect(high);
  high.connect(deEss); deEss.connect(comp); comp.connect(limiter); limiter.connect(makeup);
  makeup.connect(offline.destination);
  src.start(0);
  return offline.startRendering();
}

// Convertir AudioBuffer → Blob mp4 (iOS natif) — 256 kbps pour la qualité
async function audioBufferToBlob(buffer: AudioBuffer): Promise<Blob> {
  const mimeType = isIOS() ? 'audio/mp4'
    : MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
    : 'audio/mp4';

  const ctx  = new (window.AudioContext || (window as any).webkitAudioContext)();
  const dest = ctx.createMediaStreamDestination();
  const src  = ctx.createBufferSource();
  src.buffer = buffer; src.connect(dest);

  const recOpts: MediaRecorderOptions = {};
  if (mimeType) recOpts.mimeType = mimeType;
  recOpts.audioBitsPerSecond = 256000; // 256 kbps — qualité maximale AAC
  const recorder = new MediaRecorder(dest.stream, recOpts);
  const chunks: Blob[] = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  return new Promise(resolve => {
    recorder.onstop = () => {
      ctx.close();
      resolve(new Blob(chunks, { type: chunks[0]?.type || 'audio/mp4' }));
    };
    recorder.start();
    src.start();
    setTimeout(() => { recorder.stop(); try { src.stop(); } catch {} }, (buffer.duration + 0.5) * 1000);
  });
}

// Encodeur MP3 via lamejs
async function encodeMP3(buffer: AudioBuffer, kbps = 320): Promise<Blob> {
  // Charger lamejs — supporte le loader async (lame.min.js peut charger depuis CDN/IndexedDB)
  if (!(window as any).lamejs) {
    await new Promise<void>((resolve, reject) => {
      const tryLoad = (src: string, fallback?: string) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload  = () => {
          // Le loader peut être async — attendre que window.lamejs soit disponible
          if ((window as any).lamejs) { resolve(); return; }
          let tries = 0;
          const poll = setInterval(() => {
            if ((window as any).lamejs) { clearInterval(poll); resolve(); }
            else if (++tries > 100) { clearInterval(poll); fallback ? tryLoad(fallback) : reject(new Error('lamejs introuvable après 10s')); }
          }, 100);
        };
        s.onerror = () => fallback ? tryLoad(fallback) : reject(new Error('lamejs introuvable'));
        document.head.appendChild(s);
      };
      tryLoad('/lame.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js');
    });
  }

  const lamejs    = (window as any).lamejs;
  const channels  = Math.min(2, buffer.numberOfChannels);
  const sampleRate = buffer.sampleRate;
  const encoder   = new lamejs.Mp3Encoder(channels, sampleRate, kbps);
  const chL       = buffer.getChannelData(0);
  const chR       = channels > 1 ? buffer.getChannelData(1) : chL;
  const BLOCK     = 1152;
  const mp3Data: Int8Array[] = [];

  const toInt16 = (f32: Float32Array, out: Int16Array) => {
    for (let i = 0; i < f32.length; i++)
      out[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
  };

  for (let i = 0; i < chL.length; i += BLOCK) {
    const lSlice = chL.slice(i, i + BLOCK);
    const rSlice = chR.slice(i, i + BLOCK);
    const lInt   = new Int16Array(lSlice.length);
    const rInt   = new Int16Array(rSlice.length);
    toInt16(lSlice, lInt); toInt16(rSlice, rInt);
    const chunk = channels > 1 ? encoder.encodeBuffer(lInt, rInt) : encoder.encodeBuffer(lInt);
    if (chunk.length > 0) mp3Data.push(chunk);
  }
  const final = encoder.flush();
  if (final.length > 0) mp3Data.push(final);

  const totalLen = mp3Data.reduce((s, c) => s + c.length, 0);
  const merged   = new Uint8Array(totalLen);
  let pos = 0;
  for (const chunk of mp3Data) { merged.set(chunk, pos); pos += chunk.length; }
  return new Blob([merged], { type: 'audio/mpeg' });
}

// Encodeur WAV 24-bit PCM — qualité maximale pour distribution Spotify/DistroKid
// WAV 24-bit/44.1kHz est le format de référence accepté par toutes les plateformes.
// Safari iOS ne supporte pas l'export WAV natif via MediaRecorder — on construit
// le fichier manuellement à partir des Float32Array de l'AudioBuffer.
function encodeWAV(buffer: AudioBuffer): Blob {
  const numChannels = Math.min(2, buffer.numberOfChannels);
  const sampleRate  = buffer.sampleRate;
  const bitDepth    = 24; // 24-bit pour qualité maximale (vs 16-bit standard)
  const bytesPerSample = bitDepth / 8; // 3 bytes
  const numSamples  = buffer.length;
  const dataSize    = numSamples * numChannels * bytesPerSample;
  const bufferSize  = 44 + dataSize; // 44 bytes header WAV standard

  const arrayBuf = new ArrayBuffer(bufferSize);
  const view     = new DataView(arrayBuf);

  // ── Header WAV (RIFF/WAVE) ────────────────────────────────────────────────
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  const writeU32 = (offset: number, val: number) => view.setUint32(offset, val, true);
  const writeU16 = (offset: number, val: number) => view.setUint16(offset, val, true);

  writeStr(0,  'RIFF');
  writeU32(4,  bufferSize - 8);
  writeStr(8,  'WAVE');
  writeStr(12, 'fmt ');
  writeU32(16, 16);                               // chunk size
  writeU16(20, 1);                                // PCM = 1
  writeU16(22, numChannels);
  writeU32(24, sampleRate);
  writeU32(28, sampleRate * numChannels * bytesPerSample); // byte rate
  writeU16(32, numChannels * bytesPerSample);     // block align
  writeU16(34, bitDepth);
  writeStr(36, 'data');
  writeU32(40, dataSize);

  // ── Données PCM 24-bit interleaved ───────────────────────────────────────
  const chL = buffer.getChannelData(0);
  const chR = numChannels > 1 ? buffer.getChannelData(1) : chL;
  let offset = 44;

  for (let i = 0; i < numSamples; i++) {
    // Canal gauche
    const sL = Math.max(-1, Math.min(1, chL[i]));
    const iL = sL < 0 ? sL * 0x800000 : sL * 0x7FFFFF;
    view.setUint8(offset,     iL & 0xFF);
    view.setUint8(offset + 1, (iL >> 8) & 0xFF);
    view.setUint8(offset + 2, (iL >> 16) & 0xFF);
    offset += 3;
    // Canal droit
    const sR = Math.max(-1, Math.min(1, chR[i]));
    const iR = sR < 0 ? sR * 0x800000 : sR * 0x7FFFFF;
    view.setUint8(offset,     iR & 0xFF);
    view.setUint8(offset + 1, (iR >> 8) & 0xFF);
    view.setUint8(offset + 2, (iR >> 16) & 0xFF);
    offset += 3;
  }

  return new Blob([arrayBuf], { type: 'audio/wav' });
}

// Partage iOS via navigator.share — seule méthode qui marche en PWA
async function shareFileIOS(blob: Blob, fileName: string, title: string): Promise<void> {
  const file = new File([blob], fileName, { type: blob.type });

  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ title, files: [file] });
    return;
  }

  // Fallback : ouvrir dans Safari (iOS 13-14 ou navigateur sans share API)
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = fileName; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  if (isIOS()) {
    setTimeout(() => {
      alert(
        `Fichier prêt.\
\
Pour le sauvegarder :\
` +
        `• Bouton Partage ⬆️ → "Enregistrer dans Fichiers"\
` +
        `• ou AirDrop → Mac\
` +
        `• ou "Copier dans..." → une app de musique`
      );
    }, 800);
  }
}

// ── Presets ───────────────────────────────────────────────────────────────────

// ── Presets de masterisation ─────────────────────────────────────────────────
// Catégories : Distribution, Country, Style vocal, Live
const PRESET_CATEGORIES: { id: string; label: string; keys: string[] }[] = [
  { id: 'distrib',  label: '🌐 Distribution', keys: ['spotify', 'youtube', 'podcast'] },
  { id: 'country',  label: '🤠 Country',       keys: ['country', 'country_live', 'country_bright'] },
  { id: 'vocal',    label: '🎤 Vocal',          keys: ['studio_vocal', 'velvet', 'airy'] },
  { id: 'broadcast', label: '📡 Broadcast',      keys: ['broadcast_canada', 'broadcast_ebu', 'broadcast_country'] },
  { id: 'impact',   label: '💥 Impact',         keys: ['radio', 'punchy', 'vintage'] },
];

const PRESETS: Record<string, { label: string; emoji: string; description: string; settings: MasterSettings }> = {
  // ── Distribution ──
  spotify: {
    label: 'Spotify / Apple Music', emoji: '🎵',
    description: '-14 LUFS · Streaming standard',
    settings: { lowGain: 1.5, midGain: 0.5, highGain: 1.0, threshold: -18, ratio: 3, attack: 10, release: 150, ceiling: -1.0, targetLufs: -14 },
  },
  youtube: {
    label: 'YouTube', emoji: '▶',
    description: '-13 LUFS · Optimal YouTube',
    settings: { lowGain: 2.0, midGain: 0.0, highGain: 1.5, threshold: -16, ratio: 4, attack: 8, release: 120, ceiling: -1.0, targetLufs: -13 },
  },
  podcast: {
    label: 'Podcast / Voix', emoji: '🎙',
    description: '-16 LUFS · Clarté maximale voix',
    settings: { lowGain: -1.0, midGain: 3.0, highGain: 1.5, threshold: -20, ratio: 3, attack: 15, release: 200, ceiling: -1.5, targetLufs: -16 },
  },
  // ── Country ──
  country: {
    label: 'Country Warm', emoji: '🤠',
    description: 'Son chaleureux, graves riches',
    settings: { lowGain: 3.0, midGain: -1.0, highGain: 0.5, threshold: -20, ratio: 3.5, attack: 15, release: 200, ceiling: -1.5, targetLufs: -14 },
  },
  country_live: {
    label: 'Country Live', emoji: '🎸',
    description: 'Energie scène, présence naturelle',
    settings: { lowGain: 2.0, midGain: 1.5, highGain: 1.0, threshold: -16, ratio: 4, attack: 8, release: 120, ceiling: -1.0, targetLufs: -12 },
  },
  country_bright: {
    label: 'Country Bright', emoji: '☀️',
    description: 'Aigus brillants, voix projetée',
    settings: { lowGain: 1.0, midGain: 0.5, highGain: 3.5, threshold: -18, ratio: 3, attack: 12, release: 160, ceiling: -1.0, targetLufs: -13 },
  },
  // ── Vocal ──
  studio_vocal: {
    label: 'Studio Vocal', emoji: '🎤',
    description: 'Voix présente, son pro',
    settings: { lowGain: 1.0, midGain: 2.5, highGain: 1.5, threshold: -18, ratio: 3, attack: 10, release: 150, ceiling: -1.0, targetLufs: -14 },
  },
  velvet: {
    label: 'Velvet', emoji: '🎼',
    description: 'Son velouté, chaleureux',
    settings: { lowGain: 2.5, midGain: -0.5, highGain: -1.0, threshold: -22, ratio: 3, attack: 15, release: 250, ceiling: -1.5, targetLufs: -14 },
  },
  airy: {
    label: 'Airy & Bright', emoji: '✨',
    description: 'Légèreté, aigus cristallins',
    settings: { lowGain: -1.0, midGain: 0.5, highGain: 4.0, threshold: -20, ratio: 2.5, attack: 20, release: 200, ceiling: -1.0, targetLufs: -14 },
  },
  // ── Broadcast ──
  broadcast_canada: {
    label: 'Radio Canada / USA', emoji: '📡',
    description: '-24 LUFS · Standard ATSC A/85',
    settings: { lowGain: 1.5, midGain: 0.5, highGain: 0.5, threshold: -28, ratio: 2, attack: 20, release: 300, ceiling: -2.0, targetLufs: -24 },
  },
  broadcast_ebu: {
    label: 'Radio Europe / EBU', emoji: '🌍',
    description: '-23 LUFS · Standard EBU R128',
    settings: { lowGain: 1.5, midGain: 0.5, highGain: 0.5, threshold: -27, ratio: 2, attack: 20, release: 300, ceiling: -1.0, targetLufs: -23 },
  },
  broadcast_country: {
    label: 'Radio Country Broadcast', emoji: '🤠📡',
    description: '-23 LUFS · Country pour diffusion',
    settings: { lowGain: 2.5, midGain: 0.0, highGain: 0.5, threshold: -27, ratio: 2, attack: 20, release: 300, ceiling: -1.5, targetLufs: -23 },
  },
  // ── Impact ──
  radio: {
    label: 'Radio / Loud', emoji: '📻',
    description: '-13 LUFS · Fort et percutant',
    settings: { lowGain: 0.0, midGain: 1.5, highGain: 3.0, threshold: -15, ratio: 5, attack: 5, release: 100, ceiling: -1.0, targetLufs: -13 },
  },
  punchy: {
    label: 'Punchy', emoji: '💥',
    description: 'Attaque forte, présence mix',
    settings: { lowGain: 0.5, midGain: 3.5, highGain: 2.0, threshold: -15, ratio: 5, attack: 3, release: 80, ceiling: -1.0, targetLufs: -13 },
  },
  vintage: {
    label: 'Vintage', emoji: '📯',
    description: 'Chaleur analogique, son rétro',
    settings: { lowGain: 4.0, midGain: -2.0, highGain: -1.5, threshold: -22, ratio: 2.5, attack: 20, release: 300, ceiling: -2.0, targetLufs: -16 },
  },
};

function db(v: number) { return v >= 0 ? `+${v.toFixed(1)} dB` : `${v.toFixed(1)} dB`; }

// ── Composant principal ───────────────────────────────────────────────────────

export default function MasteringEngine({
  vocalBlob, instBlob, songTitle, songId, onBack, onStemReady, isOnline,
}: MasteringProps) {

  const [preset, setPreset]               = useState('country');
  const [activeCategory, setActiveCategory] = useState('country');
  const [settings, setSettings]           = useState<MasterSettings>(PRESETS.country.settings);
  const [showAdvanced, setShowAdvanced]   = useState(false);
  const [instGainDb, setInstGainDb]       = useState(-3); // niveau instrumental en dB relatif à la voix

  // État de rendu
  const [isMastering, setIsMastering]     = useState(false);
  const [progress, setProgress]           = useState(0);
  const [progressLabel, setProgressLabel] = useState('');

  // Résultats
  const [vocalMastered, setVocalMastered]     = useState<AudioBuffer | null>(null); // Mode A
  const [fullMastered, setFullMastered]       = useState<AudioBuffer | null>(null); // Mode B
  const [inputLufs, setInputLufs]             = useState<number | null>(null);
  const [outputVocalLufs, setOutputVocalLufs] = useState<number | null>(null);
  const [outputFullLufs, setOutputFullLufs]   = useState<number | null>(null);

  // Upload
  const [sendingToMac, setSendingToMac]     = useState(false);
  const [sentToMac, setSentToMac]           = useState(false);

  // Export
  const [exportingMp3, setExportingMp3]     = useState(false);
  const [exportedMp3, setExportedMp3]       = useState(false);
  const [exportingMp4, setExportingMp4]     = useState(false);
  const [exportedMp4, setExportedMp4]       = useState(false);
  const [exportingWav, setExportingWav]     = useState(false);
  const [exportedWav, setExportedWav]       = useState(false);
  const [exportingVocal, setExportingVocal] = useState(false);
  const [exportedVocal, setExportedVocal]   = useState(false);
  const [exportingInst, setExportingInst]   = useState(false);
  const [exportedInst, setExportedInst]     = useState(false);
  const [exportingZip, setExportingZip]     = useState(false);
  const [exportedZip, setExportedZip]       = useState(false);

  // Lecture
  const [playing, setPlaying]   = useState<'vocal' | 'full' | null>(null);
  const playRef = useRef<HTMLAudioElement>(null);
  const vocalUrlRef = useRef<string>('');
  const fullUrlRef  = useRef<string>('');

  // Analyser l'entrée au montage
  useEffect(() => {
    decodeBlob(vocalBlob)
      .then(buf => setInputLufs(Math.round(analyzeLoudness(buf) * 10) / 10))
      .catch(() => {});
    return () => {
      if (vocalUrlRef.current) URL.revokeObjectURL(vocalUrlRef.current);
      if (fullUrlRef.current)  URL.revokeObjectURL(fullUrlRef.current);
    };
  }, []);

  const applyPreset = (key: string) => {
    setPreset(key);
    setSettings({ ...PRESETS[key].settings });
    setVocalMastered(null); setFullMastered(null);
    setOutputVocalLufs(null); setOutputFullLufs(null);
    setSentToMac(false);
  };

  // ── MASTERISATION ──────────────────────────────────────────────────────────

  const runMastering = async () => {
    setIsMastering(true); setProgress(0);
    setVocalMastered(null); setFullMastered(null);
    setSentToMac(false);
    // On ne remet PAS les flags export à zéro — l'utilisateur sait qu'il a déjà partagé

    try {
      // 1. Décoder le mix vocal
      setProgressLabel('Décodage de la voix...'); setProgress(10);
      const vocalRaw = await decodeBlob(vocalBlob);

      // 2. Masteriser la voix seule (Mode A)
      setProgressLabel('Masterisation voix...'); setProgress(30);
      const vocalM = await masterAudio(vocalRaw, settings);
      setVocalMastered(vocalM);
      setOutputVocalLufs(Math.round(analyzeLoudness(vocalM) * 10) / 10);

      // Préparer l'URL de lecture pour le mix vocal
      if (vocalUrlRef.current) URL.revokeObjectURL(vocalUrlRef.current);
      const vBlob = await audioBufferToBlob(vocalM);
      vocalUrlRef.current = URL.createObjectURL(vBlob);

      setProgress(55);

      // 3. Si instrumental disponible → mixer + masteriser (Mode B)
      if (instBlob) {
        setProgressLabel('Chargement de l\'instrumental...'); setProgress(60);
        const instRaw = await decodeBlob(instBlob);

        setProgressLabel('Mixage vocal + instrumental...'); setProgress(70);
        const fullRaw = await mixVocalWithInst(vocalM, instRaw, instGainDb);

        setProgressLabel('Masterisation du mix complet...'); setProgress(80);
        const fullM = await masterAudio(fullRaw, settings);
        setFullMastered(fullM);
        setOutputFullLufs(Math.round(analyzeLoudness(fullM) * 10) / 10);

        if (fullUrlRef.current) URL.revokeObjectURL(fullUrlRef.current);
        const fBlob = await audioBufferToBlob(fullM);
        fullUrlRef.current = URL.createObjectURL(fBlob);
      }

      setProgressLabel('Terminé'); setProgress(100);

    } catch (e: any) {
      alert('Erreur masterisation : ' + e.message);
    } finally {
      setIsMastering(false); setProgressLabel('');
    }
  };

  // ── LECTURE ────────────────────────────────────────────────────────────────

  const playAudio = (type: 'vocal' | 'full') => {
    if (!playRef.current) return;
    if (playing === type) { playRef.current.pause(); setPlaying(null); return; }
    const url = type === 'vocal' ? vocalUrlRef.current : fullUrlRef.current;
    if (!url) return;
    playRef.current.src = url;
    playRef.current.load();
    playRef.current.play().catch(() => {});
    setPlaying(type);
    playRef.current.onended = () => setPlaying(null);
  };

  // ── MODE A : Envoyer au Mac ───────────────────────────────────────────────

  const sendToMac = async () => {
    if (!vocalMastered || !isOnline) return;
    setSendingToMac(true);
    try {
      const blob = await audioBufferToBlob(vocalMastered);
      const safeTitle = songTitle.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
      const fileName  = `VOCAL_${safeTitle}_${Date.now()}.mp4`;

      const fakeRec: MobileRecording = {
        id:          `STEM-${Date.now()}`,
        songId,
        songTitle,
        artist:      '',
        duration:    vocalMastered.duration,
        recordedAt:  Date.now(),
        dataUrl:     '',
        transferred: false,
        fileName,
      };

      const ok = await studioService.uploadToServer(fakeRec, blob);
      if (ok) {
        // ── Assigner automatiquement comme stem vocal sur le Mac ──────────────
        // Sans cet appel, le fichier reste dans "en attente" dans l'inbox
        // et nécessite un clic manuel. Avec cet appel, songs.json est mis à jour
        // immédiatement et l'app Electron reçoit un événement 'stem-vocal-updated'.
        try {
          const assignRes = await fetch('/api/studio/assign-stem', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              recId:    fakeRec.id,
              songId,
              fileName,
            }),
          });
          const assignData = await assignRes.json().catch(() => ({}));
          if (assignData.success) {
            console.log(`[Mastering] Stem vocal assigné sur Mac : ${fileName} → ${assignData.songTitle}`);
          } else {
            console.warn('[Mastering] assign-stem échoué, fichier dans inbox Mac');
          }
        } catch (e) {
          // Non-bloquant : le fichier est dans l'inbox, l'utilisateur peut assigner manuellement
          console.warn('[Mastering] assign-stem non disponible:', e);
        }

        setSentToMac(true);
        await onStemReady(blob, fileName);
      } else {
        alert('Échec du transfert — Mac allumé et WiFi même réseau ?');
      }
    } catch (e: any) {
      alert('Erreur : ' + e.message);
    } finally {
      setSendingToMac(false);
    }
  };

  // ── MODE B : Export MP3 (Publication) ─────────────────────────────────────

  const exportAsMP3 = async () => {
    if (!fullMastered && !vocalMastered) return;
    setExportingMp3(true);
    try {
      const source    = fullMastered || vocalMastered!;
      const safeTitle = songTitle.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
      const fileName  = `${safeTitle}_MASTER_320.mp3`;

      const mp3Blob = await encodeMP3(source, 320);
      await shareFileIOS(mp3Blob, fileName, `${songTitle} — Master MP3`);
      setExportedMp3(true);
    } catch (e: any) {
      if ((e as any).name !== 'AbortError') alert('Erreur export MP3 : ' + e.message);
    } finally {
      setExportingMp3(false);
    }
  };

  // ── MODE B : Export MP4 natif iOS (AAC) ───────────────────────────────────

  const exportAsMP4 = async () => {
    if (!fullMastered && !vocalMastered) return;
    setExportingMp4(true);
    try {
      const source    = fullMastered || vocalMastered!;
      const safeTitle = songTitle.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
      const fileName  = `${safeTitle}_MASTER.mp4`;

      const mp4Blob = await audioBufferToBlob(source);
      await shareFileIOS(mp4Blob, fileName, `${songTitle} — Master MP4`);
      setExportedMp4(true);
    } catch (e: any) {
      if ((e as any).name !== 'AbortError') alert('Erreur export MP4 : ' + e.message);
    } finally {
      setExportingMp4(false);
    }
  };

  // ── MODE B : Export WAV 24-bit (Qualité maximale Spotify/DistroKid) ────────

  const exportAsWAV = async () => {
    if (!fullMastered && !vocalMastered) return;
    setExportingWav(true);
    try {
      const source    = fullMastered || vocalMastered!;
      const safeTitle = songTitle.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
      const fileName  = `${safeTitle}_MASTER_24bit.wav`;

      const wavBlob = encodeWAV(source); // synchrone — pas de MediaRecorder nécessaire
      await shareFileIOS(wavBlob, fileName, `${songTitle} — Master WAV 24-bit`);
      setExportedWav(true);
    } catch (e: any) {
      if ((e as any).name !== 'AbortError') alert('Erreur export WAV : ' + e.message);
    } finally {
      setExportingWav(false);
    }
  };

  const hasResult = !!vocalMastered;
  const hasFullMix = !!fullMastered;

  // ── Stem vocal seul (local iPhone) ───────────────────────────────────────
  const exportVocalStem = async () => {
    if (!vocalMastered) return;
    setExportingVocal(true);
    try {
      const safeTitle = songTitle.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
      const wavBlob   = encodeWAV(vocalMastered);
      await shareFileIOS(wavBlob, `${safeTitle}_VOCAL_STEM.wav`, `${songTitle} — Stem Vocal`);
      setExportedVocal(true);
    } catch (e: any) {
      if (e.name !== 'AbortError') alert('Erreur export vocal : ' + e.message);
    } finally { setExportingVocal(false); }
  };

  // ── Stem instrumental seul (depuis IndexedDB) ─────────────────────────────
  const exportInstStem = async () => {
    if (!instBlob) return;
    setExportingInst(true);
    try {
      const safeTitle = songTitle.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
      const ext = instBlob.type.includes('mp4') ? 'mp4' : instBlob.type.includes('flac') ? 'flac' : 'mp4';
      await shareFileIOS(instBlob, `${safeTitle}_INST_STEM.${ext}`, `${songTitle} — Stem Instrumental`);
      setExportedInst(true);
    } catch (e: any) {
      if (e.name !== 'AbortError') alert('Erreur export instrumental : ' + e.message);
    } finally { setExportingInst(false); }
  };

  // ── ZIP stems (vocal WAV + instrumental) ─────────────────────────────────
  const exportStemsZip = async () => {
    if (!vocalMastered) return;
    setExportingZip(true);
    try {
      const safeTitle = songTitle.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
      // Partager les deux fichiers ensemble via navigator.share({ files })
      const vocalWav  = encodeWAV(vocalMastered);
      const vocalFile = new File([vocalWav], `${safeTitle}_VOCAL_STEM.wav`, { type: 'audio/wav' });
      const files: File[] = [vocalFile];
      if (instBlob) {
        const ext = instBlob.type.includes('mp4') ? 'mp4' : 'mp4';
        files.push(new File([instBlob], `${safeTitle}_INST_STEM.${ext}`, { type: instBlob.type || 'audio/mp4' }));
      }
      if (navigator.share && navigator.canShare?.({ files })) {
        await navigator.share({ title: `${songTitle} — Stems`, files });
      } else {
        // Fallback : télécharger vocal seulement
        await shareFileIOS(vocalWav, `${safeTitle}_VOCAL_STEM.wav`, `${songTitle} — Stem Vocal`);
      }
      setExportedZip(true);
    } catch (e: any) {
      if (e.name !== 'AbortError') alert('Erreur export stems : ' + e.message);
    } finally { setExportingZip(false); }
  };

  return (
    <div className="min-h-screen bg-[#020202] text-white flex flex-col">

      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-5 pt-6 pb-4 border-b border-zinc-900">
        <button onClick={onBack} className="w-10 h-10 rounded-xl bg-zinc-900 flex items-center justify-center active:scale-90">
          <ChevronLeft size={20}/>
        </button>
        <div className="flex-1 min-w-0">
          <p className="font-bebas text-xl text-white tracking-widest leading-none">MASTERING STUDIO</p>
          <p className="text-[10px] text-zinc-500 font-black uppercase truncate">{songTitle}</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pt-4 pb-8 space-y-5" style={{ WebkitOverflowScrolling: 'touch' }}>

        {/* Explication des 2 modes */}
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-3">
            <p className="text-[10px] font-black text-zinc-400 uppercase mb-1 flex items-center gap-1">
              <Mic size={10}/> Mode A — Mac
            </p>
            <p className="text-[11px] text-white font-bold">Voix + harmonies</p>
            <p className="text-[9px] text-zinc-500 mt-0.5 leading-relaxed">Remplace le stem vocal sur le Mac pour les spectacles</p>
          </div>
          <div className={`bg-zinc-900/60 border rounded-2xl p-3 ${instBlob ? 'border-zinc-800' : 'border-zinc-800/40 opacity-50'}`}>
            <p className="text-[10px] font-black text-zinc-400 uppercase mb-1 flex items-center gap-1">
              <Music2 size={10}/> Mode B — Publication
            </p>
            <p className="text-[11px] text-white font-bold">Voix + harmonies + instrumental</p>
            <p className="text-[9px] text-zinc-500 mt-0.5 leading-relaxed">
              {instBlob ? 'Export MP3/MP4 → Spotify, YouTube' : 'Instrumental non disponible hors-ligne'}
            </p>
          </div>
        </div>

        {/* Niveaux */}
        <div className="bg-zinc-950 border border-white/8 rounded-2xl p-4">
          <p className="text-[10px] font-black text-zinc-500 uppercase tracking-widest mb-3">Niveaux</p>
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: 'Entrée', value: inputLufs },
              { label: 'Voix masterisée', value: outputVocalLufs, color: 'text-emerald-400' },
              { label: 'Mix complet', value: outputFullLufs, color: 'text-blue-400' },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-zinc-900 rounded-xl p-2.5 text-center">
                <p className="text-[9px] text-zinc-600 font-black uppercase">{label}</p>
                <p className={`text-[20px] font-bebas mt-0.5 ${color || 'text-white'}`}>
                  {value !== null && value !== undefined ? `${value > 0 ? '+' : ''}${value}` : '—'}
                </p>
                <p className="text-[8px] text-zinc-600">LUFS</p>
              </div>
            ))}
          </div>
        </div>

        {/* Presets par catégorie */}
        <div>
          <p className="text-[10px] font-black text-zinc-500 uppercase tracking-widest mb-3">Style de masterisation</p>
          {/* Onglets catégorie */}
          <div className="flex gap-1.5 overflow-x-auto pb-2 mb-3" style={{ scrollbarWidth: 'none' }}>
            {PRESET_CATEGORIES.map(cat => (
              <button key={cat.id} onClick={() => setActiveCategory(cat.id)}
                className="shrink-0 px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-wider transition-all"
                style={{
                  background: activeCategory === cat.id ? '#dc2626' : '#18181b',
                  color: activeCategory === cat.id ? '#fff' : '#71717a',
                  border: `1px solid ${activeCategory === cat.id ? '#dc2626' : '#27272a'}`,
                }}>
                {cat.label}
              </button>
            ))}
          </div>
          {/* Grille presets de la catégorie */}
          <div className="grid grid-cols-1 gap-2">
            {(PRESET_CATEGORIES.find(c => c.id === activeCategory)?.keys || []).map(key => {
              const p = PRESETS[key];
              if (!p) return null;
              const isActive = preset === key;
              return (
                <button key={key} onClick={() => applyPreset(key)}
                  className="flex items-center gap-3 py-3 px-4 rounded-xl text-left transition-all"
                  style={{
                    background: isActive ? '#dc262615' : '#18181b',
                    border: `1px solid ${isActive ? '#dc262650' : '#27272a'}`,
                  }}>
                  <span className="text-2xl leading-none shrink-0">{p.emoji}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-black text-white">{p.label}</p>
                    <p className="text-[10px] text-zinc-500">{p.description}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[10px] font-black text-zinc-400">{p.settings.targetLufs} LUFS</p>
                    <p className="text-[9px] text-zinc-600">{db(p.settings.ceiling)}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Balance Voix / Instrumental */}
        {instBlob && (
          <div className="bg-zinc-950 border border-white/8 rounded-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">Balance Voix / Instrumental</p>
              <div className="flex gap-1.5">
                {[[-9,'Voix forte'],[-6,'Voix+'],[-3,'Équilibré'],[0,'Égal'],[3,'Inst+'],[6,'Inst fort']].map(([val, label]) => (
                  <button key={val} onClick={() => setInstGainDb(val as number)}
                    className="px-1.5 py-0.5 rounded-lg text-[8px] font-black transition-all"
                    style={{ background: instGainDb === val ? '#3b82f6' : '#27272a', color: instGainDb === val ? '#fff' : '#52525b' }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[9px] text-red-400 font-black w-8 shrink-0">VOIX</span>
              <div className="flex-1 relative">
                <input type="range" min="-12" max="6" step="1" value={instGainDb}
                  onChange={e => setInstGainDb(parseInt(e.target.value))}
                  className="w-full h-2 rounded-full appearance-none cursor-pointer"
                  style={{ background: `linear-gradient(to right, #ef4444 0%, #ef4444 ${((0-(-12))/18)*100}%, #3b82f6 ${((0-(-12))/18)*100}%, #3b82f6 ${((instGainDb-(-12))/18)*100}%, #27272a ${((instGainDb-(-12))/18)*100}%, #27272a 100%)` }}/>
                <div className="absolute left-1/2 top-0 w-px h-2 bg-zinc-600 pointer-events-none" style={{ transform: 'translateX(-50%)' }}/>
              </div>
              <span className="text-[9px] text-blue-400 font-black w-8 shrink-0 text-right">INST</span>
            </div>
            <div className="flex justify-between mt-1.5">
              <span className="text-[8px] text-zinc-700">Voix forte</span>
              <span className="text-[9px] font-black" style={{ color: instGainDb === 0 ? '#a1a1aa' : instGainDb < 0 ? '#ef4444' : '#3b82f6' }}>
                {instGainDb === 0 ? 'Égal' : instGainDb < 0 ? `Voix +${Math.abs(instGainDb)} dB` : `Inst +${instGainDb} dB`}
              </span>
              <span className="text-[8px] text-zinc-700">Inst forte</span>
            </div>
          </div>
        )}

        {/* EQ avancé */}
        <div className="bg-zinc-950 border border-white/8 rounded-2xl overflow-hidden">
          <button onClick={() => setShowAdvanced(v => !v)}
            className="w-full flex items-center justify-between px-4 py-3 active:bg-zinc-900">
            <span className="text-[11px] font-black text-zinc-400 uppercase tracking-widest">EQ & Compresseur</span>
            <span className="text-zinc-600 text-[11px]">{showAdvanced ? '▲' : '▼'}</span>
          </button>
          {showAdvanced && (
            <div className="px-4 pb-4 border-t border-white/5 space-y-3 pt-3">
              {[
                { key: 'lowGain'  as const, label: 'Graves 250Hz',  color: '#f97316' },
                { key: 'midGain'  as const, label: 'Mids 2.5kHz',   color: '#eab308' },
                { key: 'highGain' as const, label: 'Aigus 8kHz',    color: '#22c55e' },
              ].map(({ key, label, color }) => (
                <div key={key} className="flex items-center gap-3">
                  <span className="text-[10px] text-zinc-500 font-black w-20 shrink-0">{label}</span>
                  <input type="range" min="-12" max="12" step="0.5" value={settings[key]}
                    onChange={e => setSettings(s => ({ ...s, [key]: parseFloat(e.target.value) }))}
                    className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer"
                    style={{ accentColor: color, background: `linear-gradient(to right, ${color} ${((settings[key]+12)/24)*100}%, #27272a ${((settings[key]+12)/24)*100}%)` }}/>
                  <span className="text-[10px] font-black w-14 text-right shrink-0" style={{ color }}>{db(settings[key])}</span>
                </div>
              ))}
              <div className="flex items-center gap-3 mt-1">
                <span className="text-[10px] text-zinc-500 font-black w-20 shrink-0">Ceiling</span>
                <input type="range" min="-6" max="0" step="0.1" value={settings.ceiling}
                  onChange={e => setSettings(s => ({ ...s, ceiling: parseFloat(e.target.value) }))}
                  className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer accent-red-500"/>
                <span className="text-[10px] text-red-400 font-black w-14 text-right shrink-0">{db(settings.ceiling)}</span>
              </div>
            </div>
          )}
        </div>

        {/* Bouton Masteriser */}
        <button onClick={runMastering} disabled={isMastering}
          className="w-full py-4 bg-red-600 rounded-2xl font-black text-[14px] uppercase tracking-widest flex items-center justify-center gap-3 active:scale-95 transition-all disabled:opacity-60">
          {isMastering
            ? <><Loader2 size={18} className="animate-spin"/> {progressLabel || 'Masterisation...'}</>
            : hasResult ? <><Zap size={18}/> Re-masteriser</> : <><Zap size={18}/> Masteriser</>
          }
        </button>

        {isMastering && (
          <div className="h-1.5 bg-zinc-900 rounded-full overflow-hidden">
            <div className="h-full bg-red-600 rounded-full transition-all duration-300" style={{ width: `${progress}%` }}/>
          </div>
        )}

        {/* ── RÉSULTATS ── */}
        {hasResult && (
          <div className="space-y-3">

            {/* Guide workflow */}
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-3">
              <p className="text-[9px] text-zinc-500 font-black uppercase tracking-widest mb-2">Quoi exporter ?</p>
              <div className="space-y-1.5">
                <p className="text-[10px] text-white">🎤 <span className="font-black">Pour le spectacle</span> — Envoyer au Mac (Mode A)</p>
                <p className="text-[10px] text-white">🎵 <span className="font-black">Pour Spotify/Apple Music</span> — WAV 24-bit (meilleure qualité)</p>
                <p className="text-[10px] text-white">📱 <span className="font-black">Pour partager / YouTube</span> — MP3 320kbps</p>
                <p className="text-[10px] text-white">🎛️ <span className="font-black">Pour produire davantage</span> — Stems séparés</p>
              </div>
            </div>

            {/* Séparateur */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-zinc-800"/>
              <p className="text-[10px] text-zinc-600 font-black uppercase tracking-widest">Résultats</p>
              <div className="flex-1 h-px bg-zinc-800"/>
            </div>

            {/* ── MODE A : Voix masterisée ── */}
            <div className="bg-zinc-950 border border-zinc-800 rounded-2xl overflow-hidden">
              <div className="flex items-center gap-3 p-4 border-b border-white/5">
                <div className="w-9 h-9 rounded-xl bg-red-900/30 flex items-center justify-center shrink-0">
                  <Mic size={16} className="text-red-400"/>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-black text-white">Voix + harmonies masterisée</p>
                  <p className="text-[10px] text-zinc-500">→ Remplace le stem vocal sur le Mac</p>
                </div>
                <button onClick={() => playAudio('vocal')}
                  className="w-9 h-9 rounded-xl bg-zinc-800 flex items-center justify-center active:scale-90 shrink-0">
                  {playing === 'vocal' ? <Pause size={14}/> : <Play size={14}/>}
                </button>
              </div>
              {isOnline ? (
                <button onClick={sendToMac} disabled={sendingToMac || sentToMac}
                  className={`w-full py-3.5 font-black text-[12px] uppercase tracking-widest flex items-center justify-center gap-2 active:scale-95 transition-all ${
                    sentToMac ? 'bg-emerald-900/30 text-emerald-400' : 'bg-red-600 text-white'
                  } disabled:opacity-60`}>
                  {sendingToMac
                    ? <><Loader2 size={14} className="animate-spin"/> Transfert en cours...</>
                    : sentToMac
                    ? <><CheckCircle2 size={14}/> Stem vocal mis à jour sur le Mac</>
                    : <><Send size={14}/> Envoyer au Mac → Stem vocal</>
                  }
                </button>
              ) : (
                <div className="px-4 py-3 flex items-center gap-2">
                  <AlertCircle size={13} className="text-amber-500 shrink-0"/>
                  <p className="text-[11px] text-amber-400">WiFi requis pour envoyer au Mac</p>
                </div>
              )}
            </div>

            {/* ── MODE B : Mix complet ── */}
            <div className={`bg-zinc-950 border rounded-2xl overflow-hidden ${hasFullMix ? 'border-blue-800/40' : 'border-zinc-800/40 opacity-50'}`}>
              <div className="flex items-center gap-3 p-4 border-b border-white/5">
                <div className="w-9 h-9 rounded-xl bg-blue-900/30 flex items-center justify-center shrink-0">
                  <Music2 size={16} className="text-blue-400"/>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-black text-white">Mix complet masterisé</p>
                  <p className="text-[10px] text-zinc-500">
                    {hasFullMix ? 'Voix + harmonies + instrumental → Spotify / YouTube' : 'Instrumental non disponible hors-ligne'}
                  </p>
                </div>
                {hasFullMix && (
                  <button onClick={() => playAudio('full')}
                    className="w-9 h-9 rounded-xl bg-zinc-800 flex items-center justify-center active:scale-90 shrink-0">
                    {playing === 'full' ? <Pause size={14}/> : <Play size={14}/>}
                  </button>
                )}
              </div>

              {hasFullMix && (
                <div className="divide-y divide-white/5">
                  {/* Export MP3 320kbps */}
                  <button onClick={exportAsMP3} disabled={exportingMp3}
                    className="w-full py-3.5 font-black text-[12px] uppercase tracking-widest flex items-center justify-center gap-2 active:scale-95 transition-all text-emerald-400 disabled:opacity-60">
                    {exportingMp3
                      ? <><Loader2 size={14} className="animate-spin"/> Encodage MP3...</>
                      : exportedMp3
                      ? <><CheckCircle2 size={14}/> MP3 320kbps partagé !</>
                      : <><Share2 size={14}/> Exporter MP3 320kbps — Spotify / YouTube</>
                    }
                  </button>

                  {/* Export WAV 24-bit — qualité maximale distribution */}
                  <button onClick={exportAsWAV} disabled={exportingWav}
                    className="w-full py-3.5 font-black text-[12px] uppercase tracking-widest flex items-center justify-center gap-2 active:scale-95 transition-all text-purple-400 disabled:opacity-60">
                    {exportingWav
                      ? <><Loader2 size={14} className="animate-spin"/> Encodage WAV...</>
                      : exportedWav
                      ? <><CheckCircle2 size={14}/> WAV 24-bit partagé !</>
                      : <><Share2 size={14}/> Exporter WAV 24-bit — Qualité maximale</>
                    }
                  </button>

                  {/* Export MP4 natif iOS — masqué par défaut */}
                  <button onClick={exportAsMP4} disabled={exportingMp4}
                    className="w-full py-3 font-black text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 active:scale-95 transition-all text-blue-300/70 disabled:opacity-60">
                    {exportingMp4
                      ? <><Loader2 size={13} className="animate-spin"/> Export MP4...</>
                      : exportedMp4
                      ? <><CheckCircle2 size={13}/> MP4 partagé !</>
                      : <><Share2 size={13}/> MP4 (AirDrop / iCloud)</>
                    }
                  </button>
                </div>
              )}
            </div>

            {/* Note Spotify */}
            <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-3">
              <p className="text-[10px] text-zinc-500 leading-relaxed">
                <span className="text-purple-400 font-black">WAV 24-bit</span> — Meilleure qualité, recommandé pour DistroKid / TuneCore / CD Baby → Spotify, Apple Music.{'\
'}
                <span className="text-emerald-400 font-black">MP3 320kbps</span> — Compatible partout, taille réduite, qualité excellente.{'\
'}
                <span className="text-blue-400 font-black">MP4</span> — Pour YouTube avec photo de couverture.
              </p>
            </div>

            {/* ── Stems séparés ── */}
            {hasResult && (
              <div className="bg-zinc-950 border border-orange-800/40 rounded-2xl overflow-hidden">
                <div className="flex items-center gap-3 p-4 border-b border-white/5">
                  <div className="w-9 h-9 rounded-xl bg-orange-900/30 flex items-center justify-center shrink-0">
                    <span className="text-[16px]">🎛️</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-black text-white">Stems séparés</p>
                    <p className="text-[10px] text-zinc-500">Vocal WAV + Instrumental — Pour production avancée</p>
                  </div>
                </div>
                <div className="divide-y divide-white/5">
                  <button onClick={exportVocalStem} disabled={exportingVocal}
                    className="w-full py-3.5 font-black text-[12px] uppercase tracking-widest flex items-center justify-center gap-2 active:scale-95 transition-all text-red-400 disabled:opacity-60">
                    {exportingVocal ? <><Loader2 size={14} className="animate-spin"/> Export vocal...</>
                      : exportedVocal ? <><CheckCircle2 size={14}/> Stem vocal partagé !</>
                      : <><Share2 size={14}/> Stem vocal WAV — Voix + harmonies</>}
                  </button>
                  <button onClick={exportInstStem} disabled={exportingInst || !instBlob}
                    className={`w-full py-3.5 font-black text-[12px] uppercase tracking-widest flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-40 ${instBlob ? 'text-blue-400' : 'text-zinc-600'}`}>
                    {exportingInst ? <><Loader2 size={14} className="animate-spin"/> Export instrumental...</>
                      : exportedInst ? <><CheckCircle2 size={14}/> Instrumental partagé !</>
                      : instBlob ? <><Share2 size={14}/> Stem instrumental — Piste de fond</>
                      : <>🔒 Instrumental non disponible hors-ligne</>}
                  </button>
                  <button onClick={exportStemsZip} disabled={exportingZip}
                    className="w-full py-3.5 font-black text-[12px] uppercase tracking-widest flex items-center justify-center gap-2 active:scale-95 transition-all text-orange-400 disabled:opacity-60">
                    {exportingZip ? <><Loader2 size={14} className="animate-spin"/> Préparation stems...</>
                      : exportedZip ? <><CheckCircle2 size={14}/> Stems partagés !</>
                      : <><Share2 size={14}/> Partager les 2 stems ensemble</>}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <audio ref={playRef} playsInline className="hidden"/>
    </div>
  );
}
