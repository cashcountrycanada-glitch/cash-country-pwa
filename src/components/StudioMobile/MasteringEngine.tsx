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
import { studioService, MobileRecording, audioBufferToBlob as audioBufferToWavBlobReliable } from '../../services/StudioService';
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
  // FIX "reverb trop prononcée / instrumental écrasé" (v7.6.435) : bus d'envoi
  // SEC (lead+double+harmonies à niveaux différenciés, SANS reverb) — fourni
  // uniquement si le style "Bus partagé" est sélectionné. La reverb est
  // appliquée ICI, APRÈS masterAudio() (voir runMastering plus bas), jamais
  // avant : la chaîne de mastering (gate/EQ/de-esser/compression multibande)
  // est calibrée pour un signal sec, l'appliquer sur un signal déjà
  // réverbéré la fait réagir à la queue de reverb (continue, soutenue) au
  // lieu des phrases vocales — ça écrase les harmonies/double et gonfle le
  // 250-500Hz au détriment de l'instrumental une fois tout remixé.
  sendBusBlob?: Blob | null;
  // FIX "pas de slapback delay" (v7.6.436) : lead isolé (trackIndex 0 seul,
  // sans double/harmonies) — nécessaire pour taper le slapback delay
  // uniquement sur le lead, sans écho parasite sur le reste du groupe voix.
  leadOnlyBlob?: Blob | null;
  // L'instrumental à mixer pour l'export publication (null si non disponible)
  instBlob:     Blob | null;
  // Décalage Auto Sync détecté dans le mixer (ms) — appliqué entre la voix
  // déjà masterisée et l'instrumental au moment de la fusion finale.
  // AVANT ce correctif : jamais transmis ici, donc jamais appliqué dans le
  // fichier exporté final, peu importe le réglage Auto Sync fait ailleurs.
  instOffsetMs?: number;
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

// FIX CRASH ÉCRAN NOIR (v7.6.402) : sur iOS, si le thread principal reste
// bloqué trop longtemps par du calcul JS synchrone, WebKit considère la page
// "unresponsive" et tue le processus de contenu → écran noir, seule la barre
// du haut reste, tout le React (y compris le DebugPanel) disparaît d'un coup.
// Les fonctions d'analyse (LUFS, True Peak) et de traitement (noise gate,
// saturation) tournaient boucle-par-sample sur la chanson ENTIÈRE sans jamais
// rendre la main — et étaient appelées plusieurs fois par export (voix seule
// + mix complet, jusqu'à 3 passes pour le True Peak). Ce helper les découpe
// en tranches avec une micro-pause entre chaque, pour laisser iOS respirer.
const CHUNK_YIELD_SAMPLES = 150000; // pause tous les ~3.4s d'audio traité
function yieldToMain(): Promise<void> {
  return new Promise(r => setTimeout(r, 0));
}

// LUFS ITU-R BS.1770-4 avec gating — standard broadcast complet
// Gating absolu (-70 LUFS) + gating relatif (-10 LU) selon EBU R128
async function analyzeLoudness(buffer: AudioBuffer): Promise<number> {
  const sr = buffer.sampleRate;
  const ch = Math.min(2, buffer.numberOfChannels);

  // ── Filtre K-weighting BS.1770 étape 1 : pre-filter high-shelf +4dB à 1681Hz ──
  const f0 = 1681.0, Q = 0.7071, dBgain = 3.99984;
  const A  = Math.pow(10, dBgain / 40);
  const w0 = 2 * Math.PI * f0 / sr;
  const sinW = Math.sin(w0), cosW = Math.cos(w0);
  const alpha = sinW / (2 * Q);
  const b0s = A*((A+1)+(A-1)*cosW+2*Math.sqrt(A)*alpha);
  const b1s = -2*A*((A-1)+(A+1)*cosW);
  const b2s = A*((A+1)+(A-1)*cosW-2*Math.sqrt(A)*alpha);
  const a0s = (A+1)-(A-1)*cosW+2*Math.sqrt(A)*alpha;
  const a1s = 2*((A-1)-(A+1)*cosW);
  const a2s = (A+1)-(A-1)*cosW-2*Math.sqrt(A)*alpha;

  // ── Filtre K-weighting étape 2 : high-pass 2nd order à 38Hz ──
  const f1 = 38.13547; const Q1 = 0.5003270;
  const w1 = 2*Math.PI*f1/sr;
  const sinW1 = Math.sin(w1), cosW1 = Math.cos(w1);
  const alpha1 = sinW1/(2*Q1);
  const b0h = 1, b1h = -2, b2h = 1;
  const a0h = 1+alpha1, a1h = -2*cosW1, a2h = 1-alpha1;

  // Appliquer les deux filtres K-weighting sur chaque canal
  const filtered: Float32Array[] = [];
  for (let c = 0; c < ch; c++) {
    const data = buffer.getChannelData(c);
    const f = new Float32Array(data.length);
    // Filtre 1 (shelf)
    let x1=0,x2=0,y1=0,y2=0;
    for (let i=0;i<data.length;i++) {
      const x0=data[i];
      const y0=(b0s/a0s)*x0+(b1s/a0s)*x1+(b2s/a0s)*x2-(a1s/a0s)*y1-(a2s/a0s)*y2;
      f[i]=y0; x2=x1; x1=x0; y2=y1; y1=y0;
      if (i % CHUNK_YIELD_SAMPLES === 0 && i > 0) await yieldToMain();
    }
    // Filtre 2 (high-pass)
    let x1b=0,x2b=0,y1b=0,y2b=0;
    for (let i=0;i<f.length;i++) {
      const x0=f[i];
      const y0=(b0h/a0h)*x0+(b1h/a0h)*x1b+(b2h/a0h)*x2b-(a1h/a0h)*y1b-(a2h/a0h)*y2b;
      f[i]=y0; x2b=x1b; x1b=x0; y2b=y1b; y1b=y0;
      if (i % CHUNK_YIELD_SAMPLES === 0 && i > 0) await yieldToMain();
    }
    filtered.push(f);
  }

  // Découpage en blocs de 400ms avec overlap 75% (blocs de 100ms)
  const blockSize  = Math.floor(sr * 0.4);
  const hopSize    = Math.floor(sr * 0.1);
  const numBlocks  = Math.floor((buffer.length - blockSize) / hopSize) + 1;
  const blockPower: number[] = [];

  for (let b=0; b<numBlocks; b++) {
    const start = b * hopSize;
    let power = 0;
    for (let c=0; c<ch; c++) {
      const w = c === 1 ? 1.0 : 1.0; // G_L=G_R=1.0, G_C=1.0 (stéréo sans centre)
      let sum = 0;
      for (let i=start; i<start+blockSize && i<filtered[c].length; i++)
        sum += filtered[c][i] * filtered[c][i];
      power += w * sum / blockSize;
    }
    blockPower.push(power);
    if (b % 500 === 0 && b > 0) await yieldToMain();
  }

  if (blockPower.length === 0) return -100;

  // Gating absolu : garder blocs > -70 LUFS
  const absThresh = Math.pow(10, (-70 + 0.691) / 10);
  const gated1 = blockPower.filter(p => p > absThresh);
  if (gated1.length === 0) return -100;

  // LUFS intermédiaire sur blocs gated absolu
  const mean1 = gated1.reduce((a,b) => a+b, 0) / gated1.length;
  const lufs1 = -0.691 + 10 * Math.log10(mean1);

  // Gating relatif : garder blocs > LUFS_intermédiaire - 10 LU
  const relThresh = Math.pow(10, (lufs1 - 10 + 0.691) / 10);
  const gated2 = gated1.filter(p => p > relThresh);
  if (gated2.length === 0) return lufs1;

  const mean2 = gated2.reduce((a,b) => a+b, 0) / gated2.length;
  return -0.691 + 10 * Math.log10(mean2);
}

