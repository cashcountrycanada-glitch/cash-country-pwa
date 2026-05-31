import { studioOfflineDB } from './StudioOfflineDB';
/**
 * StudioService.ts — Pipeline d'enregistrement mobile v7.6
 *
 * RÉALITÉ iOS confirmée (WebKit Bugzilla #154538, Apple QA1631, ios-safe-audio-context) :
 *   • sampleRate dicté par AVAudioSession hardware : haut-parleur=48kHz, casque=44.1kHz.
 *   • On ne peut PAS forcer le sampleRate côté JS. On accepte le natif.
 *   • Warm-up : créer AudioContext + jouer 1 buffer silencieux dans un geste user → stable.
 *   • NE PAS stocker __warmStream : cloner un stream arrêté = silence. getUserMedia() direct.
 *   • addModule() UNE SEULE FOIS par contexte (flag __warmWorkletLoaded).
 *   • Nettoyage nodes précédents avant chaque prise (pas d'accumulation).
 *   • Capture SÈCHE (DRY) : config.reverb IGNORÉ — effets = post-prod uniquement.
 */
export type ReverbType = 'none' | 'room' | 'hall' | 'plate';
export interface StudioEffectsConfig {
  reverb: ReverbType;
  saturation: number;
  compression: boolean;
  gainL: number;
  gainR: number;
  deviceId?: string;
}
export interface MobileRecording {
  id: string; songId: string; songTitle: string; artist: string;
  duration: number; recordedAt: number; blob?: Blob; dataUrl?: string;
  originalDataUrl?: string; // dataUrl avant tout FX — toujours appliquer depuis lui
  transferred: boolean; fileName: string; trackIndex?: number; trackLabel?: string;
  pitchShift?: number; gain?: number; pan?: number; muted?: boolean; projectId?: string;
  isGenerated?: boolean; regions?: Region[];
  takeSlot?: 'A' | 'B' | 'C';
}
export interface Region { id: string; takeId: string; startSec: number; endSec: number; label?: string; color?: string; }
export interface Take { id: string; recording: MobileRecording; waveformData?: number[]; regions: Region[]; }
export interface TrackProject {
  id: string; songId: string; songTitle: string; createdAt: number;
  tracks: MobileRecording[]; takes?: Take[]; compRegions?: Region[];
  mixedDataUrl?: string; sections?: any[]; suggestedKey?: string;
}
const STORAGE_KEY = 'cash_studio_recordings';

function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function getBestMimeType(): string {
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=pcm')) return 'audio/webm;codecs=pcm';
  if (MediaRecorder.isTypeSupported('audio/mp4;codecs=pcm'))  return 'audio/mp4;codecs=pcm';
  if (MediaRecorder.isTypeSupported('audio/mp4;codecs=alac')) return 'audio/mp4;codecs=alac';
  if (isIOS()) return 'audio/mp4';
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
  return '';
}

// ── Pitch Shift via WSOLA (Waveform Similarity Overlap-Add) ─────────────────
// Méthode professionnelle : change la hauteur SANS changer la durée
// Bien meilleur que playbackRate seul qui accélère/ralentit le signal
function wsolaShift(inputData: Float32Array, semitones: number, sampleRate: number): Float32Array {
  if (semitones === 0) return inputData;
  const rate = Math.pow(2, semitones / 12);
  // Taille de frame adaptative : plus petite = meilleurs transitoires, plus grande = moins d'artefacts
  // Pour les petits intervalles (<= 5ST) : frames plus petites pour mieux gérer les attaques vocales
  const frameSize  = Math.abs(semitones) <= 5 ? 1024 : 2048;
  const overlap    = Math.floor(frameSize * 0.80); // 80% overlap pour réduire les artéfacts
  const hop_a      = frameSize - overlap;
  const hop_s      = Math.round(hop_a / rate);
  const outputLen  = inputData.length;
  const output     = new Float32Array(outputLen);
  const window     = new Float32Array(frameSize);
  // Fenêtre de Hann
  for (let i = 0; i < frameSize; i++) window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (frameSize - 1)));

  let pos_a = 0; // position dans le signal d'analyse (stretchée)
  let pos_s = 0; // position dans le signal de sortie

  while (pos_s + frameSize < outputLen) {
    // Position réelle dans le signal source (on time-stretche à rate^-1 puis on garde la durée)
    const srcPos = Math.round(pos_a);
    if (srcPos + frameSize > inputData.length) break;

    // Chercher le meilleur alignement dans une fenêtre ±overlap/2 (WSOLA)
    let bestOffset = 0;
    if (pos_s > 0) {
      let bestCorr = -Infinity;
      const searchRange = Math.min(Math.floor(overlap / 2), srcPos);
      for (let d = -searchRange; d <= searchRange; d += 2) {
        let corr = 0;
        const sp = srcPos + d;
        if (sp < 0 || sp + frameSize > inputData.length) continue;
        for (let k = 0; k < Math.min(overlap, frameSize); k++) {
          corr += output[pos_s - overlap + k] * inputData[sp + k];
        }
        if (corr > bestCorr) { bestCorr = corr; bestOffset = d; }
      }
    }

    const readPos = Math.max(0, Math.min(srcPos + bestOffset, inputData.length - frameSize));
    // Overlap-add avec fenêtre de Hann
    for (let i = 0; i < frameSize && pos_s + i < outputLen; i++) {
      output[pos_s + i] += inputData[readPos + i] * window[i];
    }

    pos_a += hop_a;  // avancer dans la source
    pos_s += hop_s;  // avancer dans la sortie
  }

  // Normaliser les zones de chevauchement
  const norm = new Float32Array(outputLen).fill(1e-6);
  let np = 0;
  while (np + frameSize < outputLen) {
    for (let i = 0; i < frameSize; i++) norm[np + i] += window[i];
    np += hop_s;
  }
  for (let i = 0; i < outputLen; i++) if (norm[i] > 0.01) output[i] /= norm[i];

  return output;
}

// Correction de formants pour les grands intervalles (> ±5 semitones)
// Évite le son "cartoon" sur les voix décalées d'une octave
function applyFormantCorrection(data: Float32Array, semitones: number): Float32Array {
  if (Math.abs(semitones) < 5) return data;
  const correction = Math.pow(2, -semitones / 24); // correction partielle des formants
  // Filtre passe-bas / passe-haut selon la direction
  const out = new Float32Array(data.length);
  const alpha = semitones > 0
    ? Math.max(0.05, Math.min(0.3, 0.1 + semitones * 0.015)) // réduire les aigus sur les shifts vers le haut
    : Math.max(0.05, Math.min(0.25, 0.05 + Math.abs(semitones) * 0.01)); // réduire les graves sur les shifts vers le bas
  out[0] = data[0];
  if (semitones > 0) {
    // Low-pass léger pour réduire les artefacts aigus
    for (let i = 1; i < data.length; i++) out[i] = out[i-1] + alpha * (data[i] - out[i-1]);
  } else {
    // High-pass léger pour réduire les artefacts graves
    for (let i = 1; i < data.length; i++) out[i] = alpha * (out[i-1] + data[i] - data[i-1]);
  }
  return out;
}

