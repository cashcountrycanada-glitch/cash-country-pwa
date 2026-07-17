// harmony-worker.js v15 — Rubber Band WASM via main thread transfer
// Le WASM est compilé dans le main thread et transféré ici comme WebAssembly.Module
// Aucun base64 stocké dans le worker — économise ~350KB de mémoire iOS
// Pipeline : Rubber Band pitch shift → AGC → Saturation → Jitter → Timbre → Reverb → Chorus → Pan

// ── Générateur pseudo-aléatoire déterministe (Mulberry32) ────────────────────
// Utilisé par applyOrganicJitter, applyPhraseVariation, applyChorusGainPan
function makePRNG(seed) {
  let s = seed >>> 0;
  return function() {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Rubber Band — état global du worker ──────────────────────────────────────
let rbApi = null;
let rbReady = false;

// Reçoit le module WASM pré-compilé + le code UMD du main thread
// Appelé avant tout traitement audio
async function initRubberBandFromModule(wasmModule, umdCode) {
  if (rbReady) return; // déjà initialisé
  try {
    // Exécuter le UMD inline — assigne à self.rubberband
    const fakeModule = { exports: {} };
    (new Function('module', 'exports', umdCode))(fakeModule, fakeModule.exports);
    const rb = fakeModule.exports?.RubberBandInterface
      ? fakeModule.exports
      : (self.rubberband || {});
    const RBI = rb.RubberBandInterface;
    if (!RBI) throw new Error('RubberBandInterface introuvable');
    
    // Instancier le WASM depuis le module pré-compilé
    rbApi = await RBI.initialize(wasmModule);
    rbReady = true;
    console.log('[HarmonyWorker] Rubber Band initialisé depuis module pré-compilé ✅');
  } catch(e) {
    console.error('[HarmonyWorker] init failed:', e.message);
    rbReady = false;
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════
// RUBBER BAND — Pitch shift offline (FormantPreserved + HighQuality)
// FIX v16 : cette fonction manquait — chaque appel plantait avec
// "rbPitchShift is not defined", forçant la réinitialisation complète
// du worker + recompilation WASM à CHAQUE couche d'harmonie. C'était
// la cause du gel "de plus en plus rapide".
// ═══════════════════════════════════════════════════════════════
function rbPitchShift(mono, semitones, sampleRate) {
  if (!rbReady || !rbApi) throw new Error('Rubber Band non initialisé');
  if (!semitones) return mono;

  const pitchScale = Math.pow(2, semitones / 12);
  const maxBlock = 4096;

  // ProcessOffline=0 | FormantPreserved=16777216 | PitchHighQuality=33554432 | EngineFiner=536870912
  //   | TransientsSmooth=512 | DetectorSoft=2048 | SmoothingOn=8388608 | WindowLong=2097152
  //
  // FIX "ça grince au début d'une phrase puis devient clair" : les réglages
  // précédents utilisaient les valeurs PAR DÉFAUT de Rubber Band pour la
  // détection des transitoires (TransientsCrisp + DetectorCompound), pensées
  // pour du contenu percussif/rythmique. Sur du chant soutenu, un souffle ou
  // une consonne en début de mot peut se faire détecter à tort comme un
  // "transitoire" façon coup de batterie — ce qui force l'algo à réinitialiser
  // sa phase d'analyse à cet endroit précis, produisant une brève salve de
  // grain avant de se stabiliser. On passe à DetectorSoft + TransientsSmooth
  // (détection pensée pour du matériel non-percussif) + SmoothingOn (lissage
  // spectral supplémentaire, conçu spécifiquement pour réduire ce type
  // d'artefact) + WindowLong (meilleure résolution fréquentielle pour du
  // contenu soutenu comme la voix, au prix d'un peu moins de précision sur
  // les vrais transitoires — qu'on ne cherche pas à préserver ici).
  const options = 0 | 16777216 | 33554432 | 536870912 | 512 | 2048 | 8388608 | 2097152;

  let handle;
  try {
    handle = rbApi.rubberband_new(sampleRate, 1, options, 1.0, pitchScale);
  } catch(e) { throw new Error(`rubberband_new a échoué: ${e.message}`); }
  if (handle === undefined || handle === null) throw new Error('rubberband_new a retourné null');

  let inPtr, inPtrsBuf, outPtr, outPtrsBuf;

  try {
    rbApi.rubberband_set_pitch_scale(handle, pitchScale);
    rbApi.rubberband_set_max_process_size(handle, maxBlock);
    rbApi.rubberband_set_expected_input_duration(handle, mono.length);

    inPtr     = rbApi.malloc(maxBlock * 4);
    inPtrsBuf = rbApi.malloc(4);
    rbApi.memWritePtr(inPtrsBuf, inPtr);
    outPtr    = rbApi.malloc(maxBlock * 4);
    outPtrsBuf = rbApi.malloc(4);
    rbApi.memWritePtr(outPtrsBuf, outPtr);

    if (!inPtr || !outPtr) throw new Error(`malloc échoué (inPtr=${inPtr} outPtr=${outPtr})`);

    const zeroPad = new Float32Array(maxBlock);

    // ── PHASE 1 : study ──────────────────────────────────────────────────────
    let pos = 0;
    let studyCount = 0;
    while (pos < mono.length) {
      const chunkLen = Math.min(maxBlock, mono.length - pos);
      zeroPad.fill(0);
      zeroPad.set(mono.subarray(pos, pos + chunkLen));
      try { rbApi.memWrite(inPtr, zeroPad); } catch(e) { throw new Error(`memWrite study[${studyCount}] échoué: ${e.message}`); }
      const isFinal = (pos + chunkLen >= mono.length) ? 1 : 0;
      try { rbApi.rubberband_study(handle, inPtrsBuf, chunkLen, isFinal); } catch(e) { throw new Error(`rubberband_study[${studyCount}] échoué: ${e.message}`); }
      pos += chunkLen;
      studyCount++;
    }

    // ── ÉTAPE CRITIQUE : calculate_stretch() obligatoire entre study et process ──
    try { rbApi.rubberband_calculate_stretch(handle); } catch(e) { throw new Error(`calculate_stretch échoué: ${e.message}`); }

    // ── PHASE 2 : process + retrieve ─────────────────────────────────────────
    const outChunks = [];
    pos = 0;
    let processCount = 0;

    while (pos < mono.length) {
      let need;
      try { need = rbApi.rubberband_get_samples_required(handle); } catch(e) { throw new Error(`get_samples_required[${processCount}] échoué: ${e.message}`); }
      if (need <= 0) need = maxBlock;
      need = Math.min(need, maxBlock);

      const chunkLen = Math.min(need, mono.length - pos);
      zeroPad.fill(0);
      zeroPad.set(mono.subarray(pos, pos + chunkLen));
      try { rbApi.memWrite(inPtr, zeroPad); } catch(e) { throw new Error(`memWrite process[${processCount}] échoué: ${e.message}`); }
      const isFinal = (pos + chunkLen >= mono.length) ? 1 : 0;
      try { rbApi.rubberband_process(handle, inPtrsBuf, chunkLen, isFinal); } catch(e) { throw new Error(`rubberband_process[${processCount}] échoué: ${e.message}`); }
      pos += chunkLen;
      processCount++;

      let avail;
      try { avail = rbApi.rubberband_available(handle); } catch(e) { throw new Error(`rubberband_available[${processCount}] échoué: ${e.message}`); }
      while (avail > 0) {
        const toRead = Math.min(avail, maxBlock);
        let got;
        try { got = rbApi.rubberband_retrieve(handle, outPtrsBuf, toRead); } catch(e) { throw new Error(`rubberband_retrieve échoué: ${e.message}`); }
        if (got <= 0) break;
        let chunk;
        try { chunk = rbApi.memReadF32(outPtr, got).slice(); } catch(e) { throw new Error(`memReadF32(${got}) échoué: ${e.message}`); }
        outChunks.push(chunk);
        try { avail = rbApi.rubberband_available(handle); } catch { break; }
      }
    }

    // ── Vidage final ──────────────────────────────────────────────────────────
    let avail = 0;
    try { avail = rbApi.rubberband_available(handle); } catch {}
    let guard = 0;
    while (avail > 0 && guard++ < 512) {
      const toRead = Math.min(avail, maxBlock);
      let got = 0;
      try { got = rbApi.rubberband_retrieve(handle, outPtrsBuf, toRead); } catch { break; }
      if (got <= 0) break;
      try { outChunks.push(rbApi.memReadF32(outPtr, got).slice()); } catch { break; }
      try { avail = rbApi.rubberband_available(handle); } catch { break; }
    }

    const totalLen = outChunks.reduce((s, c) => s + c.length, 0);
    if (totalLen === 0) return mono;
    const result = new Float32Array(totalLen);
    let off = 0;
    for (const c of outChunks) { result.set(c, off); off += c.length; }
    return result;

  } finally {
    try { if (inPtr)     rbApi.free(inPtr);     } catch {}
    try { if (inPtrsBuf) rbApi.free(inPtrsBuf); } catch {}
    try { if (outPtr)    rbApi.free(outPtr);    } catch {}
    try { if (outPtrsBuf) rbApi.free(outPtrsBuf); } catch {}
    try { rbApi.rubberband_delete(handle); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════
// FIX OOM : in-place (zéro allocation)
function applyAGC(signal, reference) {
  let refRMS=0,sigRMS=0;
  for(let i=0;i<reference.length;i++) refRMS+=reference[i]*reference[i];
  for(let i=0;i<signal.length;i++) sigRMS+=signal[i]*signal[i];
  refRMS=Math.sqrt(refRMS/reference.length);
  sigRMS=Math.sqrt(sigRMS/signal.length);
  if(sigRMS<1e-9) return signal;
  const gain=Math.max(0.3,Math.min(2.5,refRMS/sigRMS));
  for(let i=0;i<signal.length;i++) signal[i]*=gain;
  return signal; // in-place
}

// ═══════════════════════════════════════════════════════════════
// GATE DE SOUFFLE — atténue le bruit résiduel ENTRE les phrases
// ═══════════════════════════════════════════════════════════════
// Même avec le plafonnement du pré-gain, une prise brute très faible garde un
// souffle/bruit de fond qui reste audible une fois l'harmonie remise au bon
// niveau. Ce n'est PAS un défaut de Rubber Band lui-même (moteur pro, formant
// preservation + high quality) — c'est le plancher de bruit d'origine qui
// ressort par bouts de phrase (surtout entre les mots/respirations, là où le
// niveau original était déjà très faible/bruité).
// On suit une enveloppe (attaque rapide, release lente pour ne pas couper les
// fins de mots) et on atténue doucement (jamais à zéro, pour rester naturel)
// tout ce qui est sous ~-38dB relatif au pic de CETTE harmonie — donc ça
// s'adapte automatiquement, aucun réglage manuel nécessaire.
// FIX "parfait pour radio/YouTube" : la recherche confirme que rester dans
// ±3 demi-tons est la zone où les artefacts de pitch-shift restent quasi
// inaudibles, même avec les meilleurs algorithmes (préservation de formants
// incluse). Au-delà (nos harmonies vont jusqu'à +7ST/-5ST), un peu plus de
// grain est structurellement inévitable. On compense en rendant le gate de
// souffle plus mordant à mesure que l'écart de pitch grandit au-delà de
// cette zone sûre — sans y toucher pour les écarts modestes (+4ST/-3ST) qui
// n'en ont pas besoin.
function applyBreathGate(signal, sampleRate, semitones = 0) {
  let peak = 0;
  for (let i = 0; i < signal.length; i++) peak = Math.max(peak, Math.abs(signal[i]));
  if (peak < 1e-6) return signal;
  const extraShift = Math.max(0, Math.abs(semitones) - 3); // demi-tons au-delà de la zone sûre
  // Seuil plus haut (gate plus agressif) et plancher plus bas pour les gros écarts
  const thresholdDb = -38 + Math.min(extraShift * 1.5, 9); // jusqu'à -29dB pour les écarts extrêmes
  const threshold = peak * Math.pow(10, thresholdDb / 20);
  const attackCoef  = Math.exp(-1 / (0.003 * sampleRate)); // 3ms
  const releaseCoef = Math.exp(-1 / (0.120 * sampleRate)); // 120ms — ne coupe pas les fins de mots
  let env = 0;
  const floorGain = Math.max(0.15, 0.25 - extraShift * 0.02); // un peu plus mordant sur les gros écarts
  for (let i = 0; i < signal.length; i++) {
    const a = Math.abs(signal[i]);
    env = a > env ? attackCoef * env + (1 - attackCoef) * a
                  : releaseCoef * env + (1 - releaseCoef) * a;
    if (env < threshold) {
      const ratio = env / threshold; // 0..1, knee doux
      const g = floorGain + (1 - floorGain) * ratio;
      signal[i] *= g;
    }
  }
  return signal; // in-place
}

// FIX OOM : in-place (zéro allocation)
function applySoftSaturation(signal, amount) {
  if(amount<=0) return signal;
  const k=2*amount/(1-amount);
  for(let i=0;i<signal.length;i++){
    const x=signal[i]||0;
    signal[i]=(1+k)*x/(1+k*Math.abs(x));
  }
  return signal; // in-place
}

// ═══════════════════════════════════════════════════════════════
// JITTER NATUREL — bruit rose déterministe
// ═══════════════════════════════════════════════════════════════
// FIX OOM : calcul in-place, zéro allocation supplémentaire
// Avant : 3x Float32Array (result + noiseD + noiseF) = ~138 MB pour vocal 4min
function applyOrganicJitter(signal, sr, seed) {
  const rand=makePRNG(seed>>>0);
  const len=signal.length;
  const dt=1/sr;
  const alphaD=dt/(dt+1/(2*Math.PI*8));
  const alphaF=dt/(dt+1/(2*Math.PI*12));
  let lpD=0,lpF=0;
  // Pré-calculer les échantillons source avant modification in-place
  // On doit lire l'original donc on copie d'abord — mais utilisons un seul buffer
  const src=signal.slice(); // 1 copie inévitable pour lire l'original
  let srcPos=0; // FIX : position ACCUMULÉE, pas recalculée depuis i à chaque échantillon
  for(let i=0;i<len;i++){
    const noiseD=rand()*2-1;
    const noiseF=rand()*2-1;
    lpD=lpD+alphaD*(noiseD-lpD);
    const driftCents=lpD*8.0;
    lpF=lpF+alphaF*(noiseF-lpF);
    const flutter=1.0+lpF*0.015;
    const ratio=Math.pow(2,driftCents/1200);
    // FIX qualité : interpolation cubique (Hermite) au lieu de linéaire —
    // moins de distorsion HF, important car ce signal repasse encore par un
    // 2e resampling juste après (variation de phrase).
    const s1=Math.max(0,Math.min(len-1,Math.floor(srcPos)|0));
    const fr=srcPos-Math.floor(srcPos);
    const s0=Math.max(0,s1-1), s2=Math.min(len-1,s1+1), s3=Math.min(len-1,s1+2);
    const y0=src[s0]||0, y1=src[s1]||0, y2=src[s2]||0, y3=src[s3]||0;
    const a0=y3-y2-y0+y1, a1=y0-y1-a0, a2=y2-y0, a3=y1;
    const pitched = a0*fr*fr*fr + a1*fr*fr + a2*fr + a3;
    signal[i]=pitched*flutter;
    srcPos+=ratio;
    if (srcPos > len-1) srcPos = len-1; // sécurité fin de buffer
  }
  return signal; // in-place
}

// ═══════════════════════════════════════════════════════════════
// PHRASE VARIATION — micro-modulation de timbre
// ═══════════════════════════════════════════════════════════════
// FIX OOM : in-place, calcul du bruit à la volée (zéro allocation)
function applyPhraseVariation(signal, sr, depthCents, seed) {
  if(depthCents<=0) return signal;
  const rand=makePRNG(seed>>>0);
  const len=signal.length;
  const dt=1/sr;
  const alpha=dt/(dt+1/(2*Math.PI*2.5));
  let lp=0;
  const src=signal.slice(); // 1 copie inévitable
  let srcPos=0; // FIX : même correction — position accumulée, pas i*ratio
  for(let i=0;i<len;i++){
    lp=lp+alpha*((rand()*2-1)-lp);
    const ratio=Math.pow(2,lp*depthCents/1200);
    // Même fix qualité : interpolation cubique au lieu de linéaire
    const s1=Math.max(0,Math.min(len-1,Math.floor(srcPos)|0));
    const fr=srcPos-Math.floor(srcPos);
    const s0=Math.max(0,s1-1), s2=Math.min(len-1,s1+1), s3=Math.min(len-1,s1+2);
    const y0=src[s0]||0, y1=src[s1]||0, y2=src[s2]||0, y3=src[s3]||0;
    const a0=y3-y2-y0+y1, a1=y0-y1-a0, a2=y2-y0, a3=y1;
    signal[i] = a0*fr*fr*fr + a1*fr*fr + a2*fr + a3;
    srcPos+=ratio;
    if (srcPos > len-1) srcPos = len-1;
  }
  return signal; // in-place
}

// ═══════════════════════════════════════════════════════════════
// COLORATION TIMBRALE (EQ paramétrique peaking)
// ═══════════════════════════════════════════════════════════════
// FIX OOM : in-place (zéro allocation)
function applyTimbreColor(signal,fcHz,gainDB,Q,sr){
  if(Math.abs(gainDB)<0.2) return signal;
  const A=Math.pow(10,gainDB/40),w0=2*Math.PI*fcHz/sr;
  const cosW=Math.cos(w0),sinW=Math.sin(w0),alpha=sinW/(2*Q);
  const b0=1+alpha*A,b1=-2*cosW,b2=1-alpha*A;
  const a0=1+alpha/A,a1=-2*cosW,a2=1-alpha/A;
  let x1=0,x2=0,y1=0,y2=0;
  for(let i=0;i<signal.length;i++){
    const x0=signal[i]||0;
    const y0=(b0*x0+b1*x1+b2*x2-a1*y1-a2*y2)/a0;
    signal[i]=y0;x2=x1;x1=x0;y2=y1;y1=y0;
  }
  return signal; // in-place
}

// ═══════════════════════════════════════════════════════════════
// PASSE-HAUT PAR HARMONIE (v7.6.467, recherche + retour Cash — "quand on
// les entend elles nuisent, quand on ne les entend pas elles ne renforcent
// pas"). Cause identifiée : les harmonies occupaient les MÊMES basses/bas-
// médiums que la voix lead, donc dès qu'elles étaient assez fortes pour
// s'entendre, elles floutaient la voix au lieu de l'épaissir — au lieu de
// se loger dans leur propre espace fréquentiel. Ce passe-haut retire le
// grave inutile de chaque harmonie (elle n'a pas besoin de porter le corps
// grave — la voix lead s'en charge déjà), pour qu'elle reste un vrai
// "renfort" au lieu d'un concurrent. Biquad RBJ standard, in-place.
function applyHighpass(signal, fcHz, Q, sr) {
  if (fcHz <= 0) return signal;
  const w0 = 2 * Math.PI * fcHz / sr;
  const cosW = Math.cos(w0), sinW = Math.sin(w0), alpha = sinW / (2 * Q);
  const b0 = (1 + cosW) / 2, b1 = -(1 + cosW), b2 = (1 + cosW) / 2;
  const a0 = 1 + alpha, a1 = -2 * cosW, a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < signal.length; i++) {
    const x0 = signal[i] || 0;
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    signal[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return signal; // in-place
}

// FIX OOM : in-place (zéro allocation)
function applyTimingOffset(signal,offsetMs,sr){
  if(offsetMs<=0) return signal;
  const off=Math.floor(offsetMs*sr/1000);
  for(let i=signal.length-1;i>=off;i--) signal[i]=signal[i-off];
  for(let i=0;i<off;i++) signal[i]=0;
  return signal; // in-place
}

// ═══════════════════════════════════════════════════════════════
// REVERB PLATE
// ═══════════════════════════════════════════════════════════════
// FIX OOM : in-place — wet calculé sample par sample et mixé directement dans signal
// Avant : wet (46MB) + result (46MB) = 92 MB. Après : zéro allocation supplémentaire
function applyPlateReverb(signal, sr, dryWet) {
  if(dryWet<=0) return signal;
  const len=signal.length;
  const erTaps=[
    {d:0.0043,g:0.55},{d:0.0079,g:-0.48},{d:0.0120,g:0.42},
    {d:0.0178,g:-0.36},{d:0.0235,g:0.30},{d:0.0302,g:-0.25},
    {d:0.0378,g:0.20},{d:0.0441,g:-0.16},{d:0.0520,g:0.12},
    {d:0.0601,g:-0.09}
  ].map(t=>({d:Math.max(1,Math.floor(t.d*sr)),g:t.g}));
  const maxER=Math.max(...erTaps.map(t=>t.d))+1;
  const erBuf=new Float32Array(maxER);
  let erPtr=0;
  const combD=[0.0307,0.0379,0.0421,0.0451].map(d=>Math.max(1,Math.floor(d*sr)));
  const combG=[0.805,0.827,0.783,0.764];
  const combBufs=combD.map(d=>new Float32Array(d));
  const combPtrs=new Int32Array(4);
  const apD=[0.0127,0.0093].map(d=>Math.max(1,Math.floor(d*sr)));
  const apG=[0.7,0.7];
  const apBufs=apD.map(d=>new Float32Array(d));
  const apPtrs=new Int32Array(2);
  const preD=Math.max(1,Math.floor(0.010*sr));
  const preBuf=new Float32Array(preD);
  let prePtr=0;
  const dw=Math.min(0.35,Math.max(0,dryWet));
  const dry=1-dw;
  for(let i=0;i<len;i++){
    const x=signal[i]||0;
    const pre=preBuf[prePtr];
    preBuf[prePtr]=x;
    prePtr=(prePtr+1)%preD;
    erBuf[erPtr%maxER]=pre;
    let er=0;
    for(const t of erTaps) er+=erBuf[(erPtr-t.d+maxER*2)%maxER]*t.g;
    erPtr=(erPtr+1)%maxER;
    let late=0;
    for(let c=0;c<4;c++){
      const buf=combBufs[c],ptr=combPtrs[c],d=combD[c];
      const out=buf[ptr];
      buf[ptr]=er+out*combG[c];
      combPtrs[c]=(ptr+1)%d;
      late+=out*0.25;
    }
    for(let a=0;a<2;a++){
      const buf=apBufs[a],ptr=apPtrs[a],d=apD[a];
      const stored=buf[ptr];
      const inp=a===0?late:stored;
      const fwd=inp-apG[a]*stored;
      buf[ptr]=fwd+apG[a]*stored;
      apPtrs[a]=(ptr+1)%d;
      late=stored+apG[a]*fwd;
    }
    // Mix in-place directement dans signal
    signal[i]=x*dry+(er*0.4+late*0.6)*dw;
  }
  return signal; // in-place
}

// ═══════════════════════════════════════════════════════════════
// CHORUS STÉRÉO
// ═══════════════════════════════════════════════════════════════
// FIX OOM : chorus + gain/pan fusionnés en une seule passe in-place
// Avant : applyChorusStereo (2x 46MB) + applyGainPanStereo (2x 46MB) = 184 MB
// Après : une seule paire outL/outR = 92 MB, calcul unique
function applyChorusGainPan(signal, sr, depth, rate, seed, gain, pan) {
  const rand = makePRNG((seed ^ 0xF00BAA) >>> 0);
  const len = signal.length;
  const maxDelay = Math.floor(sr * 0.030) + 1;
  const bufL = new Float32Array(maxDelay + 1);
  const bufR = new Float32Array(maxDelay + 1);
  let ptrL = 0, ptrR = 0;
  const outL = new Float32Array(len);
  const outR = new Float32Array(len);
  const baseDelL = Math.floor(sr * 0.013);
  const baseDelR = Math.floor(sr * 0.017);
  const phaseL = rand() * Math.PI * 2;
  const phaseR = rand() * Math.PI * 2;
  // Pan coefficients
  const p = Math.max(-1, Math.min(1, pan));
  const pr = (p + 1) * Math.PI / 4;
  const pL = Math.cos(pr) * gain;
  const pR = Math.sin(pr) * gain;

  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const modL = Math.sin(2 * Math.PI * rate * t + phaseL) * depth * sr;
    const modR = Math.sin(2 * Math.PI * rate * 1.13 * t + phaseR) * depth * sr;
    const delL = Math.max(1, baseDelL + Math.floor(modL));
    const delR = Math.max(1, baseDelR + Math.floor(modR));
    const x = signal[i] || 0;
    bufL[ptrL % maxDelay] = x;
    bufR[ptrR % maxDelay] = x;
    const rL = (ptrL - delL + maxDelay * 2) % maxDelay;
    const rR = (ptrR - delR + maxDelay * 2) % maxDelay;
    // Chorus + gain/pan en une seule opération
    outL[i] = (x * 0.65 + bufL[rL] * 0.35) * pL;
    outR[i] = (x * 0.65 + bufR[rR] * 0.35) * pR;
    ptrL = (ptrL + 1) % maxDelay;
    ptrR = (ptrR + 1) % maxDelay;
  }
  return { outL, outR };
}

function applyChorusStereo(signal, sr, depth, rate, seed) {
  return applyChorusGainPan(signal, sr, depth, rate, seed, 1.0, 0);
}

// ═══════════════════════════════════════════════════════════════
// GAIN / PAN STÉRÉO
// ═══════════════════════════════════════════════════════════════
function applyGainPanStereo(inL,inR,len,gain,pan){
  const p=Math.max(-1,Math.min(1,pan));
  const pr=(p+1)*Math.PI/4;
  const pL=Math.cos(pr)*gain,pR=Math.sin(pr)*gain;
  const outL=new Float32Array(len),outR=new Float32Array(len);
  for(let i=0;i<len;i++){
    outL[i]=(inL[i]||0)*pL;
    outR[i]=(inR[i]||0)*pR;
  }
  return{outL,outR};
}

function applyGainPanDouble(inL,inR,len,gain){
  const outL=new Float32Array(len),outR=new Float32Array(len);
  for(let i=0;i<len;i++){outL[i]=(inL[i]||0)*gain;outR[i]=(inR[i]||0)*gain;}
  return{outL,outR};
}

// ═══════════════════════════════════════════════════════════════
// DOUBLE TRACKING
// ═══════════════════════════════════════════════════════════════
function doubleTrack(mono,sr){
  const len=mono.length;
  // FIX "décalage progressif qui s'accumule" : l'ancien resample() linéaire
  // change la hauteur en changeant la VITESSE de lecture (comme ralentir/
  // accélérer une bande analogique) — pitch et durée sont couplés. Pour un
  // désaccord de 3 cents, la copie détournée devient ~0.017% plus longue que
  // l'original ; chaque échantillon i de la copie provient alors d'une
  // position i*ratio dans l'original, un décalage qui CROÎT linéairement
  // avec i. Sur une chanson de 3:43, ça donne ~0.3-0.4s de dérive à la fin —
  // exactement "parfait au début, de plus en plus désynchro". On utilise
  // maintenant Rubber Band (déjà utilisé ailleurs, timeRatio=1.0) qui décale
  // la hauteur SANS toucher à la durée : plus aucune dérive possible.
  const fitLength = (buf) => {
    if (buf.length === len) return buf;
    const out = new Float32Array(len);
    out.set(buf.subarray(0, Math.min(buf.length, len)));
    return out;
  };
  const lightShift = (view, semi, sr) => rbPitchShift(view, semi, sr);
  // FIX v7 "on approche mais pas assez" (v7.6.432) : 6 cents a aidé mais
  // reste encore un peu discret d'après le test. On monte à 8 cents (0.08 ST)
  // — encore sous les 10 cents qui posaient problème historiquement (voir
  // FIX v3 plus haut : "toujours 3 voix / écho"), mais on s'en rapproche.
  // Si ça part vers l'écho/chorus, revenir à 6-7 cents plutôt que réessayer 10.
  const sL = fitLength(processChunked(mono, 0.08, sr, undefined, lightShift));
  const sR = fitLength(processChunked(mono, -0.08, sr, undefined, lightShift));
  // FIX v3 "toujours 3 voix / écho" : réduire un délai FIXE, aussi court
  // soit-il, ne suffit pas — un délai statique et parfaitement périodique se
  // lit toujours comme une réflexion numérique (comb filtering), pas comme
  // une deuxième voix humaine. Une vraie prise de double-tracking humaine a
  // un timing qui BOUGE légèrement en continu (jamais deux fois le même
  // écart). On remplace donc le délai fixe par un délai très court MODULÉ
  // lentement (façon chorus), avec une lecture interpolée, pour casser l'effet
  // de copie exacte et fusionner les 3 couches en une seule voix épaisse.
  const readInterp = (src, pos) => {
    const idx = Math.floor(pos);
    if (idx < 0 || idx >= src.length - 1) return 0;
    const frac = pos - idx;
    return src[idx] + (src[idx + 1] - src[idx]) * frac;
  };
  // FIX v4 (recherché) : les valeurs précédentes (2-6ms) étaient bien EN
  // DESSOUS de la zone professionnelle établie pour l'ADT (Automatic Double
  // Tracking, technique inventée aux studios Abbey Road pour les Beatles) —
  // qui utilise typiquement 15-35ms de délai. En dessous d'environ 10-15ms,
  // deux copies quasi identiques d'une même voix entrent en interférence de
  // phase (filtrage en peigne, son "creux"/métallique) plutôt que de fusionner
  // naturellement. L'ingrédient clé pour éviter que 15-35ms sonne comme un
  // écho n'est PAS un délai plus court — c'est une modulation LFO du délai
  // dans le temps (comme une bande qui varie légèrement en vitesse), qui
  // empêche le délai d'être parfaitement statique/périodique.
  // FIX v5 : profondeur de modulation réduite (4-5ms → 2-2.5ms). Un swing
  // de délai trop large ressemble à un chorus marqué (chaque copie "ondule"
  // audiblement en hauteur), ce qui ajoutait aussi à l'impression de
  // deuxième voix, en plus du désaccord corrigé plus haut.
  // FIX v7 "on approche mais pas assez" (v7.6.432) : délais et étalement
  // stéréo encore un cran plus larges — on reste dans la zone pro Abbey
  // Road (15-35ms) documentée plus haut, mais vers le haut de la fourchette
  // pour mieux séparer les deux voix à l'oreille.
  const baseDelayL = 0.019 * sr, modDepthL = 0.002 * sr, modRateL = 0.5; // Hz — ~17-21ms
  const baseDelayR = 0.029 * sr, modDepthR = 0.0025 * sr, modRateR = 0.7; // ~26.5-31.5ms
  const maxDelay = Math.ceil(Math.max(baseDelayL + modDepthL, baseDelayR + modDepthR)) + 2;
  const outLen = len + maxDelay;
  const outL=new Float32Array(outLen),outR=new Float32Array(outLen);
  // FIX v7 : dry encore réduit (0.62→0.55), wet encore monté (0.70→0.82),
  // étalement stéréo élargi (0.80/0.20→0.85/0.15) — la double doit maintenant
  // ressortir clairement à l'oreille, pas juste épaissir en arrière-plan.
  for(let i=0;i<len;i++){outL[i]+=mono[i]*0.55;outR[i]+=mono[i]*0.55;}
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const dL = baseDelayL + modDepthL * Math.sin(2 * Math.PI * modRateL * t);
    const dR = baseDelayR + modDepthR * Math.sin(2 * Math.PI * modRateR * t + 1.7);
    const sVal = readInterp(sL, i) * 0.82;
    const rVal = readInterp(sR, i) * 0.82;
    const idxL = i + dL, idxR = i + dR;
    const fL = Math.floor(idxL), fR = Math.floor(idxR);
    if (fL >= 0 && fL + 1 < outLen) {
      const frac = idxL - fL;
      outL[fL]   += sVal * 0.85 * (1 - frac); outL[fL+1]   += sVal * 0.85 * frac;
      outR[fL]   += sVal * 0.15 * (1 - frac); outR[fL+1]   += sVal * 0.15 * frac;
    }
    if (fR >= 0 && fR + 1 < outLen) {
      const frac = idxR - fR;
      outL[fR]   += rVal * 0.15 * (1 - frac); outL[fR+1]   += rVal * 0.15 * frac;
      outR[fR]   += rVal * 0.85 * (1 - frac); outR[fR+1]   += rVal * 0.85 * frac;
    }
  }
  let peak=0;
  for(let i=0;i<outLen;i++) peak=Math.max(peak,Math.abs(outL[i]),Math.abs(outR[i]));
  if(peak>0.95){const n=0.95/peak;for(let i=0;i<outLen;i++){outL[i]*=n;outR[i]*=n;}}
  return{outL,outR,outLen};
}

// ═══════════════════════════════════════════════════════════════
// PROFILS PAR HARMONIE (inchangés)
// ═══════════════════════════════════════════════════════════════
// LAYER_PROFILES calibrés pour voix baritone ~284Hz, reverb dense 861ms, peak -19.8dBFS
// pitchVar  : variation de phrase en cents (réduit car reverb longue masque déjà les imperfections)
// timingMs  : offset temporel (augmenté pour séparer les voix dans la queue de reverb)
// reverbWet : réduit — le signal a déjà 861ms de reverb naturelle, évite la boue
// chorusDepth : réduit — idem, la reverb fait déjà le travail de widening
const LAYER_PROFILES={
  2:{pitchVar:1.5,timingMs:18,timbreHz:2800,timbreDb:+1.2,pan:-0.30,chorusRate:0.95,chorusDepth:0.003,reverbWet:0.08,hpfHz:190},
  3:{pitchVar:2.5,timingMs:32,timbreHz:3400,timbreDb:-0.8,pan:+0.35,chorusRate:1.10,chorusDepth:0.004,reverbWet:0.10,hpfHz:130},
  4:{pitchVar:1.2,timingMs:12,timbreHz:250, timbreDb:+1.8,pan:+0.10,chorusRate:0.80,chorusDepth:0.002,reverbWet:0.06,hpfHz:210},
  5:{pitchVar:2.0,timingMs:26,timbreHz:1800,timbreDb:+0.6,pan:-0.15,chorusRate:1.25,chorusDepth:0.003,reverbWet:0.09,hpfHz:140},
};

// ═══════════════════════════════════════════════════════════════
// WAV ENCODER
// ═══════════════════════════════════════════════════════════════
function audioToWav(chL,chR,sr){
  const n=chL.length,dl=n*4,buf=new ArrayBuffer(44+dl),v=new DataView(buf);
  const ws=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  ws(0,'RIFF');v.setUint32(4,36+dl,true);ws(8,'WAVE');ws(12,'fmt ');
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,2,true);
  v.setUint32(24,sr,true);v.setUint32(28,sr*4,true);v.setUint16(32,4,true);v.setUint16(34,16,true);
  ws(36,'data');v.setUint32(40,dl,true);
  let off=44;
  for(let i=0;i<n;i++){
    const sL=Math.max(-1,Math.min(1,chL[i]||0)),sR=Math.max(-1,Math.min(1,chR[i]||0));
    v.setInt16(off,sL<0?sL*0x8000:sL*0x7FFF,true);off+=2;
    v.setInt16(off,sR<0?sR*0x8000:sR*0x7FFF,true);off+=2;
  }
  return buf;
}

// ═══════════════════════════════════════════════════════════════
// PIPELINE PRINCIPAL
// FIX mémoire : chaque étape null-out la référence précédente
// dès que possible pour réduire le pic RAM sur iOS Safari Worker.
// ═══════════════════════════════════════════════════════════════
function processSingle(mono, semitones, sampleRate, trackIndex) {
  const profile = LAYER_PROFILES[trackIndex] || LAYER_PROFILES[2];
  const seed = (trackIndex || 2) * 7919;

  // 0a. FIX "ça change rien" : le plafond de +18dB posé précédemment,
  // combiné à une prise très faible, laissait CHAQUE morceau autour de
  // -18 à -21 dBFS après boost — toujours EN DESSOUS du seuil de -6dBFS où
  // Rubber Band commence à mal se comporter (voir commentaire ci-dessous).
  // Le plafond empêchait donc le vrai problème d'être réglé.
  //
  // Avant de remonter le gain, on retire d'abord le grondement grave/DC
  // (sous ~90Hz — bruit de manipulation, ronflement secteur, souffle d'air)
  // qui ne sert à rien pour la voix mais qui, une fois amplifié en même
  // temps que tout le reste, ajoute du "sale" que Rubber Band doit aussi
  // traiter. Filtre passe-haut 1 pôle, en place, avant le calcul du gain.
  {
    const cutoffHz = 90;
    const rc = 1 / (2 * Math.PI * cutoffHz);
    const dt = 1 / sampleRate;
    const alpha = rc / (rc + dt);
    let prevIn = mono[0] || 0, prevOut = 0;
    for (let i = 0; i < mono.length; i++) {
      const x = mono[i];
      const y = alpha * (prevOut + x - prevIn);
      prevIn = x; prevOut = y;
      mono[i] = y;
    }
  }

  // 0b. Pré-normalisation avant Rubber Band — CRITIQUE pour ta voix
  // Ton signal est à -19.8 dBFS (peak 0.103). En dessous de ~-6 dBFS,
  // Rubber Band amplifie le bruit de fond lors du pitch shift → souffles et artefacts.
  // On normalise temporairement à -3 dBFS avant RB, puis l'AGC remet le bon niveau.
  //
  // Le plafond est maintenant à +30dB (au lieu de +18dB) : avec le filtre
  // passe-haut ci-dessus et le gate ci-dessous, on peut se permettre un gain
  // plus généreux pour vraiment sortir le signal de la zone à risque de
  // Rubber Band, sans réamplifier le grondement grave qui a été retiré.
  let preGain = 1.0;
  let prePeak = 0;
  for (let i = 0; i < mono.length; i++) prePeak = Math.max(prePeak, Math.abs(mono[i]));
  if (prePeak > 0.001 && prePeak < 0.5) {
    preGain = Math.min(0.707 / prePeak, 8.0); // cible -3 dBFS, plafonné à +18 dB (retour arrière : +30dB a empiré le résultat)
    // FIX "voix étouffée par artefacts" : l'ancien gate agissait sur la valeur
    // instantanée de CHAQUE échantillon, ce qui déforme la forme d'onde des
    // passages calmes (une forme de distorsion) avant même le pitch-shift.
    // Un vocodeur de phase transforme un signal bruité/déformé en grésillement
    // robotique qui se mélange à la voix (pas juste dans les silences) — c'est
    // le "bruit musical" classique des algos de pitch-shift. On suit
    // maintenant une ENVELOPPE lissée (attaque 3ms / relâche 80ms), qui coupe
    // le souffle/bruit de fond sans déformer la forme d'onde du signal utile.
    const gateThresh = 0.0056; // ~ -45 dBFS
    const attackCoef  = Math.exp(-1 / (0.003 * sampleRate));
    const releaseCoef = Math.exp(-1 / (0.080 * sampleRate));
    let env = 0;
    for (let i = 0; i < mono.length; i++) {
      const a = Math.abs(mono[i]);
      env = a > env ? attackCoef * env + (1 - attackCoef) * a
                    : releaseCoef * env + (1 - releaseCoef) * a;
      const g = env < gateThresh ? (env / gateThresh) * (env / gateThresh) : 1.0; // knee quadratique sur l'enveloppe, pas l'échantillon
      mono[i] *= preGain * g;
    }
  }

  // 1. Pitch shift — seule étape qui crée un nouveau buffer (inévitable)
  let sig = rbPitchShift(mono, semitones, sampleRate);

  // Annuler la pré-normalisation sur mono (restaurer pour l'AGC)
  if (preGain !== 1.0) {
    const invGain = 1.0 / preGain;
    for (let i = 0; i < mono.length; i++) mono[i] *= invGain;
  }

  // 2-9. Toutes les étapes suivantes sont IN-PLACE — zéro allocation
  applyAGC(sig, mono);
  applyBreathGate(sig, sampleRate, semitones);
  if (semitones >= 4) applySoftSaturation(sig, 0.03 + (semitones - 4) / 12 * 0.04);
  applyPhraseVariation(sig, sampleRate, profile.pitchVar, seed);
  applyOrganicJitter(sig, sampleRate, seed ^ 0xABCD1234);
  applyTimbreColor(sig, profile.timbreHz, profile.timbreDb, 1.3, sampleRate);
  applyHighpass(sig, profile.hpfHz, 0.707, sampleRate);
  applyTimingOffset(sig, profile.timingMs, sampleRate);
  applyPlateReverb(sig, sampleRate, profile.reverbWet);

  // Limiteur in-place
  let peak = 0;
  for (let i = 0; i < sig.length; i++) peak = Math.max(peak, Math.abs(sig[i]));
  if (peak > 0.98) { const n = 0.98/peak; for (let i = 0; i < sig.length; i++) sig[i] *= n; }

  return sig;
}

// Traitement chunked — TOUJOURS utilisé pour les enregistrements > 8s
// FIX OOM iOS : chunk de 20s max — historique : 40s (1.76M échantillons)
// causait un pic mémoire de 80-100 MB côté WASM et faisait tuer le worker
// par iOS sans message d'erreur. La mémoire WASM du moteur offline/finer
// semble croître de façon non-linéaire avec la durée (~4x mémoire pour 2x
// durée), donc 20s reste avec une marge confortable sous le seuil de crash
// historique tout en divisant par ~2 le nombre de coupures de chunk (donc de
// points où l'algo doit se "re-stabiliser").
function processChunked(mono, semitones, sampleRate, trackIndex, processFn) {
  const doProcess = processFn || ((view, semi, sr) => processSingle(view, semi, sr, trackIndex));
  const chunkSamp = Math.floor(sampleRate * 20);

  if (mono.length <= chunkSamp) return doProcess(mono, semitones, sampleRate);

  // FIX "ça grince puis devient clair au milieu d'une phrase" :
  // Chaque chunk relançait Rubber Band à zéro, sans AUCUN contexte avant le
  // point de coupe — l'algo (détection de pitch, formants) a besoin d'un
  // court moment pour se stabiliser. Quand une coupure de chunk tombait au
  // milieu d'une phrase chantée, le début de cette portion grinçait jusqu'à
  // stabilisation. On ajoute maintenant un "pré-roll" de contexte AVANT
  // chaque coupure (sauf le tout premier chunk), qu'on traite mais qu'on jette
  // ensuite — l'algo se stabilise dans cette zone jetée, invisible à l'oreille,
  // et seule la portion déjà stable est gardée dans la sortie.
  const overlapSamp = Math.floor(sampleRate * 0.1);
  const preRollSamp  = Math.floor(sampleRate * 1.5); // 1.5s de "chauffe" avant chaque coupure
  // FIX "trop d'artefacts" (clics aux coupures de chunk) : le pré-roll
  // évite déjà le grincement de stabilisation, mais une simple concaténation
  // brute de deux rendus indépendants peut encore créer une discontinuité
  // audible à la jonction (les deux sorties de la moteur phase-vocoder ne
  // s'alignent pas forcément échantillon pour échantillon). Confirmé par
  // analyse de signal : des clics se regroupent quasiment pile aux
  // timestamps de coupure (20s, 40s, 60s...). On fond maintenant en fondu
  // enchaîné (~15ms) à chaque jonction au lieu d'un cut sec.
  const crossfadeSamp = Math.max(1, Math.floor(sampleRate * 0.04));
  const final = new Float32Array(mono.length + overlapSamp * 4);
  let outOff = 0;
  let pos = 0;

  while (pos < mono.length) {
    const end = Math.min(pos + chunkSamp, mono.length);
    const hasMore = end < mono.length;
    const preRollStart = Math.max(0, pos - preRollSamp);
    let actualPreRoll = pos - preRollStart;
    // subarray = vue sans copie (zéro allocation supplémentaire)
    let chunkView = mono.subarray(preRollStart, hasMore ? end + overlapSamp : end);

    // FIX "début de chanson" : le tout premier chunk (pos===0) n'a AUCUN
    // vrai audio avant lui pour servir de pré-roll — l'algo démarre donc
    // toujours à froid pile au début de la chanson, là où c'est le plus
    // audible. On fabrique un pré-roll artificiel en "miroir" (les toutes
    // premières ms jouées à l'envers) : ça donne à l'algo un signal réaliste
    // à digérer avant le vrai début, sans avoir besoin d'audio qui n'existe
    // pas. On jette ensuite cette portion miroir comme n'importe quel pré-roll.
    if (pos === 0) {
      const mirrorLen = Math.min(preRollSamp, mono.length - 1);
      const mirror = new Float32Array(mirrorLen);
      for (let i = 0; i < mirrorLen; i++) mirror[i] = mono[mirrorLen - 1 - i];
      const combined = new Float32Array(mirrorLen + chunkView.length);
      combined.set(mirror, 0);
      combined.set(chunkView, mirrorLen);
      chunkView = combined;
      actualPreRoll = mirrorLen;
    }

    let processed = doProcess(chunkView, semitones, sampleRate);
    // Portion à sauter au début = le pré-roll (proportionnel, comme pour keepLen)
    const skipLen = actualPreRoll > 0
      ? Math.floor(processed.length * (actualPreRoll / chunkView.length))
      : 0;
    const usableLen = processed.length - skipLen;
    const mainSamp  = end - pos; // durée réelle du chunk (sans pré-roll ni overlap)
    const keepLen = hasMore
      ? Math.floor(usableLen * (mainSamp / (chunkView.length - actualPreRoll)))
      : usableLen;

    // fadeIn : chevauche le fadeOut déjà écrit par le chunk précédent
    const fadeIn = (pos > 0) ? Math.min(crossfadeSamp, skipLen, outOff) : 0;
    // fadeOut : puise dans l'overlap déjà calculé (contexte futur réel, pas jeté)
    const fadeOut = hasMore ? Math.min(crossfadeSamp, Math.max(0, processed.length - skipLen - keepLen)) : 0;
    const writeStart = skipLen - fadeIn;
    const writeLen = keepLen + fadeIn + fadeOut;
    const dstStart = outOff - fadeIn;

    if (dstStart >= 0 && dstStart + writeLen <= final.length) {
      for (let i = 0; i < writeLen; i++) {
        const v = processed[writeStart + i];
        if (i < fadeIn) {
          const t = i / fadeIn; // 0 → 1
          // Fondu à puissance égale (cosine) plutôt que linéaire : un fondu
          // linéaire creuse le volume perçu au milieu de la transition quand
          // les deux sources ne sont pas parfaitement en phase, ce qui rend
          // la jonction plus audible au lieu de moins.
          const gOut = Math.cos(t * Math.PI / 2);
          const gIn = Math.sin(t * Math.PI / 2);
          final[dstStart + i] = final[dstStart + i] * gOut + v * gIn;
        } else {
          final[dstStart + i] = v;
        }
      }
      outOff = dstStart + writeLen - fadeOut; // le fadeOut sera repris par le prochain chunk
    } else {
      // Repli sécuritaire (ne devrait pas arriver) : écriture directe sans fondu
      if (outOff + keepLen <= final.length) {
        final.set(processed.subarray(skipLen, skipLen + keepLen), outOff);
      }
      outOff += keepLen;
    }
    processed = null; // libère immédiatement — eligible GC avant prochain chunk
    pos = end;
  }

  return final.subarray(0, outOff);
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════
self.onmessage = async function(e) {
  // Message 'init' : reçoit wasmModule + umdCode compilés du main thread
  if (e.data && e.data.op === 'init') {
    try {
      await initRubberBandFromModule(e.data.wasmModule, e.data.umdCode);
      self.postMessage({ id: e.data.id, type: 'initDone' });
    } catch(err) {
      self.postMessage({ id: e.data.id, type: 'error', message: err.message });
    }
    return;
  }
  const { id, op, channelL, channelR, semitones, gain, pan, sampleRate, trackIndex } = e.data;
  try {
    if (!rbReady) throw new Error('Rubber Band non prêt — init non reçu');
    const len = channelL.length;
    // channelR peut être null si le main thread envoie déjà un signal mono downsampleé
    const mono = channelR
      ? (() => { const m = new Float32Array(len); for (let i=0;i<len;i++) m[i]=(channelL[i]+channelR[i])*0.5; return m; })()
      : channelL; // déjà mono — pas de copie

    let outL, outR, outLen;

    if (op === 'double') {
      self.postMessage({ id, type: 'progress', label: 'Double tracking...' });
      const res = doubleTrack(mono, sampleRate);
      outL = res.outL; outR = res.outR; outLen = res.outLen;
      const gp = applyGainPanDouble(outL, outR, outLen, gain);
      self.postMessage({ id, type: 'progress', label: 'Encodage WAV...' });
      const wavBuf = audioToWav(gp.outL, gp.outR, sampleRate);
      self.postMessage({ id, type: 'done', wavBuf }, [wavBuf]);
      return;
    }

    self.postMessage({ id, type: 'progress', label: `Génération harmonie ${semitones > 0 ? '+' : ''}${semitones} ST (Rubber Band)...` });

    // Pipeline principal — chunked si > 8s pour éviter OOM iOS
    const USE_CHUNKED_THRESHOLD = sampleRate * 8; // 8s
    const shifted = mono.length > USE_CHUNKED_THRESHOLD
      ? processChunked(mono, semitones, sampleRate, trackIndex)
      : processSingle(mono, semitones, sampleRate, trackIndex);

    // Chorus stéréo + gain/pan en une seule passe (zéro buffer intermédiaire)
    const profile = LAYER_PROFILES[trackIndex] || LAYER_PROFILES[2];
    self.postMessage({ id, type: 'progress', label: 'Chorus stéréo...' });
    const gp = applyChorusGainPan(shifted, sampleRate, profile.chorusDepth, profile.chorusRate, (trackIndex || 2) * 7919, gain, pan);
    // Libérer shifted immédiatement — plus besoin
    let shiftedRef = shifted; shiftedRef = null;

    self.postMessage({ id, type: 'progress', label: 'Encodage WAV...' });
    const wavBuf = audioToWav(gp.outL, gp.outR, sampleRate);
    self.postMessage({ id, type: 'done', wavBuf }, [wavBuf]);

  } catch(err) {
    self.postMessage({ id, type: 'error', message: err.message || String(err) });
  }
};