// True Peak measurement — détecte les inter-sample peaks via oversampling 4x
// Les inter-sample peaks peuvent dépasser 0 dBFS même si les samples sont sous 0 dBFS
// Standard EBU R128 / ITU-R BS.1770-4 : max -1 dBTP
async function measureTruePeak(buffer: AudioBuffer): Promise<number> {
  const ch = Math.min(2, buffer.numberOfChannels);
  let maxTP = 0;
  // Oversampling 4x via interpolation sinc simplifiée (Lanczos-2)
  const oversample = 4;
  for (let c=0; c<ch; c++) {
    const data = buffer.getChannelData(c);
    const len = data.length;
    for (let i=2; i<len-2; i++) {
      for (let s=0; s<oversample; s++) {
        const t = s / oversample;
        if (t === 0) { maxTP = Math.max(maxTP, Math.abs(data[i])); continue; }
        // Interpolation cubique 4-points (approx Lanczos)
        const p0=data[i-1], p1=data[i], p2=data[i+1], p3=data[i+2];
        const a = (-p0 + 3*p1 - 3*p2 + p3) / 2;
        const b = p0 - 2.5*p1 + 2*p2 - 0.5*p3;
        const cc = (-p0 + p2) / 2;
        const interp = ((a*t + b)*t + cc)*t + p1;
        maxTP = Math.max(maxTP, Math.abs(interp));
      }
      // 4x oversample → pause plus fréquente, ce calcul est le plus coûteux du pipeline
      if (i % CHUNK_YIELD_SAMPLES === 0 && i > 0) await yieldToMain();
    }
  }
  return maxTP > 0 ? 20 * Math.log10(maxTP) : -100; // dBTP
}

// Rendu OfflineAudioContext segmenté pour iOS
// Évite le freeze/écran noir sur les longues chansons (> 2 minutes)
// Découpe en segments de 60s, rendu séquentiel avec yield entre chaque
async function renderOfflineSegmented(
  buildGraph: (ctx: OfflineAudioContext) => void,
  totalSamples: number,
  sampleRate: number,
  onProgress?: (pct: number) => void
): Promise<AudioBuffer> {
  const segmentSamples = sampleRate * 55; // segments 55s — marge pour iOS
  const numSegments = Math.ceil(totalSamples / segmentSamples);

  // Si court (<55s) → rendu direct sans segmentation
  if (numSegments <= 1) {
    const ctx = new OfflineAudioContext(2, totalSamples, sampleRate);
    buildGraph(ctx);
    return ctx.startRendering();
  }

  // Rendu segmenté avec pause entre chaque pour libérer le thread iOS
  const allChannelData: Float32Array[][] = [[], []];
  for (let seg = 0; seg < numSegments; seg++) {
    const start  = seg * segmentSamples;
    const length = Math.min(segmentSamples, totalSamples - start);
    // Yield pour laisser respirer le thread iOS entre segments
    await new Promise<void>(r => setTimeout(r, 80)); // yield entre segments
    onProgress?.(Math.round((seg / numSegments) * 80));
    const ctx = new OfflineAudioContext(2, length, sampleRate);
    buildGraph(ctx);
    const rendered = await ctx.startRendering();
    allChannelData[0].push(new Float32Array(rendered.getChannelData(0)));
    allChannelData[1].push(new Float32Array(rendered.getChannelData(1)));
  }

  // Concaténer tous les segments
  const finalCtx = new OfflineAudioContext(2, totalSamples, sampleRate);
  const finalBuf = finalCtx.createBuffer(2, totalSamples, sampleRate);
  for (let c = 0; c < 2; c++) {
    const ch = finalBuf.getChannelData(c);
    let offset = 0;
    for (const seg of allChannelData[c]) { ch.set(seg, offset); offset += seg.length; }
  }
  onProgress?.(85);
  return finalBuf;
}

async function decodeBlob(blob: Blob): Promise<AudioBuffer> {
  try { (window as any).__breadcrumb?.('🔊 decodeBlob : création AudioContext...'); } catch {}
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  try { (window as any).__breadcrumb?.(`🔊 decodeBlob : AudioContext créé (state=${ctx.state}), décodage ${blob.size}B...`); } catch {}
  try {
    const ab  = await blob.arrayBuffer();
    const buf = await ctx.decodeAudioData(ab);
    try { (window as any).__breadcrumb?.(`🔊 decodeBlob : décodage réussi (${buf.duration.toFixed(1)}s)`); } catch {}
    return buf;
  } finally {
    ctx.close();
  }
}