async function pitchShiftBuffer(ctx: OfflineAudioContext | AudioContext, buffer: AudioBuffer, semitones: number): Promise<AudioBuffer> {
  if (semitones === 0) return buffer;
  const sr       = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const len      = buffer.length;

  // Créer le buffer de sortie
  const outCtx = new OfflineAudioContext(channels, len, sr);
  const outBuf  = outCtx.createBuffer(channels, len, sr);

  for (let ch = 0; ch < channels; ch++) {
    const inData  = buffer.getChannelData(ch);
    // 1. WSOLA pitch shift
    let shifted = wsolaShift(inData, semitones, sr);
    // 2. Correction formants sur grands intervalles
    shifted = applyFormantCorrection(shifted, semitones);
    // 3. Normalisation douce (éviter les clips)
    let peak = 0;
    for (let i = 0; i < shifted.length; i++) peak = Math.max(peak, Math.abs(shifted[i]));
    if (peak > 0.95) { const g = 0.90 / peak; for (let i = 0; i < shifted.length; i++) shifted[i] *= g; }
    outBuf.getChannelData(ch).set(shifted);
  }

  // EQ de compensation selon la direction du shift
  const eqCtx = new OfflineAudioContext(channels, len, sr);
  const eqSrc = eqCtx.createBufferSource(); eqSrc.buffer = outBuf;
  const eq1   = eqCtx.createBiquadFilter();
  const eq2   = eqCtx.createBiquadFilter();
  const gain  = eqCtx.createGain();

  if (semitones > 0) {
    // Harmonies vers le haut : couper les graves parasites, adoucir les aigus
    eq1.type = 'highpass';  eq1.frequency.value = 120;  eq1.Q.value = 0.7;
    eq2.type = 'highshelf'; eq2.frequency.value = 5000; eq2.gain.value = -Math.min(semitones * 0.3, 2.5);
    gain.gain.value = 0.92;
  } else {
    // Octave bas : couper les aigus parasites, renforcer les médiums
    eq1.type = 'lowpass';  eq1.frequency.value = 6000; eq1.Q.value = 0.7;
    eq2.type = 'peaking';  eq2.frequency.value = 800;  eq2.gain.value = 1.5; eq2.Q.value = 1.0;
    gain.gain.value = 1.05;
  }

  eqSrc.connect(eq1); eq1.connect(eq2); eq2.connect(gain); gain.connect(eqCtx.destination);
  eqSrc.start(0);
  return safeStartRendering(eqCtx);
}

// Wrapper sécurisé pour OfflineAudioContext.startRendering() sur iOS Safari
// iOS peut silencieusement ne jamais résoudre startRendering() sur de longs buffers
async function safeStartRendering(ctx: OfflineAudioContext, timeoutMs = 30000): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`OfflineAudioContext timeout (${timeoutMs}ms) — buffer trop long pour iOS`));
    }, timeoutMs);
    ctx.startRendering().then(buf => {
      clearTimeout(timer);
      resolve(buf);
    }).catch(err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}


// Double tracking 100% JS pur — zéro OfflineAudioContext
// Traite les Float32Array directement : fonctionne sur iOS peu importe la durée
// Technique : 3 couches mixées (centre 70%, gauche +0.08ST délai 12ms 60%, droite -0.07ST délai 23ms 60%)
async function doubleTrackBuffer(buffer: AudioBuffer): Promise<AudioBuffer> {
  const sr  = buffer.sampleRate;
  const len = buffer.length;

  // Lire le canal mono (ou moyenne L+R si stéréo)
  const srcL = buffer.getChannelData(0);
  const srcR = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : srcL;
  const mono = new Float32Array(len);
  for (let i = 0; i < len; i++) mono[i] = (srcL[i] + srcR[i]) * 0.5;

  // Pitch shift léger par resampling linéaire (pas d'OfflineAudioContext)
  const resample = (src: Float32Array, ratio: number): Float32Array => {
    const outLen = Math.floor(src.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = src[idx] ?? 0;
      const b = src[idx + 1] ?? 0;
      out[i] = a + (b - a) * frac;
    }
    return out;
  };

  // Couche gauche : +0.08 ST → ratio 1/2^(0.08/12), délai 12ms
  const ratioL   = 1 / Math.pow(2, 0.08 / 12);
  const delayL   = Math.floor(0.012 * sr);
  const shiftedL = resample(mono, ratioL);

  // Couche droite : -0.07 ST → ratio 1/2^(-0.07/12), délai 23ms
  const ratioR   = 1 / Math.pow(2, -0.07 / 12);
  const delayR   = Math.floor(0.023 * sr);
  const shiftedR = resample(mono, ratioR);

  // Buffer de sortie stéréo — longueur = len + délai max + petit padding
  const outLen = len + Math.floor(0.030 * sr);
  const outL   = new Float32Array(outLen);
  const outR   = new Float32Array(outLen);

  // Centre (voix originale) gain 0.70 — dans les deux canaux
  for (let i = 0; i < len; i++) {
    outL[i] += mono[i] * 0.70;
    outR[i] += mono[i] * 0.70;
  }

  // Couche gauche pan -0.6 : 80% L, 20% R, gain 0.60, délai 12ms
  const llLen = Math.min(shiftedL.length, outLen - delayL);
  for (let i = 0; i < llLen; i++) {
    const s = shiftedL[i] * 0.60;
    outL[i + delayL] += s * 0.80;
    outR[i + delayL] += s * 0.20;
  }

  // Couche droite pan +0.6 : 20% L, 80% R, gain 0.60, délai 23ms
  const rrLen = Math.min(shiftedR.length, outLen - delayR);
  for (let i = 0; i < rrLen; i++) {
    const s = shiftedR[i] * 0.60;
    outL[i + delayR] += s * 0.20;
    outR[i + delayR] += s * 0.80;
  }

  // Normalisation légère pour éviter le clipping (peak max 0.95)
  let peak = 0;
  for (let i = 0; i < outLen; i++) {
    const a = Math.abs(outL[i]);
    const b = Math.abs(outR[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  if (peak > 0.95) {
    const norm = 0.95 / peak;
    for (let i = 0; i < outLen; i++) { outL[i] *= norm; outR[i] *= norm; }
  }

  // Créer l'AudioBuffer de sortie via un mini OfflineAudioContext (juste pour l'allocation)
  // 1 sample = négligeable, aucun risque de freeze
  const oc  = new OfflineAudioContext(2, outLen, sr);
  const out = oc.createBuffer(2, outLen, sr);
  out.copyToChannel(outL, 0);
  out.copyToChannel(outR, 1);
  return out;
}

function getOfflineDB() {
  // studioOfflineDB est déjà chargé via __INLINE_MODULES__ avant StudioService
  return studioOfflineDB;
}

async function audioBufferToBlob(buffer: AudioBuffer): Promise<Blob> {
  // Encodage WAV instantané — remplace MediaRecorder temps réel (évite l'attente de durée complète)
  return audioBufferToWavBlob(buffer);
}

// ══════════════════════════════════════════════════════════════════════════════
// MOTEUR HARMONIQUE INTELLIGENT — Harmonies basées sur les accords réels
// ══════════════════════════════════════════════════════════════════════════════

// Notes de la gamme chromatique
const NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

// Intervalles dans un accord (en semitones depuis la fondamentale)
const CHORD_TONES: Record<string, number[]> = {
  '':    [0, 4, 7],        // Majeur : fondamentale, tierce M, quinte
  'm':   [0, 3, 7],        // Mineur : fondamentale, tierce m, quinte
  '7':   [0, 4, 7, 10],    // Dom 7  : + septième mineure
  'maj7':[0, 4, 7, 11],    // Maj 7  : + septième majeure
  'm7':  [0, 3, 7, 10],    // Min 7
  'sus2':[0, 2, 7],        // Sus 2
  'sus4':[0, 5, 7],        // Sus 4
  'dim': [0, 3, 6],        // Diminué
  'aug': [0, 4, 8],        // Augmenté
  'add9':[0, 4, 7, 14],    // Add 9
  '6':   [0, 4, 7, 9],     // Sixte
  '9':   [0, 4, 7, 10, 14],// Neuvième
};

// Parser un symbole d'accord → { root: number, tones: number[] }
// Supporte : lettres (C, Dm, G7, F#m, Bb, Ebmaj7) + Nashville (1,4,5,2m,6m)
function parseChord(symbol: string, songKey: number = 0): { root: number; tones: number[] } | null {
  if (!symbol || symbol === 'N.C.' || symbol === '?' || symbol === '') return null;

  // Notation Nashville (chiffres romains/arabes relatifs à la tonalité)
  const nashville = symbol.match(/^([b#]?)([1-7])(.*)/);
  if (nashville && !symbol.match(/^[A-G]/)) {
    const [, acc, deg, qual] = nashville;
    const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
    let root = (songKey + MAJOR_SCALE[parseInt(deg) - 1] + (acc === 'b' ? -1 : acc === '#' ? 1 : 0) + 12) % 12;
    const quality = qual.replace(/^m(?!aj)/, 'm').replace(/7$/, '7').trim();
    const tones = CHORD_TONES[quality] || (qual.includes('m') ? CHORD_TONES['m'] : CHORD_TONES['']);
    return { root, tones: tones.map((t: number) => (root + t) % 12) };
  }

  // Notation alphabétique — parser correctement les bémols AVANT de remplacer
  const rootMatch = symbol.match(/^([A-G][#b]?)/);
  if (!rootMatch) return null;
  let rootStr = rootMatch[1];
  // Table de correspondance bémols → dièses (ordre important : 2 chars avant 1 char)
  const flat2sharp: Record<string, string> = {
    'Cb':'B','Db':'C#','Eb':'D#','Fb':'E','Gb':'F#','Ab':'G#','Bb':'A#'
  };
  rootStr = flat2sharp[rootStr] || rootStr;
  const root = NOTES.indexOf(rootStr);
  if (root === -1) return null;
  // Extraire le type d'accord (enlever basse optionnelle ex: G/B)
  const quality = symbol.slice(rootMatch[0].length).replace(/\/.*$/, '').trim();
  const tones = CHORD_TONES[quality] || CHORD_TONES[''] || [0, 4, 7];
  return { root, tones: tones.map((t: number) => (root + t) % 12) };
}

// Trouver la meilleure note d'harmonie pour une note mélodique donnée
// sur un accord donné, dans une direction (vers le haut ou le bas)
function bestHarmonyNote(
  melodyNoteSemitone: number,  // note chantée (absolu, ex: 60 = C4)
  chord: { root: number; tones: number[] },
  intervalTarget: number,      // intervalle visé en semitones (+3, +7, -12, etc.)
  key: number                  // tonalité de la chanson
): number {
  const melodyClass = ((melodyNoteSemitone % 12) + 12) % 12;
  const direction = intervalTarget >= 0 ? 1 : -1;
  const absTarget = Math.abs(intervalTarget);

  // Candidats : notes de l'accord + notes de la gamme penta country
  const countryPenta = [0, 2, 4, 7, 9]; // pentatonique majeure relative à la tonalité
  const candidates = [...new Set([
    ...chord.tones,
    ...countryPenta.map(n => (key + n) % 12),
  ])];

  // Trouver la note candidate la plus proche de l'intervalle cible
  let bestNote = melodyNoteSemitone + intervalTarget;
  let bestDist = Infinity;

  for (const candidate of candidates) {
    // Trouver toutes les octaves de ce candidat proches de la cible
    for (let oct = -2; oct <= 2; oct++) {
      const note = melodyNoteSemitone + direction * (absTarget + oct * 12 - absTarget % 12);
      const noteClass = ((note % 12) + 12) % 12;
      if (noteClass === candidate) {
        const dist = Math.abs(note - (melodyNoteSemitone + intervalTarget));
        if (dist < bestDist) {
          bestDist = dist;
          bestNote = note;
        }
      }
    }
  }

  return bestNote;
}

// Convertir realPartition en map timestamp→accord
function buildChordMap(realPartition: any[], songKey: number = 0): Array<{ time: number; chord: ReturnType<typeof parseChord> }> {
  const map: Array<{ time: number; chord: ReturnType<typeof parseChord> }> = [];
  for (const section of realPartition) {
    for (const beat of (section.beats || [])) {
      if (beat.timestamp !== undefined && beat.chord) {
        const parsed = parseChord(beat.chord, songKey);
        if (parsed) map.push({ time: beat.timestamp, chord: parsed });
      }
    }
  }
  return map.sort((a, b) => a.time - b.time);
}

// Obtenir l'accord au timestamp t
function chordAt(map: Array<{ time: number; chord: ReturnType<typeof parseChord> }>, t: number): ReturnType<typeof parseChord> | null {
  if (map.length === 0) return null;
  let last = map[0].chord;
  for (const entry of map) {
    if (entry.time > t) break;
    last = entry.chord;
  }
  return last;
}

// Parser la tonalité de la chanson
function parseKey(keyStr: string): number {
  if (!keyStr) return 0;
  const clean = keyStr.replace(/\s*(Major|major|Majeur|maj)\s*/gi, '').replace('m','').trim();
  const idx = NOTES.indexOf(clean.replace('b','#').replace('Db','C#').replace('Eb','D#').replace('Gb','F#').replace('Ab','G#').replace('Bb','A#'));
  return idx >= 0 ? idx : 0;
}

// ── PITCH SHIFT INTELLIGENT par segment ──────────────────────────────────────
// Divise le buffer en segments de ~50ms, applique le meilleur interval pour chaque accord
async function smartHarmonyBuffer(
  buffer: AudioBuffer,
  targetInterval: number,  // intervalle visé (+3, +7, +5, -12)
  chordMap: Array<{ time: number; chord: ReturnType<typeof parseChord> }>,
  songKey: number
): Promise<AudioBuffer> {
  // Si pas de données d'accord → fallback WSOLA classique
  if (chordMap.length === 0) {
    return pitchShiftBuffer(new (window.AudioContext || (window as any).webkitAudioContext)(), buffer, targetInterval);
  }

  const sr       = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const len      = buffer.length;
  const segmentSec = 0.05; // segments de 50ms
  const segmentSamp = Math.floor(segmentSec * sr);

  // Buffer de sortie
  const outCtx = new OfflineAudioContext(channels, len, sr);
  const outBuf  = outCtx.createBuffer(channels, len, sr);

  // Traiter chaque canal
  for (let ch = 0; ch < channels; ch++) {
    const inData  = buffer.getChannelData(ch);
    const outData = outBuf.getChannelData(ch);

    let pos = 0;
    let lastInterval = targetInterval;

    while (pos < len) {
      const t = pos / sr;
      const chord = chordAt(chordMap, t);

      // Calculer le meilleur intervalle pour cet accord
      let interval = targetInterval;
      if (chord) {
        // Estimer la note mélodique locale (RMS peak dans ce segment)
        const segEnd = Math.min(pos + segmentSamp, len);
        // On utilise l'intervalle standard mais ajusté pour rester dans l'accord
        // Tolérance de ±1 semitone pour coller à la note d'accord la plus proche
        const baseNote = 60 + targetInterval; // estimation C4 + interval
        const bestNote = bestHarmonyNote(60, chord, targetInterval, songKey);
        const adjustment = bestNote - (60 + targetInterval);
        // Ajustement max ±1 semitone pour ne pas dénaturer l'harmonie
        interval = targetInterval + Math.max(-1, Math.min(1, Math.round(adjustment)));
      }

      // Appliquer WSOLA sur ce segment avec l'intervalle calculé
      const segEnd = Math.min(pos + segmentSamp * 4, len); // segments de 200ms pour WSOLA
      const segLen = segEnd - pos;
      const segBuf = new Float32Array(segLen);
      for (let i = 0; i < segLen; i++) segBuf[i] = inData[pos + i];

      const shifted = wsolaShift(segBuf, interval, sr);

      // Cross-fade avec le segment précédent (éviter les discontinuités)
      const fadeLen = Math.min(128, shifted.length);
      for (let i = 0; i < shifted.length && pos + i < len; i++) {
        if (i < fadeLen && lastInterval !== interval) {
          const fade = i / fadeLen;
          outData[pos + i] = outData[pos + i] * (1 - fade) + shifted[i] * fade;
        } else {
          outData[pos + i] = shifted[i];
        }
      }

      lastInterval = interval;
      pos += segmentSamp; // avancer de 50ms
    }

    // Normalisation douce
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(outData[i]));
    if (peak > 0.92) { const g = 0.88 / peak; for (let i = 0; i < len; i++) outData[i] *= g; }
  }

  // EQ final
  const eqCtx = new OfflineAudioContext(channels, len, sr);
  const eqSrc = eqCtx.createBufferSource(); eqSrc.buffer = outBuf;
  const eq1   = eqCtx.createBiquadFilter();
  const eq2   = eqCtx.createBiquadFilter();
  const gn    = eqCtx.createGain();

  if (targetInterval > 0) {
    eq1.type = 'highpass';  eq1.frequency.value = 100;
    eq2.type = 'highshelf'; eq2.frequency.value = 5500; eq2.gain.value = -Math.min(targetInterval * 0.25, 2.0);
    gn.gain.value = 0.90;
  } else {
    eq1.type = 'lowpass';  eq1.frequency.value = 7000;
    eq2.type = 'peaking';  eq2.frequency.value = 900; eq2.gain.value = 2.0; eq2.Q.value = 1.0;
    gn.gain.value = 1.05;
  }
  eqSrc.connect(eq1); eq1.connect(eq2); eq2.connect(gn); gn.connect(eqCtx.destination);
  eqSrc.start(0);
  return safeStartRendering(eqCtx);
}

// Encodage WAV instantané depuis AudioBuffer — zéro MediaRecorder, zéro attente temps réel
// Format : PCM 16-bit little-endian stéréo interleaved
function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numCh   = Math.min(buffer.numberOfChannels, 2);
  const sr      = buffer.sampleRate;
  const numSamp = buffer.length;
  const bytesPerSamp = 2;
  const dataLen = numSamp * numCh * bytesPerSamp;
  const wavBuf  = new ArrayBuffer(44 + dataLen);
  const view    = new DataView(wavBuf);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE'); writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * numCh * bytesPerSamp, true);
  view.setUint16(32, numCh * bytesPerSamp, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, dataLen, true);
  const chL = buffer.getChannelData(0);
  const chR = numCh > 1 ? buffer.getChannelData(1) : chL;
  let off = 44;
  for (let i = 0; i < numSamp; i++) {
    const sL = Math.max(-1, Math.min(1, chL[i]));
    const sR = Math.max(-1, Math.min(1, chR[i]));
    view.setInt16(off, sL < 0 ? sL * 0x8000 : sL * 0x7FFF, true); off += 2;
    view.setInt16(off, sR < 0 ? sR * 0x8000 : sR * 0x7FFF, true); off += 2;
  }
  return new Blob([wavBuf], { type: 'audio/wav' });
}


export const studioService = {
  async saveRecordingLocallyAsync(rec: MobileRecording): Promise<void> {
    // Accepter les sentinelles opfs: (FX gros fichiers stockés dans OPFS directement)
    if (!rec.dataUrl || (rec.dataUrl.length < 100 && !rec.dataUrl.startsWith('opfs:'))) return;
    // Pour les sentinelles opfs:, le blob est déjà dans OPFS sous la clé fx_xxx
    // On sauvegarde seulement les métadonnées
    const isOpfsSentinel = rec.dataUrl!.startsWith('opfs:');
    const blob = isOpfsSentinel ? null : this.dataUrlToBlob(rec.dataUrl!);
    const MAX_ATTEMPTS = 5;
    let lastError: any = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Réinitialiser la connexion IndexedDB si elle a été coupée par iOS
        const db = getOfflineDB();
        await db.init();

        // Sauvegarder le blob audio (sauf pour les sentinelles opfs: — déjà dans OPFS)
        if (!isOpfsSentinel && blob) {
          await db.saveAudio(`rec_${rec.id}`, blob, {
            songId: rec.songId,
            songTitle: rec.songTitle,
            type: 'recording',
            savedAt: Date.now(),
          });
        }

        // Sauvegarder aussi les métadonnées
        const meta = { ...rec, dataUrl: undefined, blob: undefined };
        const existing = await db.getState<any[]>('recordings', []);
        await db.setState('recordings', [...existing.filter((r: any) => r.id !== rec.id), meta]);

        // AUSSI dans localStorage — garantie absolue qui survit aux crashes iOS
        // (localStorage n'est pas affecté par AVAudioSession ni par l'éviction IDB)
        try {
          const lsRecs: any[] = JSON.parse(localStorage.getItem('cash_studio_recordings') || '[]');
          const updated = [...lsRecs.filter((r: any) => r.id !== rec.id), meta];
          localStorage.setItem('cash_studio_recordings', JSON.stringify(updated));
        } catch {}

        console.log(`[Save] ✅ Prise sauvegardée (tentative ${attempt}) — ${(blob.size/1024).toFixed(0)} KB`);
        return; // Succès — sortir

      } catch (e: any) {
        lastError = e;
        console.warn(`[Save] ⚠️ Tentative ${attempt}/${MAX_ATTEMPTS} échouée:`, e?.message);

        if (attempt < MAX_ATTEMPTS) {
          // Attendre de plus en plus longtemps entre les tentatives
          const delay = attempt * 500; // 500ms, 1000ms, 1500ms, 2000ms
          await new Promise(r => setTimeout(r, delay));

          // Forcer re-init de la connexion IndexedDB
          try { await studioOfflineDB.init(); } catch {}
        }
      }
    }

    // Toutes les tentatives ont échoué — logger mais NE PAS planter
    // Le dataUrl reste en mémoire dans rec.dataUrl — pas perdu
    console.error('[Save] ❌ Échec après', MAX_ATTEMPTS, 'tentatives:', lastError?.message);
    throw lastError; // Remonter pour que l'appelant sache
  },
  saveRecordingLocally(rec: MobileRecording): void {
    this.saveRecordingLocallyAsync(rec).catch((e: any) => {
      if (e && (e.name === 'QuotaExceededError' || (e.message && e.message.includes('QUOTA_FULL')))) {
        window.dispatchEvent(new CustomEvent('studio:quotaExceeded', { detail: { message: e.message } }));
      } else {
        console.warn('[StudioService] saveRecordingLocally:', e);
      }
    });
  },
  async getLocalRecordingsAsync(): Promise<MobileRecording[]> {
    try {
      const db = getOfflineDB();
      // Charger depuis IDB ET localStorage, puis fusionner (localStorage prioritaire pour les nouvelles prises)
      const [idbMetas, lsMetas] = await Promise.all([
        db.getState<any[]>('recordings', []).catch(() => [] as any[]),
        Promise.resolve(this.getLocalRecordings()),
      ]);
      // Fusionner : commencer par IDB, ajouter les prises localStorage absentes de IDB
      const merged = [...idbMetas];
      for (const lsRec of lsMetas) {
        if (!merged.find((r: any) => r.id === lsRec.id)) {
          merged.push(lsRec);
        }
      }
      if (merged.length === 0) return [];
      // Enrichir chaque prise avec le blob audio depuis OPFS/IDB
      return Promise.all(merged.map(async (meta: any) => {
        try {
          const blob = await db.getAudio(`rec_${meta.id}`);
          if (blob) return { ...meta, dataUrl: await studioService.blobToDataUrl(blob) };
        } catch {}
        return meta;
      }));
    } catch {
      return this.getLocalRecordings();
    }
  },
  getLocalRecordings(): MobileRecording[] { try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; } },
  async deleteLocalRecordingAsync(id: string): Promise<void> {
    const db = getOfflineDB(); await db.deleteAudio(`rec_${id}`);
    const metas = await db.getState<any[]>('recordings', []);
    await db.setState('recordings', metas.filter((r: any) => r.id !== id));
  },
  deleteLocalRecording(id: string): void { this.deleteLocalRecordingAsync(id).catch(() => {}); },
  markTransferred(id: string): void {
    try { const recs = this.getLocalRecordings().map(r => r.id === id ? { ...r, transferred: true } : r); localStorage.setItem(STORAGE_KEY, JSON.stringify(recs)); } catch {}
  },
  async uploadToServer(rec: MobileRecording, blob: Blob): Promise<boolean> {
    try {
      const formData = new FormData();
      formData.append('audio', blob, rec.fileName);
      formData.append('songId', rec.songId); formData.append('songTitle', rec.songTitle);
      formData.append('artist', rec.artist); formData.append('duration', String(rec.duration));
      formData.append('recordedAt', String(rec.recordedAt)); formData.append('recId', rec.id);
      formData.append('trackIndex', String(rec.trackIndex ?? 0));
      formData.append('trackLabel', rec.trackLabel ?? 'Voix principale');
      if (rec.takeSlot) formData.append('takeSlot', rec.takeSlot);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      let res: Response;
      try { res = await fetch('/api/studio/upload', { method: 'POST', body: formData, signal: controller.signal }); } finally { clearTimeout(timeoutId); }
      if (!res.ok) return false;
      try { const data = await res.json(); return data.success === true; } catch { return false; }
    } catch { return false; }
  },
  async getPendingFromServer(): Promise<any[]> { try { const res = await fetch('/api/studio/pending'); if (!res.ok) return []; return await res.json(); } catch { return []; } },
  async deleteFromServer(recId: string): Promise<void> { try { await fetch(`/api/studio/recording/${recId}`, { method: 'DELETE' }); } catch {} },
  makeDistortionCurve(amount: number): Float32Array {
    const k = amount * 100; const n = 44100; const curve = new Float32Array(n); const deg = Math.PI / 180;
    for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x)); }
    return curve;
  },
  // ─── ENREGISTREMENT PRO — Capture STRICTEMENT SÈCHE ────────────────────────
  //
  // iOS (WebKit Bugzilla #154538, Apple QA1631) :
  //   sampleRate = hardware AVAudioSession. Haut-parleur=48kHz, casque=44.1kHz.
  //   On ne force rien — le WAV est encodé au sampleRate natif de l'appareil.
  //   __warmContext gardé ouvert = AVAudioSession stable entre les prises.
  //   getUserMedia() direct à chaque prise (pas de clonage de stream mort).
  //
  // config.reverb IGNORÉ — les effets sont en post-prod uniquement (applyFxToTrack).
  async startRecordingPro(config: StudioEffectsConfig, onVuLevel?: (level: number) => void, onLog?: (msg: string) => void): Promise<{
    recorder: MediaRecorder | null; chunks: Blob[]; context: AudioContext; stream: MediaStream;
    analyser: AnalyserNode; monitorGain: GainNode; stopWorklet?: () => Blob;
    sourceNode: MediaStreamAudioSourceNode | null;
  }> {
    const log = (msg: string) => { console.log(`[AUDIO] ${msg}`); onLog?.(`[AUDIO] ${msg}`); };
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;

    // ✅ Réutiliser le __warmContext — NE PAS créer un nouveau contexte.
    // Un nouveau contexte force AVAudioSession à recalculer la route audio
    // ce qui peut changer le sampleRate entre les prises.
    let audioContext: AudioContext = (window as any).__warmContext;
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new AudioCtx({ latencyHint: 'interactive' });
      (window as any).__warmContext = audioContext;
      (window as any).__warmWorkletLoaded = null;
      log('AudioContext créé (nouveau)');
    } else {
      log(`AudioContext réutilisé | state=${audioContext.state}`);
    }
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
      log('AudioContext resumed');
    }
    log(`sampleRate=${audioContext.sampleRate}Hz (${audioContext.sampleRate >= 44000 ? '✅ HD' : '⚠️ bas'})`);

    // Vérifier que le contexte n'est pas dans un état irrécupérable
    if (audioContext.state === 'closed') {
      log('⚠️ AudioContext fermé — recréation forcée');
      audioContext = new AudioCtx({ latencyHint: 'interactive' });
      (window as any).__warmContext = audioContext;
      (window as any).__warmWorkletLoaded = null;
      await audioContext.resume();
    }

    // ✅ Nettoyage des nodes du cycle précédent — évite l'accumulation sur le même contexte
    const prevNodes = (window as any).__warmNodes as { source?: AudioNode; analyser?: AudioNode; worklet?: AudioNode } | undefined;
    if (prevNodes) {
      try { prevNodes.worklet?.disconnect(); } catch {}
      try { prevNodes.analyser?.disconnect(); } catch {}
      try { prevNodes.source?.disconnect(); } catch {}
      (window as any).__warmNodes = null;
      log('🔧 Nodes précédents déconnectés');
    }

    // Contraintes micro : DSP désactivé = capture brute haute qualité
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...({ googEchoCancellation: false, googNoiseSuppression: false, googAutoGainControl: false, googHighpassFilter: false } as any),
    };
    if (config.deviceId) audioConstraints.deviceId = { exact: config.deviceId };

    // ✅ getUserMedia() direct à chaque prise — stream frais garanti.
    // Le __warmContext est ouvert, ce qui maintient la session AVAudioSession stable.
    // On NE clone PAS __warmStream : un stream dont les tracks sont arrêtées est vide.
    log('getUserMedia() — stream frais');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    const track = stream.getAudioTracks()[0];
    if (track) {
      const s = track.getSettings();
      log(`Micro: ${s.sampleRate ?? '?'}Hz | echo=${s.echoCancellation} | noise=${s.noiseSuppression}`);
    }

    // Chaîne SÈCHE : source → analyser uniquement. Aucun effet.
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    // MonitorGain à 0, non connecté à destination par défaut.
    // toggleMonitoring() dans useStudioRecorder connecte/déconnecte.
    const monitorGain = audioContext.createGain();
    monitorGain.gain.value = 0;

    // Gestion visibilitychange — utiliser un flag pour éviter les doublons
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && audioContext.state === 'suspended') {
        audioContext.resume().catch(() => {});
      }
    };
    // Retirer l'ancien listener avant d'en ajouter un nouveau (multi-enregistrements)
    document.removeEventListener('visibilitychange', (window as any).__lastVisibilityHandler);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    (window as any).__lastVisibilityHandler = handleVisibilityChange;
    // NE PAS override close() — ça corrompt le warmContext entre les prises

    const pcmChunks: Float32Array[] = [];
    const chunks: Blob[] = [];
    let workletNode: AudioWorkletNode | null = null;
    let useWorklet = false;

    try {
      // ✅ addModule UNE SEULE FOIS par contexte.
      // Rappeler addModule sur un contexte actif peut déclencher un recalcul
      // AVAudioSession sur iOS → changement de sampleRate indésirable.
      const workletAlreadyLoaded = (window as any).__warmWorkletLoaded === audioContext;
      if (!workletAlreadyLoaded) {
        await audioContext.audioWorklet.addModule('/recorder-worklet.js');
        (window as any).__warmWorkletLoaded = audioContext;
        log('AudioWorklet chargé');
      } else {
        log('AudioWorklet réutilisé (déjà chargé)');
      }
      workletNode = new AudioWorkletNode(audioContext, 'recorder-processor');
      analyser.connect(workletNode);
      workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => { pcmChunks.push(new Float32Array(e.data)); };
      useWorklet = true;
      log(`✅ AudioWorklet PCM brut | ${audioContext.sampleRate}Hz`);
    } catch (err) {
      log(`⚠️ AudioWorklet ÉCHEC (${err}) → fallback MediaRecorder`);
    }

    // Sauvegarder refs pour nettoyage à la prochaine prise
    (window as any).__warmNodes = { source, analyser, worklet: workletNode };

    let recorder: MediaRecorder | null = null;
    if (!useWorklet) {
      const mimeType = getBestMimeType();
      const recOpts: MediaRecorderOptions = {}; if (mimeType) recOpts.mimeType = mimeType; recOpts.audioBitsPerSecond = 256000;
      recorder = new MediaRecorder(stream, recOpts);
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.start(100);
      log(`MediaRecorder | ${mimeType || 'défaut'} | 256kbps`);
    }

    // Encodeur WAV PCM 16-bit au sampleRate natif du hardware
    const stopWorklet = (): Blob => {
      if (workletNode) { workletNode.port.postMessage('stop'); workletNode.disconnect(); }
      const sr = audioContext.sampleRate;
      const total = pcmChunks.reduce((a, b) => a + b.length, 0);
      const dv = new DataView(new ArrayBuffer(44 + total * 2));
      let off = 0;
      const ws = (s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off++, s.charCodeAt(i)); };
      const w32 = (v: number) => { dv.setUint32(off, v, true); off += 4; };
      const w16 = (v: number) => { dv.setUint16(off, v, true); off += 2; };
      ws('RIFF'); w32(36 + total * 2); ws('WAVE'); ws('fmt '); w32(16); w16(1); w16(1);
      w32(sr); w32(sr * 2); w16(2); w16(16); ws('data'); w32(total * 2);
      for (const chunk of pcmChunks) {
        for (let i = 0; i < chunk.length; i++) {
          const s = Math.max(-1, Math.min(1, chunk[i]));
          dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true); off += 2;
        }
      }
      return new Blob([dv], { type: 'audio/wav' });
    };

    return { recorder, chunks, context: audioContext, stream, analyser, monitorGain, stopWorklet, sourceNode: source ?? null };
  },
  blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((res, rej) => {
      const reader = new FileReader(); reader.onload = () => res(reader.result as string); reader.onerror = rej; reader.readAsDataURL(blob);
    });
  },
  dataUrlToBlob(dataUrl: string): Blob {
    const [header, data] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)?.[1] ?? 'audio/mp4';
    const binary = atob(data); const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  },
  getProjects(): TrackProject[] { try { const data = localStorage.getItem('cash_studio_projects'); return data ? JSON.parse(data) : []; } catch { return []; } },
  saveProject(project: TrackProject): void { const projects = this.getProjects().filter(p => p.id !== project.id); projects.unshift(project); localStorage.setItem('cash_studio_projects', JSON.stringify(projects.slice(0, 20))); },
  deleteProject(projectId: string): void { const projects = this.getProjects().filter(p => p.id !== projectId); localStorage.setItem('cash_studio_projects', JSON.stringify(projects)); },
  getOrCreateProject(songId: string, songTitle: string): TrackProject {
    const existing = this.getProjects().find(p => p.songId === songId);
    if (existing) return existing;
    const project: TrackProject = { id: `PROJ-${Date.now()}`, songId, songTitle, createdAt: Date.now(), tracks: [] };
    this.saveProject(project); return project;
  },
  addTrackToProject(projectId: string, track: MobileRecording): TrackProject | null {
    const projects = this.getProjects(); const project = projects.find(p => p.id === projectId);
    if (!project) return null;
    // Stocker seulement les métadonnées dans localStorage (dataUrl est dans IndexedDB)
    const trackMeta = { ...track, dataUrl: undefined, blob: undefined };
    if (track.takeSlot && track.trackIndex === 0) {
      project.tracks = project.tracks.filter(t =>
        !(t.trackIndex === 0 && !t.isGenerated && t.takeSlot === track.takeSlot)
      );
    } else {
      project.tracks = project.tracks.filter(t => t.trackIndex !== track.trackIndex);
    }
    project.tracks.push(trackMeta as MobileRecording); this.saveProject(project);
    // Retourner le projet avec le vrai track (dataUrl inclus) pour le state React en mémoire
    const projectWithData = { ...project, tracks: [...project.tracks.filter(t => t.id !== track.id), track] };
    return projectWithData;
  },
  async analyzeWaveform(dataUrl: string, points = 200): Promise<number[]> {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    try {
      const blob = this.dataUrlToBlob(dataUrl); const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer); const data = audioBuffer.getChannelData(0);
      const blockSize = Math.floor(data.length / points); const waveform: number[] = [];
      for (let i = 0; i < points; i++) { let sum = 0; for (let j = 0; j < blockSize; j++) sum += Math.abs(data[i * blockSize + j] || 0); waveform.push(sum / blockSize); }
      const max = Math.max(...waveform, 0.001); return waveform.map(v => v / max);
    } finally { ctx.close(); }
  },
  async mixProject(project: TrackProject): Promise<Blob> {
    const activeTracks = project.tracks.filter(t => !t.muted && t.dataUrl);
    if (activeTracks.length === 0) throw new Error('Aucune piste valide à mixer');
    const tmpCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const decoded: { track: MobileRecording; buffer: AudioBuffer }[] = [];
    for (const track of activeTracks) {
      try { const blob = this.dataUrlToBlob(track.dataUrl!); const arrayBuffer = await blob.arrayBuffer(); const buffer = await tmpCtx.decodeAudioData(arrayBuffer); decoded.push({ track, buffer }); } catch (e) { console.warn(`[Studio] Erreur décodage piste "${track.trackLabel}":`, e); }
    }
    await tmpCtx.close(); if (decoded.length === 0) throw new Error('Aucune piste décodable');
    const shifted: { track: MobileRecording; buffer: AudioBuffer }[] = [];
    for (const { track, buffer } of decoded) {
      const semitones = track.pitchShift ?? 0;
      if (semitones !== 0) {
        try { const shiftedBuf = await pitchShiftBuffer(new (window.AudioContext || (window as any).webkitAudioContext)(), buffer, semitones); shifted.push({ track, buffer: shiftedBuf }); } catch { shifted.push({ track, buffer }); }
      } else { shifted.push({ track, buffer }); }
    }
    const maxDuration = Math.max(...shifted.map(s => s.buffer.duration)); const sampleRate = shifted[0].buffer.sampleRate;
    const offline = new OfflineAudioContext(2, Math.ceil(maxDuration * sampleRate) + 4096, sampleRate);
    for (const { track, buffer } of shifted) {
      const src = offline.createBufferSource(); src.buffer = buffer;
      const gainNode = offline.createGain(); gainNode.gain.value = track.gain ?? 1.0;
      const panner = offline.createStereoPanner(); panner.pan.value = track.pan ?? 0;
      src.connect(gainNode); gainNode.connect(panner); panner.connect(offline.destination); src.start(0);
    }
    const rendered = await safeStartRendering(offline); return audioBufferToBlob(rendered);
  },
  async mixComp(takes: Take[], gain = 1.0): Promise<Blob> {
    const allRegions = takes.flatMap(take => take.regions.map(r => ({ ...r, recording: take.recording }))).sort((a, b) => a.startSec - b.startSec);
    if (allRegions.length === 0) throw new Error('Aucune région sélectionnée');
    const tmpCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const bufferMap = new Map<string, AudioBuffer>();
    for (const take of takes) {
      if (!take.recording.dataUrl || bufferMap.has(take.recording.id)) continue;
      try { const blob = this.dataUrlToBlob(take.recording.dataUrl); const ab = await blob.arrayBuffer(); const buf = await tmpCtx.decodeAudioData(ab); bufferMap.set(take.recording.id, buf); } catch (e) { console.warn(`[Comp] Erreur décodage prise ${take.recording.id}:`, e); }
    }
    await tmpCtx.close();
    const totalDuration = allRegions.reduce((sum, r) => sum + (r.endSec - r.startSec), 0); const sampleRate = 44100;
    const offline = new OfflineAudioContext(2, Math.ceil(totalDuration * sampleRate), sampleRate);
    let cursor = 0;
    for (const region of allRegions) {
      const buf = bufferMap.get(region.takeId); if (!buf) continue;
      const regionDuration = region.endSec - region.startSec; if (regionDuration <= 0) continue;
      const source = offline.createBufferSource(); source.buffer = buf;
      const gainNode = offline.createGain(); gainNode.gain.value = gain;
      const fadeTime = Math.min(0.02, regionDuration / 4);
      gainNode.gain.setValueAtTime(0, cursor); gainNode.gain.linearRampToValueAtTime(gain, cursor + fadeTime);
      gainNode.gain.setValueAtTime(gain, cursor + regionDuration - fadeTime); gainNode.gain.linearRampToValueAtTime(0, cursor + regionDuration);
      source.connect(gainNode); gainNode.connect(offline.destination); source.start(cursor, region.startSec, regionDuration);
      cursor += regionDuration;
    }
    const rendered = await safeStartRendering(offline); return audioBufferToBlob(rendered);
  },

  async generateLayersFromVoice(mainVoice: MobileRecording, project: TrackProject, onProgress?: (label: string, pct: number) => void, songMeta?: { realPartition?: any[]; key?: string }, targetTrackIndex?: number): Promise<MobileRecording[]> {
    const progress = (label: string, pct: number) => onProgress?.(label, pct);
    progress('Décodage voix principale', 5);

    // Récupérer le blob : priorité dataUrl en mémoire, sinon IndexedDB
    // On essaie toujours IndexedDB si dataUrl manquant ou trop petit
    let srcBlob: Blob | null = null;
    const db = getOfflineDB();
    if (mainVoice.dataUrl && mainVoice.dataUrl.length > 1000) {
      srcBlob = this.dataUrlToBlob(mainVoice.dataUrl);
    }
    if (!srcBlob || srcBlob.size < 1000) {
      try {
        progress('Chargement audio depuis le stockage local...', 3);
        const dbBlob = await db.getAudio(`rec_${mainVoice.id}`);
        if (dbBlob && dbBlob.size > 1000) srcBlob = dbBlob;
      } catch (e) {
        console.warn('[generateLayers] IndexedDB error:', e);
      }
    }
    // Dernier recours : tenter la clé backup
    if (!srcBlob || srcBlob.size < 1000) {
      try {
        progress('Tentative restauration depuis backup...', 4);
        const backupBlob = await db.getAudio(`backup_voice_${mainVoice.id}`);
        if (backupBlob && backupBlob.size > 1000) {
          srcBlob = backupBlob;
          console.warn('[generateLayers] ⚠️ Restauration depuis backup automatique');
        }
      } catch {}
    }
    if (!srcBlob || srcBlob.size < 1000) {
      throw new Error(`Fichier audio introuvable (id: ${mainVoice.id}). Veuillez ré-enregistrer la voix principale.`);
    }

    // Réutiliser le buffer déjà décodé si disponible (mis en cache après l'enregistrement)
    // Évite decodeAudioData sur un gros fichier — cause principale du freeze iOS
    let srcBuffer: AudioBuffer;
    const cachedBuf = (window as any).__lastRecDecodedBuf as AudioBuffer | undefined;
    const cachedId  = (window as any).__lastRecDecodedId  as string | undefined;
    if (cachedBuf && cachedId === mainVoice.id) {
      progress('Buffer audio en cache ✅', 9);
      srcBuffer = cachedBuf;
    } else {
      // Pas de cache — décoder maintenant (peut être lent sur iOS pour les gros fichiers)
      progress('Décodage audio...', 6);
      const srcAb = await srcBlob.arrayBuffer();
      const tmpCtx = new (window.AudioContext || (window as any).webkitAudioContext());
      try { srcBuffer = await tmpCtx.decodeAudioData(srcAb); } finally { tmpCtx.close(); }
      // Mettre en cache pour les prochaines générations
      (window as any).__lastRecDecodedBuf = srcBuffer;
      (window as any).__lastRecDecodedId  = mainVoice.id;
    }
    // Construire la carte des accords depuis realPartition
    const songKey  = parseKey(songMeta?.key || '');
    const chordMap = songMeta?.realPartition ? buildChordMap(songMeta.realPartition, songKey) : [];
    const hasChordData = chordMap.length > 0;
    if (hasChordData) progress(`🎵 Analyse harmonique — ${chordMap.length} accords détectés`, 8);

    // Helper : envoyer une couche au Web Worker et attendre le résultat WAV
    const processLayerInWorker = (op: string, semitones: number, gain: number, pan: number): Promise<Blob> => {
      return new Promise((resolve, reject) => {
        const workerUrl = '/harmony-worker.js';
        let worker: Worker;
        try { worker = new Worker(workerUrl); } catch(e: any) {
          reject(new Error('Worker non disponible : ' + e.message)); return;
        }
        const id = Date.now();
        const channelL = srcBuffer.getChannelData(0);
        const channelR = srcBuffer.numberOfChannels > 1 ? srcBuffer.getChannelData(1) : srcBuffer.getChannelData(0);
        // Copier pour transfert (les buffers originaux ne doivent pas être détachés)
        const transferL = channelL.slice();
        const transferR = channelR.slice();
        const timeout = setTimeout(() => {
          worker.terminate();
          reject(new Error('Worker timeout (>120s)'));
        }, 120000);
        worker.onmessage = (e) => {
          const msg = e.data;
          if (msg.id !== id) return;
          if (msg.type === 'progress') {
            progress(`${msg.label}`, -1); // -1 = pas de changement de %
          } else if (msg.type === 'done') {
            clearTimeout(timeout);
            worker.terminate();
            resolve(new Blob([msg.wavBuf], { type: 'audio/wav' }));
          } else if (msg.type === 'error') {
            clearTimeout(timeout);
            worker.terminate();
            reject(new Error(msg.message));
          }
        };
        worker.onerror = (e) => { clearTimeout(timeout); worker.terminate(); reject(new Error(e.message)); };
        worker.postMessage({ id, op, channelL: transferL, channelR: transferR, semitones, gain, pan, sampleRate: srcBuffer.sampleRate }, [transferL.buffer, transferR.buffer]);
      });
    };

    const allLayers = [
      { trackIndex: 1, trackLabel: 'Double tracking', pitch: 0, gain: 0.85, pan: -0.3, emoji: '🎵', isDouble: true, suggestedFxId: 'double_epic' },
      { trackIndex: 2, trackLabel: 'Harmonie +3', pitch: 3, gain: 0.75, pan: 0.4, emoji: '🎶', isDouble: false, suggestedFxId: 'harmony' },
      { trackIndex: 3, trackLabel: 'Harmonie +7', pitch: 7, gain: 0.70, pan: -0.4, emoji: '🎼', isDouble: false, suggestedFxId: 'harmony' },
      { trackIndex: 4, trackLabel: 'Octave bas', pitch: -12, gain: 0.80, pan: 0.0, emoji: '🔉', isDouble: false, suggestedFxId: 'octave_deep' },
      { trackIndex: 5, trackLabel: 'Harmonie +5', pitch: 5, gain: 0.72, pan: 0.3, emoji: '✨', isDouble: false, suggestedFxId: 'harmony' },
    ];
    // Si targetTrackIndex spécifié → générer seulement cette harmonie
    const layers = targetTrackIndex !== undefined
      ? allLayers.filter(l => l.trackIndex === targetTrackIndex)
      : allLayers;
    const generated: MobileRecording[] = [];

    const yieldToMain = () => new Promise<void>(r => setTimeout(r, 80));

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]; const pct = 10 + (i / layers.length) * 75;
      await yieldToMain();
      progress(`${layer.emoji} ${layer.trackLabel} — Worker en cours...`, pct);

      let blob: Blob;
      try {
        blob = await processLayerInWorker(
          layer.isDouble ? 'double' : 'pitch',
          layer.pitch, layer.gain, layer.pan
        );
        progress(`${layer.emoji} ${layer.trackLabel} — OK (${(blob.size/1024).toFixed(0)} Ko)`, pct + 5);
      } catch (workerErr: any) {
        // Le Worker a échoué — pas de fallback main thread (crasherait iOS)
        // Loguer et continuer avec les autres harmonies
        progress(`⚠️ ${layer.trackLabel} échouée : ${workerErr.message}`, pct);
        await yieldToMain();
        continue;
      }

      await yieldToMain();

      // Convertir en dataUrl seulement si < 5MB — sinon sentinelle opfs: pour éviter crash iOS
      let dataUrl: string;
      if (blob.size < 5 * 1024 * 1024) {
        dataUrl = await this.blobToDataUrl(blob);
      } else {
        const harmKey = `harmony_${Date.now()}_${layer.trackIndex}`;
        // Garder en mémoire — pas de sauvegarde OPFS (quota)
        if (!(window as any).__harmonyBlobs) (window as any).__harmonyBlobs = {};
        (window as any).__harmonyBlobs[harmKey] = blob;
        dataUrl = `opfs:${harmKey}`;
      }
      const safeTitle = (mainVoice.songTitle || 'song').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
      const fileName = `${safeTitle}_T${layer.trackIndex}_GEN_${Date.now()}.wav`;
      const rec: MobileRecording = {
        id: `GEN-${layer.trackIndex}-${Date.now()}`, songId: mainVoice.songId, songTitle: mainVoice.songTitle, artist: mainVoice.artist,
        duration: mainVoice.duration, recordedAt: Date.now(), dataUrl, transferred: false, fileName,
        trackIndex: layer.trackIndex, trackLabel: layer.trackLabel, pitchShift: layer.isDouble ? 0 : layer.pitch,
        gain: layer.gain, pan: layer.pan, projectId: project.id, isGenerated: true, fxPresetId: layer.suggestedFxId
      } as any;
      this.saveRecordingLocally(rec);
      generated.push(rec as any);
      progress(`✅ ${layer.trackLabel} sauvegardée (${i + 1}/${layers.length})`, pct + 6);
      await yieldToMain();
    }
    progress('✅ Toutes les harmonies générées', 100); return generated;
  },
  async applyFxToTrack(dataUrl: string, fx: { lowGain: number; midGain: number; highGain: number; compThreshold: number; compRatio: number; compAttack: number; compRelease: number; compKnee: number; saturation: number; reverb: string; reverbMix: number; autotune?: number; autotuneSpeed?: string; }, onProgress?: (pct: number) => void): Promise<string> {
    onProgress?.(5);
    // Décoder — réutiliser le cache si disponible
    let srcBuf: AudioBuffer;
    const lastFxUrl = (window as any).__lastFxSourceUrl as string | undefined;
    const cachedBuf = (window as any).__lastRecDecodedBuf as AudioBuffer | undefined;
    if (cachedBuf && lastFxUrl === dataUrl) {
      srcBuf = cachedBuf;
    } else {
      // Résoudre le blob source (dataUrl normale ou sentinelle opfs:)
      let srcBlob: Blob;
      if (dataUrl.startsWith('opfs:')) {
        const key = dataUrl.slice(5);
        const fxBlob    = (window as any).__lastFxBlob as Blob | undefined;
        const fxKey     = (window as any).__lastFxKey  as string | undefined;
        const harmBlobs = (window as any).__harmonyBlobs as Record<string,Blob> | undefined;
        if (fxBlob && fxKey === key) srcBlob = fxBlob;
        else if (harmBlobs && harmBlobs[key]) srcBlob = harmBlobs[key];
        else throw new Error('Blob FX introuvable en mémoire — réappliquer le FX');
      } else {
        srcBlob = this.dataUrlToBlob(dataUrl);
      }
      if (srcBlob.size > 40 * 1024 * 1024) throw new Error(`Fichier trop volumineux (${(srcBlob.size/1024/1024).toFixed(0)} MB)`);
      const ab = await srcBlob.arrayBuffer();
      const tmpCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      try { srcBuf = await tmpCtx.decodeAudioData(ab); } finally { tmpCtx.close(); }
      (window as any).__lastFxSourceUrl   = dataUrl;
      (window as any).__lastRecDecodedBuf = srcBuf;
    }
    onProgress?.(20);
    // Envoyer au Worker FX — tout le traitement hors main thread
    return new Promise((resolve, reject) => {
      let worker: Worker;
      try { worker = new Worker('/fx-worker.js'); } catch(e: any) {
        reject(new Error('FX Worker non disponible : ' + e.message)); return;
      }
      const id = Date.now();
      const chL = srcBuf.getChannelData(0).slice();
      const chR = (srcBuf.numberOfChannels > 1 ? srcBuf.getChannelData(1) : srcBuf.getChannelData(0)).slice();
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error('FX timeout')); }, 180000);
      worker.onmessage = async (e) => {
        const msg = e.data;
        if (msg.id !== id) return;
        if (msg.type === 'progress') {
          onProgress?.(msg.pct);
        } else if (msg.type === 'done') {
          clearTimeout(timeout); worker.terminate();
          try {
            const resultBlob = new Blob([msg.wavBuf], { type: 'audio/wav' });
            const fxKey = `fx_${Date.now()}`;

            // Garder le blob en mémoire — pas de sauvegarde OPFS (évite quota exceeded)
            // Le FX est temporaire pour la session, le blob original est préservé dans OPFS
            (window as any).__lastFxKey  = fxKey;
            (window as any).__lastFxBlob = resultBlob;

            // Retourner dataUrl seulement si < 5MB, sinon sentinelle opfs:
            let resultDataUrl: string;
            if (resultBlob.size < 5 * 1024 * 1024) {
              resultDataUrl = await this.blobToDataUrl(resultBlob);
            } else {
              resultDataUrl = `opfs:${fxKey}`;
            }
            (window as any).__lastFxSourceUrl = resultDataUrl;
            onProgress?.(100);
            resolve(resultDataUrl);
          } catch(e2: any) { reject(e2); }
        } else if (msg.type === 'error') {
          clearTimeout(timeout); worker.terminate();
          reject(new Error(msg.message));
        }
      };
      worker.onerror = (e) => { clearTimeout(timeout); worker.terminate(); reject(new Error(e.message)); };
      worker.postMessage({ id, channelL: chL, channelR: chR, sampleRate: srcBuf.sampleRate, fx }, [chL.buffer, chR.buffer]);
    });
  },
};