// Mixer vocal + instrumental avec balance pro
// Approche : normaliser les deux séparément, puis mixer avec ratio fixe voix/inst
async function mixVocalWithInst(
  vocalBuf: AudioBuffer,
  instBuf:  AudioBuffer,
  instGainDb: number = -3,
  instOffsetMs: number = 0,
): Promise<AudioBuffer> {
  // FIX "instrumental silencieux en début de piste / semble ne jouer qu'avec
  // la voix" (v7.6.426) : un instOffsetMs anormalement grand (ex: plusieurs
  // secondes, provenant d'un Auto Sync buggé ou d'une valeur restée collée à
  // un ancien projet) décale le DÉPART de l'instrumental d'autant — ce qui
  // crée un vrai silence numérique en début de piste (pas juste une baisse de
  // volume) et peut donner l'impression que l'instrumental "attend" la voix.
  // Une vraie correction de sync ne dépasse jamais quelques centaines de ms —
  // au-delà de 2 secondes, c'est presque certainement une valeur aberrante,
  // pas une intention réelle. On l'ignore dans ce cas et on prévient.
  const rawOffsetMs = instOffsetMs;
  if (Math.abs(instOffsetMs) > 2000) {
    try { (window as any).__breadcrumb?.(`⚠️ instOffsetMs aberrant ignoré: ${rawOffsetMs}ms (vocal=${vocalBuf.duration.toFixed(1)}s, inst=${instBuf.duration.toFixed(1)}s) → traité comme 0`); } catch {}
    instOffsetMs = 0;
  } else {
    try { (window as any).__breadcrumb?.(`🎚️ mixVocalWithInst : instOffsetMs=${instOffsetMs}ms, vocal=${vocalBuf.duration.toFixed(1)}s, inst=${instBuf.duration.toFixed(1)}s`); } catch {}
  }
  const sr       = Math.max(vocalBuf.sampleRate, instBuf.sampleRate);
  const offsetSec = instOffsetMs / 1000;
  const duration = Math.max(vocalBuf.duration, instBuf.duration + Math.abs(offsetSec));

  // Mesurer les peaks des deux signaux
  const peakOf = async (buf: AudioBuffer): Promise<number> => {
    let pk = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < ch.length; i++) {
        const a = Math.abs(ch[i]); if (a > pk) pk = a;
        if (i % CHUNK_YIELD_SAMPLES === 0 && i > 0) await yieldToMain();
      }
    }
    return pk;
  };
  const vocalPeak = await peakOf(vocalBuf);
  const instPeak  = await peakOf(instBuf);

  // Normaliser chaque signal à -1dBFS séparément
  // Puis appliquer le ratio voix/inst souhaité
  const targetPeak = 0.891; // -1dBFS
  const vocalGain  = vocalPeak > 0.001 ? targetPeak / vocalPeak : 1.0;
  // inst à -3dB sous la voix par défaut (ratio 0.708)
  const instRatio  = Math.pow(10, instGainDb / 20); // ex: -3dB → 0.708
  const instGain   = instPeak  > 0.001 ? (targetPeak / instPeak) * instRatio : instRatio;

  const offline = new OfflineAudioContext(2, Math.ceil(duration * sr), sr);

  // Voix — canal L et R séparés pour stéréo propre
  const vSrc = offline.createBufferSource();
  vSrc.buffer = vocalBuf;
  const vGain = offline.createGain();
  vGain.gain.value = vocalGain;
  vSrc.connect(vGain); vGain.connect(offline.destination);
  vSrc.start(0);

  // Instrumental — décalage Auto Sync appliqué ici (AVANT ce correctif :
  // jamais appliqué dans le fichier final masterisé/exporté, peu importe
  // le réglage Auto Sync fait dans le mixer). Même convention que mixProject
  // et le REC en direct : offset > 0 → inst démarre plus tard ;
  // offset < 0 → inst démarre à une position plus avancée dans son buffer.
  const iSrc = offline.createBufferSource();
  iSrc.buffer = instBuf;
  const iGain = offline.createGain();
  iGain.gain.value = instGain;
  iSrc.connect(iGain); iGain.connect(offline.destination);
  if (offsetSec >= 0) {
    iSrc.start(offsetSec);
  } else {
    iSrc.start(0, Math.min(-offsetSec, instBuf.duration));
  }

  const mixed = await offline.startRendering();

  // Side-chain ducking propre — travaille sur des buffers séparés, pas le mix
  // Calcul de l'enveloppe vocale
  const vL = vocalBuf.getChannelData(0);
  const vR = vocalBuf.numberOfChannels > 1 ? vocalBuf.getChannelData(1) : vocalBuf.getChannelData(0);
  const L  = mixed.getChannelData(0);
  const R  = mixed.numberOfChannels > 1 ? mixed.getChannelData(1) : mixed.getChannelData(0);

  const duckThresh  = 0.15;  // seuil sur voix normalisée
  const duckAmount  = 0.20;  // inst baisse de 20% (-2dB) quand voix forte
  const attackSamp  = Math.floor(sr * 0.005);  // attack 5ms
  const releaseSamp = Math.floor(sr * 0.150);  // release 150ms
  let env = 1.0;
  let holdCount = 0;
  const holdSamp = Math.floor(sr * 0.050); // hold 50ms

  for (let i = 0; i < L.length; i++) {
    const vi = i < vL.length
      ? Math.abs(vL[i] * vocalGain * 0.5 + vR[i] * vocalGain * 0.5)
      : 0;
    const targetEnv = vi > duckThresh ? (1.0 - duckAmount) : 1.0;
    if (vi > duckThresh) { holdCount = holdSamp; }
    else if (holdCount > 0) { holdCount--; }

    // Envelope follower smooth
    const coeff = targetEnv < env ? (1 - Math.exp(-1/attackSamp)) : (1 - Math.exp(-1/releaseSamp));
    if (holdCount === 0) env += (targetEnv - env) * coeff;

    // Appliquer le ducking sur le mix complet, puis rebooter la voix
    const vocalComponent = i < vL.length
      ? (vL[i] * vocalGain * 0.5 + vR[i] * vocalGain * 0.5)
      : 0;
    // Atténuer le mix
    L[i] *= env;
    R[i] *= env;
    // Compenser la réduction sur la voix (la voix reste pleine)
    if (i < vL.length) {
      L[i] += vL[i] * vocalGain * (1.0 - env);
      R[i] += vR[i] * vocalGain * (1.0 - env);
    }
    if (i % CHUNK_YIELD_SAMPLES === 0 && i > 0) await yieldToMain();
  }
  return mixed;
}

// Tape saturation douce — signature chaleur analogique
// Applique une distorsion asymétrique légère qui enrichit les harmoniques
async function applySaturation(data: Float32Array, drive: number = 0.3): Promise<Float32Array> {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const x = data[i] * (1 + drive);
    // Waveshaping doux (tanh approximé) — asymétrique comme un vrai préamp à lampes
    out[i] = x < 0
      ? Math.tanh(x * 0.9)   // légèrement plus doux sur les négatifs
      : Math.tanh(x * 1.0);
    if (i % CHUNK_YIELD_SAMPLES === 0 && i > 0) await yieldToMain();
  }
  return out;
}

// Noise gate — coupe le bruit de fond entre les phrases vocales
// Seuil en amplitude linéaire, release doux pour éviter les clics
async function applyNoiseGate(data: Float32Array, thresholdDb: number = -65, releaseMs: number = 150, sr: number = 44100): Promise<Float32Array> {
  // Seuil adaptatif : calculer le plancher de bruit du signal
  // Utiliser le 10e percentile de l'énergie comme référence pour le bruit de fond
  const blockSize = Math.floor(sr * 0.01); // blocs 10ms
  const numBlocks = Math.floor(data.length / blockSize);
  const blockEnergies: number[] = [];
  for (let b = 0; b < numBlocks; b++) {
    let e = 0;
    for (let i = b*blockSize; i < (b+1)*blockSize; i++) e += data[i]*data[i];
    blockEnergies.push(Math.sqrt(e/blockSize));
    if (b % 20000 === 0 && b > 0) await yieldToMain();
  }
  blockEnergies.sort((a,b) => a-b);
  // Plancher = médiane des 15% plus silencieux + 6dB de marge
  const noiseFloor = blockEnergies[Math.floor(numBlocks * 0.15)] * 2.0;
  // Seuil = max(noiseFloor * 3, seuil demandé)
  const requestedThresh = Math.pow(10, thresholdDb / 20);
  const threshold = Math.max(requestedThresh, noiseFloor * 3);

  const releaseSamp = Math.floor((releaseMs / 1000) * sr);
  const holdSamp    = Math.floor(0.12 * sr); // hold 120ms — préserve les fins de phrases
  const out = new Float32Array(data.length);
  let gateOpen = false;
  let holdCount = 0;
  let releaseCount = 0;
  for (let i = 0; i < data.length; i++) {
    const amp = Math.abs(data[i]);
    if (amp > threshold) {
      gateOpen = true; holdCount = holdSamp; releaseCount = releaseSamp;
    } else if (holdCount > 0) {
      holdCount--;
    } else if (releaseCount > 0) {
      releaseCount--;
      gateOpen = releaseCount > 0;
    } else {
      gateOpen = false;
    }
    // Fermeture douce avec envelope — évite les clics
    const gain = gateOpen ? 1.0 : Math.max(0, releaseCount / releaseSamp);
    out[i] = data[i] * gain;
    if (i % CHUNK_YIELD_SAMPLES === 0 && i > 0) await yieldToMain();
  }
  return out;
}

// Stereo widening via mid/side (M/S) processing
// Élargit l'image stéréo sans perturber la compatibilité mono
async function stereoWiden(buf: AudioBuffer, widthGain: number = 1.3): Promise<AudioBuffer> {
  if (buf.numberOfChannels < 2) return buf;
  const len = buf.length;
  const sr  = buf.sampleRate;
  const offline = new OfflineAudioContext(2, len, sr);
  const outBuf  = offline.createBuffer(2, len, sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const outL = outBuf.getChannelData(0);
  const outR = outBuf.getChannelData(1);
  for (let i = 0; i < len; i++) {
    const mid  = (L[i] + R[i]) * 0.5;
    const side = (L[i] - R[i]) * 0.5 * widthGain;
    outL[i] = mid + side;
    outR[i] = mid - side;
    if (i % CHUNK_YIELD_SAMPLES === 0 && i > 0) await yieldToMain();
  }
  // Vérification compatibilité mono : le sum L+R ne doit pas annuler la voix
  // (phase cancellation si trop de widening sur signal déjà stéréo)
  let monoIssue = false;
  for (let i = 0; i < Math.min(len, 1000); i++) {
    const mono = outL[i] + outR[i];
    const original = L[i] + R[i];
    if (original !== 0 && Math.abs(mono/original) < 0.3) { monoIssue = true; break; }
  }
  // Si problème mono détecté, réduire le widening automatiquement
  if (monoIssue) {
    const safeWidth = (widthGain - 1) * 0.5 + 1; // diminuer de 50%
    for (let i = 0; i < len; i++) {
      const mid  = (L[i] + R[i]) * 0.5;
      const side = (L[i] - R[i]) * 0.5 * safeWidth;
      outL[i] = mid + side;
      outR[i] = mid - side;
    }
  }
  // Limiter léger post-widening pour éviter les clips
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
  if (peak > 0.98) { const g = 0.95 / peak; for (let i = 0; i < len; i++) { outL[i] *= g; outR[i] *= g; } }
  const src = offline.createBufferSource(); src.buffer = outBuf;
  src.connect(offline.destination); src.start(0);
  // Yield pour iOS avant render
  await new Promise<void>(r => setTimeout(r, 120)); // yield avant render
  return offline.startRendering();
}

// Masterisation professionnelle — 3 étapes séquentielles (VOIX SEULE)
// Étape 1 : Noise gate + saturation douce
// Étape 2 : EQ musical + de-esser + compression multibande
// Étape 3 : Stereo widening + gain makeup + limiteur transparent
// FIX (v7.6.429) : cette chaîne complète (gate, EQ 4 bandes, de-esser,
// saturation, compression multibande, stereo widening) est calibrée pour une
// voix brute et n'est plus appliquée qu'à Mode A (voix seule). Le mix complet
// (Mode B) utilise désormais finalizeFullMix() — la voix a déjà eu ce
// traitement ici, et l'instrumental FLAC est déjà masterisé (Tunee) avant
// d'être séparé de la voix, donc il n'a pas besoin (et ne doit pas recevoir)
// une deuxième couche d'EQ/compression/de-esser/élargissement stéréo.
async function masterAudio(buf: AudioBuffer, s: MasterSettings): Promise<AudioBuffer> {

  // ── ÉTAPE 1 : Traitement canal par canal (noise gate + saturation) ──────────
  const sr  = buf.sampleRate;
  const ch  = Math.min(2, buf.numberOfChannels);
  const len = buf.length;

  // ── ÉTAPE 2 : EQ + Compression (dans un OfflineAudioContext) ────────────────
  // Note: on crée step1Buf dans offline1 pour éviter le cross-context iOS
  const offline1 = new OfflineAudioContext(2, len, sr);
  const step1Buf = offline1.createBuffer(ch, len, sr);
  for (let c = 0; c < ch; c++) {
    let data = new Float32Array(buf.getChannelData(c));
    data = await applyNoiseGate(data, -65, 150, sr);
    const driveAmt = 0.12 + Math.abs(s.lowGain) * 0.01;
    data = await applySaturation(data, driveAmt);
    step1Buf.getChannelData(c).set(data);
  }
  const s1src = offline1.createBufferSource(); s1src.buffer = step1Buf;
  // Yield avant le render pour libérer le thread iOS
  await new Promise<void>(r => setTimeout(r, 120)); // yield 120ms — laisse iOS respirer

  // High-pass 30Hz — sub-bass inutile
  const hpf = offline1.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 30; hpf.Q.value = 0.6;

  // EQ musical — 4 bandes comme un console analogique
  const eq1 = offline1.createBiquadFilter(); eq1.type = 'lowshelf';  eq1.frequency.value = 200;  eq1.gain.value = s.lowGain;
  const eq2 = offline1.createBiquadFilter(); eq2.type = 'peaking';   eq2.frequency.value = 1000; eq2.Q.value = 0.6; eq2.gain.value = s.midGain * 0.3; // médiums bas
  const eq3 = offline1.createBiquadFilter(); eq3.type = 'peaking';   eq3.frequency.value = 3500; eq3.Q.value = 0.8; eq3.gain.value = s.midGain * 0.7; // présence voix
  const eq4 = offline1.createBiquadFilter(); eq4.type = 'highshelf'; eq4.frequency.value = 9000; eq4.gain.value = s.highGain;

  // De-esser dynamique simulé — double compresseur sur les sibilantes
  const deEss  = offline1.createBiquadFilter(); deEss.type = 'peaking'; deEss.frequency.value = 7500; deEss.Q.value = 3.0; deEss.gain.value = -3.0;
  const deEss2 = offline1.createBiquadFilter(); deEss2.type = 'peaking'; deEss2.frequency.value = 9500; deEss2.Q.value = 2.0; deEss2.gain.value = -1.5;

  // Compression douce (glue, avant la séparation en bandes) — ratio bas,
  // attaque lente, garde les transitoires tout en collant légèrement le mix
  const comp1 = offline1.createDynamicsCompressor();
  comp1.threshold.value = s.threshold + 6; // 6dB au-dessus du threshold final
  comp1.ratio.value     = Math.min(s.ratio * 0.5, 3); // ratio très doux
  comp1.attack.value    = s.attack / 1000 * 2; // attaque lente = garde les transitoires
  comp1.release.value   = s.release / 1000; comp1.knee.value = 10;

  s1src.connect(hpf); hpf.connect(eq1); eq1.connect(eq2); eq2.connect(eq3); eq3.connect(eq4);
  eq4.connect(deEss); deEss.connect(deEss2); deEss2.connect(comp1);

  // ── COMPRESSION MULTIBANDE (basse/médium/aigu) ──────────────────────────
  // La vraie différence entre un moteur "single-band" et un mastering
  // pro/LANDR : chaque bande de fréquence reçoit SA PROPRE dynamique au lieu
  // qu'un seul détecteur/compresseur traite tout le spectre pareil (une
  // grosse note de basse ne devrait pas faire "respirer" les aigus, et
  // inversement). Crossovers à 200Hz et 3000Hz, filtres en cascade (~12dB/oct,
  // approximation Linkwitz-Riley simple).
  const lowXover = 200, highXover = 3000;

  const lowLp1 = offline1.createBiquadFilter(); lowLp1.type = 'lowpass'; lowLp1.frequency.value = lowXover; lowLp1.Q.value = 0.707;
  const lowLp2 = offline1.createBiquadFilter(); lowLp2.type = 'lowpass'; lowLp2.frequency.value = lowXover; lowLp2.Q.value = 0.707;
  const lowComp = offline1.createDynamicsCompressor();
  lowComp.threshold.value = s.threshold - 2; lowComp.ratio.value = Math.min(s.ratio * 0.7, 4);
  lowComp.attack.value = 0.030; lowComp.release.value = Math.max(s.release / 1000, 0.25); lowComp.knee.value = 6;

  const midHp1 = offline1.createBiquadFilter(); midHp1.type = 'highpass'; midHp1.frequency.value = lowXover; midHp1.Q.value = 0.707;
  const midHp2 = offline1.createBiquadFilter(); midHp2.type = 'highpass'; midHp2.frequency.value = lowXover; midHp2.Q.value = 0.707;
  const midLp1 = offline1.createBiquadFilter(); midLp1.type = 'lowpass'; midLp1.frequency.value = highXover; midLp1.Q.value = 0.707;
  const midLp2 = offline1.createBiquadFilter(); midLp2.type = 'lowpass'; midLp2.frequency.value = highXover; midLp2.Q.value = 0.707;
  const midComp = offline1.createDynamicsCompressor();
  midComp.threshold.value = s.threshold; midComp.ratio.value = s.ratio;
  midComp.attack.value = s.attack / 1000; midComp.release.value = s.release / 1000; midComp.knee.value = 5;

  const highHp1 = offline1.createBiquadFilter(); highHp1.type = 'highpass'; highHp1.frequency.value = highXover; highHp1.Q.value = 0.707;
  const highHp2 = offline1.createBiquadFilter(); highHp2.type = 'highpass'; highHp2.frequency.value = highXover; highHp2.Q.value = 0.707;
  const highComp = offline1.createDynamicsCompressor();
  highComp.threshold.value = s.threshold + 3; highComp.ratio.value = Math.min(s.ratio * 0.6, 3);
  highComp.attack.value = 0.004; highComp.release.value = Math.max(s.release / 1000 * 0.6, 0.08); highComp.knee.value = 8;

  const bandSum = offline1.createGain(); // point de sommation des 3 bandes

  comp1.connect(lowLp1); lowLp1.connect(lowLp2); lowLp2.connect(lowComp); lowComp.connect(bandSum);
  comp1.connect(midHp1); midHp1.connect(midHp2); midHp2.connect(midLp1); midLp1.connect(midLp2); midLp2.connect(midComp); midComp.connect(bandSum);
  comp1.connect(highHp1); highHp1.connect(highHp2); highHp2.connect(highComp); highComp.connect(bandSum);

  bandSum.connect(offline1.destination);
  s1src.start(0);
  let compressed: AudioBuffer | null = await offline1.startRendering();

  // FIX CRASH MÉMOIRE MASTERISATION (v7.6.410) : mesurer le LUFS AVANT le
  // stereo widening (au lieu d'après) permet de libérer `compressed` (un
  // buffer stéréo pleine longueur) dès que possible, au lieu de le garder
  // vivant pendant tout le rendu du widening. Chaque buffer stéréo pleine
  // chanson pèse plusieurs dizaines de Mo — sur un export qui en enchaîne
  // 5-10 (voix seule + mix complet, x plusieurs étapes chacun), libérer la
  // mémoire dès que possible réduit le pic mémoire cumulé sur iOS.
  const compressedLufs = await analyzeLoudness(compressed);
  await new Promise<void>(r => setTimeout(r, 100)); // laisse le GC respirer

  // ── ÉTAPE 3 : Stereo widening + Gain makeup + Limiteur transparent ──────────
  // Stereo widening léger — plus large sur les presets country et bright
  const widenAmt = s.highGain > 1 ? 1.35 : 1.20;
  const widened  = await stereoWiden(compressed, widenAmt);
  compressed = null; // libère le buffer pré-widening, plus besoin

  // ── ÉTAPE 3 : LUFS targeting + True Peak limiting broadcast-compliant ──────
  return applyLoudnessTargetingAndLimiter(widened, compressedLufs, s);
}

// Étape finale partagée : ajuste le gain vers targetLufs puis applique un
// limiteur True Peak transparent (seuil = ceiling, attaque 0.3ms). Extraite
// de masterAudio() pour pouvoir être réutilisée SEULE par finalizeFullMix()
// (v7.6.429) — cette étape ne fait ni EQ ni compression ni saturation, donc
// elle ne recolore pas un signal déjà masterisé (ex: instrumental Tunee).
async function applyLoudnessTargetingAndLimiter(
  inputBuf: AudioBuffer, inputLufs: number, s: MasterSettings
): Promise<AudioBuffer> {
  // Cap à 20dB max pour éviter un gain excessif sur silence/voix très douce
  let gainDb = Math.min(s.targetLufs - inputLufs, 20);
  await new Promise<void>(r => setTimeout(r, 100)); // laisse le GC respirer avant la boucle

  // Boucle de correction True Peak (max 3 itérations — converge toujours)
  // À chaque itération : appliquer le gain, mesurer True Peak, réajuster si nécessaire
  let finalBuf: AudioBuffer = inputBuf;
  for (let iter = 0; iter < 3; iter++) {
    if (iter > 0) await new Promise<void>(r => setTimeout(r, 100)); // pause GC entre itérations
    const offline2 = new OfflineAudioContext(2, inputBuf.length, inputBuf.sampleRate);
    const s2src    = offline2.createBufferSource(); s2src.buffer = inputBuf;

    // High-pass final 20Hz
    const hpfFinal = offline2.createBiquadFilter();
    hpfFinal.type = 'highpass'; hpfFinal.frequency.value = 20; hpfFinal.Q.value = 0.5;

    // Gain makeup
    const makeup = offline2.createGain();
    makeup.gain.value = Math.pow(10, gainDb / 20);

    // Limiteur True Peak — seuil = ceiling, ratio 20:1, attaque ultra-rapide
    const limiter = offline2.createDynamicsCompressor();
    limiter.threshold.value = s.ceiling - 0.5; // marge 0.5dB pour laisser place au True Peak
    limiter.ratio.value = 20;
    limiter.attack.value = 0.0003; // 0.3ms — capture les transitoires avant qu'ils clippent
    limiter.release.value = 0.06;
    limiter.knee.value = 0.3; // knee très serré

    s2src.connect(hpfFinal); hpfFinal.connect(makeup); makeup.connect(limiter);
    limiter.connect(offline2.destination);
    s2src.start(0);
    finalBuf = await offline2.startRendering();

    // Mesurer True Peak du résultat
    const truePeakDB = await measureTruePeak(finalBuf);
    const truePeakHeadroom = s.ceiling - truePeakDB; // positif = sous le plafond

    // Si True Peak est dans la tolérance ±0.3 dB du ceiling → on arrête
    if (truePeakHeadroom >= 0 && truePeakHeadroom < 0.5) break;

    // Ajuster le gain pour la prochaine itération
    if (truePeakDB > s.ceiling) {
      // True Peak dépasse le ceiling → réduire le gain
      gainDb -= (truePeakDB - s.ceiling) + 0.3;
    } else if (truePeakHeadroom > 1.5) {
      // Trop de marge → on peut monter un peu pour atteindre le targetLufs
      // Mais seulement si on est encore loin du targetLufs
      const finalLufs = await analyzeLoudness(finalBuf);
      if (finalLufs < s.targetLufs - 0.5) gainDb += Math.min(truePeakHeadroom - 0.5, s.targetLufs - finalLufs);
      else break;
    } else {
      break;
    }
  }
  return finalBuf;
}

// ── Mode B (mix complet) : finalisation SANS re-masterisation ──────────────
// FIX "on remasterise l'instrumental de Tunee par-dessus son propre mastering"
// (v7.6.429) : l'instrumental FLAC est déjà masterisé (Tunee) avant d'être
// séparé de la voix — il a déjà sa balance tonale, sa compression et son
// limiteur. Le repasser dans masterAudio() (EQ 4 bandes, de-esser, saturation,
// compression multibande, stereo widening) recolore un signal qui n'en a pas
// besoin, et double-traite les mêmes fréquences qui ont déjà été shape par le
// mastering d'origine (voir aussi le fix v7.6.428 côté voix : même symptôme,
// autre stem). La voix a déjà été masterisée dans son mode dédié (Mode A) et
// mixée ici à son niveau final ; l'instrumental est déjà masterisé.
// Il ne reste donc plus qu'à sécuriser le mix final : ajuster le gain global
// vers le targetLufs et poser un limiteur True Peak transparent pour éviter
// que la somme des deux pistes dépasse le ceiling — rien de plus.
async function finalizeFullMix(buf: AudioBuffer, s: MasterSettings): Promise<AudioBuffer> {
  const inputLufs = await analyzeLoudness(buf);
  return applyLoudnessTargetingAndLimiter(buf, inputLufs, s);
}

// Convertir AudioBuffer → Blob mp4 (iOS natif) — 256 kbps pour la qualité
// FIX "Lecture impossible (NotSupportedError)" + "Erreur export MP3 NotAllowedError"
// (v7.6.422) : cette fonction utilisait MediaRecorder + lecture en temps réel
// pour produire un blob audio/mp4 — une méthode connue pour être capricieuse
// sur iOS Safari (permissions, formats, timing). Le reste du projet utilise
// déjà un encodeur WAV fiable et 100% hors-ligne (aucune lecture en temps
// réel, aucun MediaRecorder, aucun risque de permission) — on le réutilise
// ici au lieu de garder une copie locale périmée.
async function audioBufferToBlob(
  buffer: AudioBuffer,
  onProgress?: (pct: number) => void
): Promise<Blob> {
  return audioBufferToWavBlobReliable(buffer, onProgress);
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
  // FIX "Erreur export MP3 : NotAllowedError" (v7.6.422) : navigator.share()
  // exige d'être appelé quasi-immédiatement après un geste utilisateur direct.
  // Ici, il était appelé APRÈS l'encodage MP3 (plusieurs secondes de calcul via
  // lamejs) — Safari iOS considère alors que le "geste utilisateur" a expiré
  // et bloque l'appel avec NotAllowedError, peu importe que le bouton ait bien
  // été cliqué au départ. On utilise directement le téléchargement, qui lui
  // n'a pas cette contrainte de délai et fonctionne de façon fiable.
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
  { id: 'country',  label: '🤠 Country',       keys: ['cash_country', 'country', 'country_live', 'country_bright'] },
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
    description: '-14 LUFS · Norme officielle YouTube 2026',
    settings: { lowGain: 2.0, midGain: 0.0, highGain: 1.5, threshold: -16, ratio: 4, attack: 8, release: 120, ceiling: -1.0, targetLufs: -14 },
  },
  podcast: {
    label: 'Podcast / Voix', emoji: '🎙',
    description: '-16 LUFS · Clarté maximale voix',
    settings: { lowGain: -1.0, midGain: 3.0, highGain: 1.5, threshold: -20, ratio: 3, attack: 15, release: 200, ceiling: -1.5, targetLufs: -16 },
  },
  // ── Country ──
  cash_country: {
    label: 'Cash Country', emoji: '🖤🤠',
    description: 'Baryton grave - grain analogique Johnny Cash / Elvis',
    settings: { lowGain: 1.5, midGain: 1.5, highGain: -0.5, threshold: -22, ratio: 3, attack: 25, release: 300, ceiling: -1.5, targetLufs: -14 },
  },
  country: {
    label: 'Country Warm', emoji: '🤠',
    description: 'Son chaleureux, graves riches',
    settings: { lowGain: 2.0, midGain: 0.5, highGain: 0.5, threshold: -20, ratio: 3.5, attack: 15, release: 200, ceiling: -1.5, targetLufs: -14 },
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
  vocalBlob, sendBusBlob = null, leadOnlyBlob = null, instBlob, instOffsetMs = 0, songTitle, songId, onBack, onStemReady, isOnline,
}: MasteringProps) {
  // FIX DIAGNOSTIC (v7.6.415) : trace synchrone à l'instant précis où React
  // commence à exécuter le rendu de ce composant — avant tout hook, avant tout
  // effet. Si cette ligne n'apparaît jamais dans le log, le crash se produit
  // AVANT même l'entrée dans ce composant (donc dans StudioMobile.tsx, le
  // DebugPanel, ou le ScreenErrorBoundary lui-même) — pas ici.
  try { (window as any).__breadcrumb?.(`🎬 MasteringEngine render démarré — vocalBlob=${vocalBlob ? vocalBlob.size + 'B/' + vocalBlob.type : 'NULL'}`); } catch {}

  const [preset, setPreset]               = useState('cash_country');
  const [activeCategory, setActiveCategory] = useState('country');
  const [settings, setSettings]           = useState<MasterSettings>(PRESETS.cash_country.settings);
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
    // FIX CRASH SILENCIEUX "Script error." (v7.6.414) : iOS Safari limite le
    // nombre de contextes audio simultanés (~4-6). Si un contexte de preview
    // (Mixer/TrackCard) est resté ouvert par erreur, il grignote cette limite
    // et peut faire planter silencieusement la création du contexte ici même
    // (aucune trace JS exploitable — exactement le symptôme observé). On
    // ferme donc proactivement tout contexte de preview connu avant de
    // commencer, pour libérer un maximum de marge.
    try { (window as any).__previewCtx?.close(); (window as any).__previewCtx = null; } catch {}
    decodeBlob(vocalBlob)
      .then(async buf => setInputLufs(Math.round((await analyzeLoudness(buf)) * 10) / 10))
      .catch((e: any) => { try { (window as any).__breadcrumb?.(`⚠️ decodeBlob/analyzeLoudness (montage) a échoué: ${e?.message}`); } catch {} });
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
      let vocalRaw: AudioBuffer | null = await decodeBlob(vocalBlob);

      // 2. Masteriser la voix seule (Mode A)
      setProgressLabel('Masterisation voix...'); setProgress(30);
      const vocalM = await masterAudio(vocalRaw, settings);
      // FIX "voix horrible" (v7.6.428) : vocalRaw n'est PLUS libéré ici. Avant
      // ce correctif, le Mode B (mix complet) réutilisait vocalM — la voix
      // DÉJÀ masterisée (EQ + de-esser + saturation + compression multibande +
      // limiteur True Peak) — comme source pour le mixage avec l'instrumental,
      // puis renvoyait le résultat dans masterAudio() une SECONDE fois. La voix
      // se retrouvait donc traitée deux fois par toute la chaîne : EQ doublé
      // (graves/presence/aigus additionnés deux fois), de-esser doublé (~-9dB
      // cumulés à 7.5-9.5kHz → voix étouffée), compression multibande doublée,
      // et surtout limiteur True Peak doublé (la voix déjà collée au ceiling
      // se refait limiter par-dessus → écrasement des transitoires, dureté).
      // L'instrumental n'était lui masterisé qu'une fois, d'où le déséquilibre
      // audible (voix "horrible", mix étouffé/bosselé dans les graves).
      // Le fix : on garde vocalRaw (non masterisé) pour le mixage du Mode B,
      // et seul le mix complet passe par masterAudio() — une seule fois.
      setVocalMastered(vocalM);
      setOutputVocalLufs(Math.round((await analyzeLoudness(vocalM)) * 10) / 10);

      // Encodage voix — progression animée en temps réel (durée réelle)
      if (vocalUrlRef.current) URL.revokeObjectURL(vocalUrlRef.current);
      const encDurVocal = Math.round(vocalM.duration);
      setProgressLabel(`Encodage voix… (~${encDurVocal}s)`);
      let vBlob = await audioBufferToBlob(vocalM, (pct) => {
        // Plage 35→53% pendant l'encodage voix
        setProgress(35 + Math.round(pct * 0.18));
        if (pct < 100) {
          const remaining = Math.max(0, Math.round(encDurVocal * (1 - pct / 100)));
          setProgressLabel(`Encodage voix… (${remaining}s)`);
        }
      });
      // FIX "repartir de zéro, trop agressif" (v7.6.440) : chaîne complète
      // resserrée suite au 3e retour Tunee. Ordre imposé : compresseur léger
      // → EQ → slapback subtil → volume. Aucun autre effet sur le lead.
      if (leadOnlyBlob) {
        vBlob = await studioService.applySlapbackDelay(vBlob, leadOnlyBlob, 70, 0.11);
      }
      // FIX "reverb trop prononcée" (v7.6.435) : même principe que pour le
      // Mode B — la reverb du Bus partagé s'applique APRÈS masterAudio()
      // (donc sur vocalM déjà traitée), jamais avant, pour l'export "voix
      // seule" aussi. (Reverb harmonies/double — non concernée par la
      // demande "aucun effet supplémentaire" de Tunee, qui porte sur la
      // chaîne LEAD, voir commentaire détaillé au Mode B plus bas.)
      if (sendBusBlob) {
        vBlob = await studioService.applySharedReverbBusChunked(vBlob, sendBusBlob, 0.12);
      }
      if (sendBusBlob || leadOnlyBlob) {
        // Compresseur très léger — ne travaille que sur les pics (threshold
        // haut), garde la dynamique naturelle.
        vBlob = await studioService.applyGentleCompressor(vBlob, 2.0, 20, 80, -12);
        // EQ 4 étages : creux 2-3kHz (nasillard) + creux 4-6kHz (métallique)
        // + boost 200-400Hz (corps) + shelf 8kHz (adoucir l'aigu).
        vBlob = await studioService.applyPeakingEQ(vBlob, 2500, -2.0, 0.7);
        vBlob = await studioService.applyPeakingEQ(vBlob, 5000, -1.5, 1.5);
        vBlob = await studioService.applyPeakingEQ(vBlob, 300, 1.5, 0.7);
        vBlob = await studioService.applyHighShelf(vBlob, 8000, -0.5);
      }
      vocalUrlRef.current = URL.createObjectURL(vBlob);
      try { (window as any).__breadcrumb?.(`💿 Voix masterisée encodée : ${vBlob.size}B, type=${vBlob.type}`); } catch {}
      setProgress(55);

      // 3. Si instrumental disponible → mixer + masteriser (Mode B)
      if (instBlob) {
        setProgressLabel("Chargement de l'instrumental..."); setProgress(60);
        let instRaw: AudioBuffer | null = await decodeBlob(instBlob);

        // FIX "reverb trop prononcée / instrumental écrasé" (v7.6.435) :
        // la reverb du Bus partagé est appliquée ICI, juste avant le mixage
        // avec l'instrumental — jamais avant, au niveau du Mixage (voir
        // commentaire sur sendBusBlob plus haut). Wet amount aussi réduit
        // (0.22→0.12) : à 0.22 la reverb remplissait les silences entre les
        // phrases avec une énergie continue qui, une fois vocalRaw
        // peak-normalisé contre l'instrumental dans mixVocalWithInst,
        // gonflait la présence globale de la voix (peak identique mais RMS
        // bien plus haut à cause de la queue continue) — l'instrumental
        // semblait "faible" alors que son propre traitement n'avait pas
        // changé, et les harmonies/double devenaient inaudibles, noyés sous
        // la reverb désormais bien plus dense que le reste du groupe voix.
        let vocalForMix: AudioBuffer = vocalRaw!;
        // FIX "repartir de zéro, trop agressif" (v7.6.440) — 3e retour Tunee :
        // chaîne resserrée dans l'ordre imposé : compresseur léger → EQ →
        // slapback subtil → volume, aucun autre effet sur le lead. La reverb
        // courte du bus (harmonies/double, section 4 du doc envoyé à Tunee)
        // et le glue final (section 7) ne sont PAS retirés : ils répondent à
        // un besoin différent (cohésion des harmonies, "même espace" du mix
        // complet) que Tunee a lui-même demandé précédemment et ne conteste
        // pas ici — sa demande "aucun effet supplémentaire" porte sur la
        // chaîne LEAD spécifiquement.
        if (leadOnlyBlob) {
          setProgressLabel('Bus partagé — slapback delay...'); setProgress(62);
          await new Promise<void>(r => setTimeout(r, 100));
          const vocalRawBlobForSlap = await audioBufferToBlob(vocalForMix);
          const vocalRawWithSlapBlob = await studioService.applySlapbackDelay(vocalRawBlobForSlap, leadOnlyBlob, 70, 0.11);
          vocalForMix = await decodeBlob(vocalRawWithSlapBlob);
        }
        if (sendBusBlob) {
          setProgressLabel('Bus partagé — réverbération courte...'); setProgress(64);
          await new Promise<void>(r => setTimeout(r, 100));
          const vocalRawBlob = await audioBufferToBlob(vocalForMix);
          // FIX mémoire (v7.6.442) : version découpée (chunks 40s) — voir
          // applySharedReverbBusChunked, même principe que pour le glue
          // final plus bas.
          const vocalRawWithReverbBlob = await studioService.applySharedReverbBusChunked(vocalRawBlob, sendBusBlob, 0.12);
          vocalForMix = await decodeBlob(vocalRawWithReverbBlob);
        }
        if (sendBusBlob || leadOnlyBlob) {
          setProgressLabel('Bus partagé — compresseur léger...'); setProgress(65);
          await new Promise<void>(r => setTimeout(r, 100));
          let vBlobTone = await audioBufferToBlob(vocalForMix);
          // Compresseur très léger — seuil haut (ne touche que les pics),
          // garde la dynamique naturelle ("si elle sonne plate, c'est trop").
          vBlobTone = await studioService.applyGentleCompressor(vBlobTone, 2.0, 20, 80, -12);
          await new Promise<void>(r => setTimeout(r, 60)); // FIX mémoire (v7.6.441) : pause GC entre chaque passe EQ
          setProgressLabel('Bus partagé — EQ voix...'); setProgress(66);
          // Creux 2-3kHz (nasillard) + creux 4-6kHz (métallique) +
          // boost 200-400Hz (corps) + shelf 8kHz (adoucir l'aigu) —
          // objectif voix chaude/naturelle plutôt que brillante/agressive.
          vBlobTone = await studioService.applyPeakingEQ(vBlobTone, 2500, -2.0, 0.7);
          await new Promise<void>(r => setTimeout(r, 60));
          vBlobTone = await studioService.applyPeakingEQ(vBlobTone, 5000, -1.5, 1.5);
          await new Promise<void>(r => setTimeout(r, 60));
          vBlobTone = await studioService.applyPeakingEQ(vBlobTone, 300, 1.5, 0.7);
          await new Promise<void>(r => setTimeout(r, 60));
          vBlobTone = await studioService.applyHighShelf(vBlobTone, 8000, -0.5);
          vocalForMix = await decodeBlob(vBlobTone);
        }

        setProgressLabel('Mixage vocal + instrumental...'); setProgress(70);
        // FIX "voix horrible" (v7.6.428) : mixer avec vocalRaw (voix NON
        // masterisée), pas vocalM — sinon la voix est masterisée deux fois
        // (voir commentaire plus haut). mixVocalWithInst normalise chaque
        // signal indépendamment à -1dBFS avant mixage, donc utiliser la voix
        // brute ici ne change rien au niveau, seulement à la qualité.
        // FIX (v7.6.439→440) : +5dB (retour #2) puis +2.5dB de plus (retour
        // #3 : "encore -2/-3dB de voix") = +7.5dB net sur instGainDb en
        // style Bus partagé. Un seul levier existe dans mixVocalWithInst
        // (le ratio inst/voix) — chaque demande "voix plus basse" ou
        // "instrumental plus fort" passe forcément par ici.
        const effectiveInstGainDb = (sendBusBlob || leadOnlyBlob) ? instGainDb + 7.5 : instGainDb;
        let fullRaw: AudioBuffer | null = await mixVocalWithInst(vocalForMix, instRaw, effectiveInstGainDb, instOffsetMs);
        instRaw = null; // FIX mémoire : relâché dès que possible
        vocalRaw = null; // FIX mémoire : plus besoin après le mixage, relâché ici

        setProgressLabel('Finalisation du mix complet...'); setProgress(80);
        await new Promise<void>(r => setTimeout(r, 150)); // pause GC avant la 2e passe lourde
        // FIX "on remasterise l'instrumental déjà masterisé" (v7.6.429) :
        // finalizeFullMix() ne fait QUE l'ajustement de loudness + le
        // limiteur True Peak de sécurité — pas d'EQ/compression/de-esser/
        // widening qui recolorerait l'instrumental Tunee déjà masterisé (voir
        // commentaire détaillé au-dessus de la fonction).
        let fullM = await finalizeFullMix(fullRaw, settings);
        // FIX "crash mémoire répétés à la masterisation" (v7.6.441→442) :
        // le "glue final" (v7.6.439, reverb room 10% sur le mix COMPLET
        // voix+instrumental) avait été retiré en 441 après des crashs OOM —
        // c'est le plus gros buffer du pipeline (~4min stéréo 48kHz) et
        // l'ancienne fonction en faisait une passe unique non découpée.
        // Réintroduit ici avec applySharedReverbBusChunked() : traitement
        // par blocs de 40s avec chevauchement/crossfade de 1.5s (la queue de
        // reverb, ~700-800ms, tient largement dedans — pas de clic à la
        // jointure), et libération mémoire entre chaque bloc. Le "dry" et le
        // "send" sont le MÊME blob (auto-alimenté) — la fonction ne le
        // décode qu'une fois dans ce cas, pas deux.
        setProgressLabel('Bus partagé — glue final...'); setProgress(82);
        await new Promise<void>(r => setTimeout(r, 150));
        const fullMBlobForGlue = await audioBufferToBlob(fullM);
        const fullMWithGlueBlob = await studioService.applySharedReverbBusChunked(fullMBlobForGlue, fullMBlobForGlue, 0.10);
        fullM = await decodeBlob(fullMWithGlueBlob);
        fullRaw = null; // FIX mémoire : relâché dès que possible, avant l'encodage
        setFullMastered(fullM);
        setOutputFullLufs(Math.round((await analyzeLoudness(fullM)) * 10) / 10);

        // Encodage mix complet — progression animée
        if (fullUrlRef.current) URL.revokeObjectURL(fullUrlRef.current);
        const encDurFull = Math.round(fullM.duration);
        setProgressLabel(`Encodage mix… (~${encDurFull}s)`);
        const fBlob = await audioBufferToBlob(fullM, (pct) => {
          // Plage 82→98% pendant l'encodage mix
          setProgress(82 + Math.round(pct * 0.16));
          if (pct < 100) {
            const remaining = Math.max(0, Math.round(encDurFull * (1 - pct / 100)));
            setProgressLabel(`Encodage mix… (${remaining}s)`);
          }
        });
        fullUrlRef.current = URL.createObjectURL(fBlob);
      }

      setProgressLabel('Terminé ✓'); setProgress(100);

    } catch (e: any) {
      const isQuota = e?.name === 'QuotaExceededError'
        || (e?.message && e.message.toLowerCase().includes('quota'));
      if (!isQuota) alert('Erreur masterisation : ' + e.message);
      else console.warn('[Mastering] Quota dépassé:', e.message);
    } finally {
      setIsMastering(false); setProgressLabel('');
    }
  };

  // ── LECTURE ────────────────────────────────────────────────────────────────

  const playAudio = (type: 'vocal' | 'full') => {
    if (!playRef.current) return;
    if (playing === type) { playRef.current.pause(); setPlaying(null); return; }
    const url = type === 'vocal' ? vocalUrlRef.current : fullUrlRef.current;
    if (!url) { try { (window as any).__breadcrumb?.(`⛔ playAudio('${type}') : URL vide, rien à jouer`); } catch {} return; }
    playRef.current.src = url;
    playRef.current.load();
    playRef.current.play().then(() => {
      try { (window as any).__breadcrumb?.(`▶️ playAudio('${type}') OK — url=${url.slice(0,40)}`); } catch {}
    }).catch((e: any) => {
      // FIX "bouton play ne joue rien" (v7.6.421) : cette erreur était avalée
      // silencieusement — impossible de savoir pourquoi la lecture échouait.
      try { (window as any).__breadcrumb?.(`⛔ playAudio('${type}') ÉCHEC: ${e?.name}: ${e?.message}`); } catch {}
      console.error('[MasteringEngine] Lecture échouée:', e);
      alert(`Lecture impossible (${e?.name || 'erreur'}). Le fichier a peut-être été mal encodé — essaie de refaire la masterisation.`);
    });
    setPlaying(type);
    playRef.current.onended = () => setPlaying(null);
    playRef.current.onerror = () => {
      try { (window as any).__breadcrumb?.(`⛔ <audio> onerror pendant lecture '${type}': code=${playRef.current?.error?.code}`); } catch {}
      setPlaying(null);
    };
  };

  // ── MODE A : Envoyer au Mac ───────────────────────────────────────────────

  const sendToMac = async () => {
    if (!vocalMastered || !isOnline) return;
    setSendingToMac(true);
    try {
      // Réutiliser le blob déjà encodé (vocalUrlRef) si disponible — évite un double encodage
      let blob: Blob;
      if (vocalUrlRef.current) {
        try {
          blob = await fetch(vocalUrlRef.current).then(r => r.blob());
          if (blob.size < 1000) throw new Error('blob vide');
        } catch {
          blob = await audioBufferToBlob(vocalMastered);
        }
      } else {
        blob = await audioBufferToBlob(vocalMastered);
      }
      const safeTitle = songTitle.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
      const fileName  = `VOCAL_${safeTitle}_${Date.now()}.wav`;

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
      if (!e?.message?.toLowerCase().includes('quota')) alert('Erreur : ' + e.message);
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
      if ((e as any).name !== 'AbortError' && !e?.message?.toLowerCase().includes('quota')) alert('Erreur export MP3 : ' + e.message);
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
      const fileName  = `${safeTitle}_MASTER.wav`;

      const mp4Blob = await audioBufferToBlob(source);
      await shareFileIOS(mp4Blob, fileName, `${songTitle} — Master MP4`);
      setExportedMp4(true);
    } catch (e: any) {
      if ((e as any).name !== 'AbortError' && !e?.message?.toLowerCase().includes('quota')) alert('Erreur export MP4 : ' + e.message);
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
      if ((e as any).name !== 'AbortError' && !e?.message?.toLowerCase().includes('quota')) alert('Erreur export WAV : ' + e.message);
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
      if (e.name !== 'AbortError' && !e?.message?.toLowerCase().includes('quota')) alert('Erreur export vocal : ' + e.message);
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
      if (e.name !== 'AbortError' && !e?.message?.toLowerCase().includes('quota')) alert('Erreur export instrumental : ' + e.message);
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
      if (e.name !== 'AbortError' && !e?.message?.toLowerCase().includes('quota')) alert('Erreur export stems : ' + e.message);
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
          <div className="space-y-1.5">
            <div className="flex justify-between items-center">
              <span className="text-[10px] text-zinc-500 font-black uppercase tracking-widest truncate pr-2">
                {progressLabel || 'En cours...'}
              </span>
              <span className="text-[11px] font-black text-red-500 shrink-0">{progress}%</span>
            </div>
            <div className="h-2 bg-zinc-900 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  progressLabel.includes('Encodage') ? 'bg-gradient-to-r from-red-600 to-orange-500' : 'bg-red-600'
                }`}
                style={{ width: `${progress}%` }}
              />
            </div>
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
                    ? <><Loader2 size={14} className="animate-spin"/> Encodage &amp; transfert… (~{Math.round((vocalMastered?.duration||0))}s)</>
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
                      ? <><Loader2 size={13} className="animate-spin"/> Encodage MP4… (~{Math.round(((fullMastered||vocalMastered)?.duration||0))}s)</>
                      : exportedMp4
                      ? <><CheckCircle2 size={13}/> MP4 partagé !</>
                      : <><Share2 size={13}/> WAV (AirDrop / iCloud)</>
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
