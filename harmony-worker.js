// harmony-worker.js v15 — Rubber Band WASM via main thread transfer
// Le WASM est compilé dans le main thread et transféré ici comme WebAssembly.Module
// Aucun base64 stocké dans le worker — économise ~350KB de mémoire iOS
// Pipeline : Rubber Band pitch shift → AGC → Saturation → Jitter → Timbre → Reverb → Chorus → Pan

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
  const blockSize = 4096;
  const channels = 1;

  // RubberBandOptionProcessOffline=0 | StretchElastic=0 | FormantPreserved=16777216 | PitchHighQuality=33554432 | EngineFiner=536870912
  const options = 0 | 16777216 | 33554432 | 536870912;

  const handle = rbApi.rubberband_new(sampleRate, channels, options, 1.0, pitchScale);
  if (!handle) throw new Error('rubberband_new a échoué');

  try {
    rbApi.rubberband_set_pitch_scale(handle, pitchScale);
    rbApi.rubberband_set_max_process_size(handle, blockSize);
    rbApi.rubberband_set_expected_input_duration(handle, mono.length);

    const inPtr = rbApi.malloc(blockSize * 4);
    const inPtrsBuf = rbApi.malloc(4);
    rbApi.memWritePtr(inPtrsBuf, inPtr);

    // ── Phase d'étude (study) — nécessaire en mode offline ──
    let pos = 0;
    while (pos < mono.length) {
      const chunkLen = Math.min(blockSize, mono.length - pos);
      const chunk = mono.subarray(pos, pos + chunkLen);
      const padded = chunkLen < blockSize ? (() => { const z = new Float32Array(blockSize); z.set(chunk); return z; })() : chunk;
      rbApi.memWrite(inPtr, padded);
      const final = (pos + chunkLen >= mono.length) ? 1 : 0;
      rbApi.rubberband_study(handle, inPtrsBuf, chunkLen, final);
      pos += chunkLen;
    }

    // ── Phase de traitement (process) + récupération ──
    const outChunks = [];
    const outPtr = rbApi.malloc(blockSize * 4);
    const outPtrsBuf = rbApi.malloc(4);
    rbApi.memWritePtr(outPtrsBuf, outPtr);

    pos = 0;
    while (pos < mono.length) {
      const chunkLen = Math.min(blockSize, mono.length - pos);
      const chunk = mono.subarray(pos, pos + chunkLen);
      const padded = chunkLen < blockSize ? (() => { const z = new Float32Array(blockSize); z.set(chunk); return z; })() : chunk;
      rbApi.memWrite(inPtr, padded);
      const final = (pos + chunkLen >= mono.length) ? 1 : 0;
      rbApi.rubberband_process(handle, inPtrsBuf, chunkLen, final);
      pos += chunkLen;

      let avail = rbApi.rubberband_available(handle);
      while (avail > 0) {
        const toRead = Math.min(avail, blockSize);
        const got = rbApi.rubberband_retrieve(handle, outPtrsBuf, toRead);
        if (got > 0) outChunks.push(rbApi.memReadF32(outPtr, got).slice());
        avail = rbApi.rubberband_available(handle);
        if (got <= 0) break;
      }
    }

    let avail = rbApi.rubberband_available(handle);
    let drainGuard = 0;
    while (avail > 0 && drainGuard < 1000) {
      const toRead = Math.min(avail, blockSize);
      const got = rbApi.rubberband_retrieve(handle, outPtrsBuf, toRead);
      if (got > 0) outChunks.push(rbApi.memReadF32(outPtr, got).slice());
      avail = rbApi.rubberband_available(handle);
      drainGuard++;
      if (got <= 0) break;
    }

    rbApi.free(inPtr);
    rbApi.free(inPtrsBuf);
    rbApi.free(outPtr);
    rbApi.free(outPtrsBuf);

    const totalLen = outChunks.reduce((s, c) => s + c.length, 0);
    const result = new Float32Array(totalLen || mono.length);
    let off = 0;
    for (const c of outChunks) { result.set(c, off); off += c.length; }

    return totalLen > 0 ? result : mono;
  } finally {
    rbApi.rubberband_delete(handle);
  }
}

// ═══════════════════════════════════════════════════════════════
// AGC — Automatic Gain Control
// ═══════════════════════════════════════════════════════════════
function applyAGC(signal, reference) {
  let refRMS=0,sigRMS=0;
  for(let i=0;i<reference.length;i++) refRMS+=reference[i]*reference[i];
  for(let i=0;i<signal.length;i++) sigRMS+=signal[i]*signal[i];
  refRMS=Math.sqrt(refRMS/reference.length);
  sigRMS=Math.sqrt(sigRMS/signal.length);
  if(sigRMS<1e-9) return signal;
  const gain=Math.max(0.3,Math.min(2.5,refRMS/sigRMS));
  const out=new Float32Array(signal.length);
  for(let i=0;i<signal.length;i++) out[i]=signal[i]*gain;
  return out;
}

// ═══════════════════════════════════════════════════════════════
// SATURATION DOUCE
// ═══════════════════════════════════════════════════════════════
function applySoftSaturation(signal, amount) {
  if(amount<=0) return signal;
  const out=new Float32Array(signal.length);
  const k=2*amount/(1-amount);
  for(let i=0;i<signal.length;i++){
    const x=signal[i]||0;
    out[i]=(1+k)*x/(1+k*Math.abs(x));
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// JITTER NATUREL — bruit rose déterministe
// ═══════════════════════════════════════════════════════════════
function applyOrganicJitter(signal, sr, seed) {
  const rand=makePRNG(seed>>>0);
  const len=signal.length;
  const result=new Float32Array(len);
  const dt=1/sr;
  const alphaD=dt/(dt+1/(2*Math.PI*8));
  const alphaF=dt/(dt+1/(2*Math.PI*12));
  let lpD=0,lpF=0;
  const noiseD=new Float32Array(len);
  const noiseF=new Float32Array(len);
  for(let i=0;i<len;i++){noiseD[i]=rand()*2-1;noiseF[i]=rand()*2-1;}
  for(let i=0;i<len;i++){
    lpD=lpD+alphaD*(noiseD[i]-lpD);
    const driftCents=lpD*8.0;
    lpF=lpF+alphaF*(noiseF[i]-lpF);
    const flutter=1.0+lpF*0.015;
    const ratio=Math.pow(2,driftCents/1200);
    const srcPos=i*ratio;
    const s0=Math.max(0,Math.min(len-2,Math.floor(srcPos)|0));
    const fr=srcPos-Math.floor(srcPos);
    const pitched=(signal[s0]||0)*(1-fr)+(signal[Math.min(s0+1,len-1)]||0)*fr;
    result[i]=pitched*flutter;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// PHRASE VARIATION — micro-modulation de timbre
// ═══════════════════════════════════════════════════════════════
function applyPhraseVariation(signal, sr, depthCents, seed) {
  if(depthCents<=0) return signal;
  const rand=makePRNG(seed>>>0);
  const len=signal.length;
  const result=new Float32Array(len);
  const dt=1/sr;
  const alpha=dt/(dt+1/(2*Math.PI*2.5));
  let lp=0;
  const noise=new Float32Array(len);
  for(let i=0;i<len;i++) noise[i]=rand()*2-1;
  for(let i=0;i<len;i++){
    lp=lp+alpha*(noise[i]-lp);
    const cents=lp*depthCents;
    const ratio=Math.pow(2,cents/1200);
    const srcPos=i*ratio;
    const s0=Math.max(0,Math.min(len-2,Math.floor(srcPos)|0));
    const fr=srcPos-Math.floor(srcPos);
    result[i]=(signal[s0]||0)*(1-fr)+(signal[Math.min(s0+1,len-1)]||0)*fr;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// COLORATION TIMBRALE (EQ paramétrique peaking)
// ═══════════════════════════════════════════════════════════════
function applyTimbreColor(signal,fcHz,gainDB,Q,sr){
  if(Math.abs(gainDB)<0.2) return signal;
  const A=Math.pow(10,gainDB/40),w0=2*Math.PI*fcHz/sr;
  const cosW=Math.cos(w0),sinW=Math.sin(w0),alpha=sinW/(2*Q);
  const b0=1+alpha*A,b1=-2*cosW,b2=1-alpha*A;
  const a0=1+alpha/A,a1=-2*cosW,a2=1-alpha/A;
  const out=new Float32Array(signal.length);
  let x1=0,x2=0,y1=0,y2=0;
  for(let i=0;i<signal.length;i++){
    const x0=signal[i]||0;
    const y0=(b0*x0+b1*x1+b2*x2-a1*y1-a2*y2)/a0;
    out[i]=y0;x2=x1;x1=x0;y2=y1;y1=y0;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// TIMING OFFSET
// ═══════════════════════════════════════════════════════════════
function applyTimingOffset(signal,offsetMs,sr){
  if(offsetMs<=0) return signal;
  const off=Math.floor(offsetMs*sr/1000);
  const result=new Float32Array(signal.length);
  for(let i=off;i<signal.length;i++) result[i]=signal[i-off];
  return result;
}

// ═══════════════════════════════════════════════════════════════
// REVERB PLATE
// ═══════════════════════════════════════════════════════════════
function applyPlateReverb(signal, sr, dryWet) {
  if(dryWet<=0) return signal;
  const len=signal.length;
  const wet=new Float32Array(len);
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
    wet[i]=(er*0.4+late*0.6);
  }
  const result=new Float32Array(len);
  const dw=Math.min(0.35,Math.max(0,dryWet));
  for(let i=0;i<len;i++) result[i]=(signal[i]||0)*(1-dw)+wet[i]*dw;
  return result;
}

// ═══════════════════════════════════════════════════════════════
// CHORUS STÉRÉO
// ═══════════════════════════════════════════════════════════════
function applyChorusStereo(signal, sr, depth, rate, seed) {
  const rand=makePRNG((seed^0xF00BAA)>>>0);
  const len=signal.length;
  const maxDelay=Math.floor(sr*0.030)+1;
  const bufL=new Float32Array(maxDelay+1);
  const bufR=new Float32Array(maxDelay+1);
  let ptrL=0,ptrR=0;
  const outL=new Float32Array(len);
  const outR=new Float32Array(len);
  const baseDelL=Math.floor(sr*0.013);
  const baseDelR=Math.floor(sr*0.017);
  const phaseL=rand()*Math.PI*2;
  const phaseR=rand()*Math.PI*2;
  for(let i=0;i<len;i++){
    const t=i/sr;
    const modL=Math.sin(2*Math.PI*rate*t+phaseL)*depth*sr;
    const modR=Math.sin(2*Math.PI*rate*1.13*t+phaseR)*depth*sr;
    const delL=Math.max(1,baseDelL+Math.floor(modL));
    const delR=Math.max(1,baseDelR+Math.floor(modR));
    const x=signal[i]||0;
    bufL[ptrL%maxDelay]=x;
    bufR[ptrR%maxDelay]=x;
    const rL=(ptrL-delL+maxDelay*2)%maxDelay;
    const rR=(ptrR-delR+maxDelay*2)%maxDelay;
    outL[i]=x*0.65+bufL[rL]*0.35;
    outR[i]=x*0.65+bufR[rR]*0.35;
    ptrL=(ptrL+1)%maxDelay;
    ptrR=(ptrR+1)%maxDelay;
  }
  return{outL,outR};
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
  const resample=(src,ratio)=>{
    const outLen=Math.floor(src.length/ratio),out=new Float32Array(outLen);
    for(let i=0;i<outLen;i++){
      const pos=i*ratio,idx=Math.min(Math.floor(pos)|0,src.length-2);
      out[i]=src[idx]+(src[idx+1]-src[idx])*(pos-Math.floor(pos));
    }
    return out;
  };
  const sL=resample(mono,1/Math.pow(2,0.10/12));
  const sR=resample(mono,1/Math.pow(2,-0.10/12));
  const dL=Math.floor(0.016*sr),dR=Math.floor(0.033*sr);
  const outLen=len+Math.floor(0.040*sr);
  const outL=new Float32Array(outLen),outR=new Float32Array(outLen);
  for(let i=0;i<len;i++){outL[i]+=mono[i]*0.70;outR[i]+=mono[i]*0.70;}
  const llLen=Math.min(sL.length,outLen-dL);
  for(let i=0;i<llLen;i++){const s=sL[i]*0.55;outL[i+dL]+=s*0.85;outR[i+dL]+=s*0.15;}
  const rrLen=Math.min(sR.length,outLen-dR);
  for(let i=0;i<rrLen;i++){const s=sR[i]*0.55;outL[i+dR]+=s*0.15;outR[i+dR]+=s*0.85;}
  let peak=0;
  for(let i=0;i<outLen;i++) peak=Math.max(peak,Math.abs(outL[i]),Math.abs(outR[i]));
  if(peak>0.95){const n=0.95/peak;for(let i=0;i<outLen;i++){outL[i]*=n;outR[i]*=n;}}
  return{outL,outR,outLen};
}

// ═══════════════════════════════════════════════════════════════
// PROFILS PAR HARMONIE (inchangés)
// ═══════════════════════════════════════════════════════════════
const LAYER_PROFILES={
  2:{pitchVar:2.5,timingMs:14,timbreHz:2800,timbreDb:+1.5,pan:-0.30,chorusRate:0.95,chorusDepth:0.004,reverbWet:0.17},
  3:{pitchVar:4.0,timingMs:25,timbreHz:3400,timbreDb:-1.0,pan:+0.35,chorusRate:1.10,chorusDepth:0.006,reverbWet:0.20},
  4:{pitchVar:1.8,timingMs:8, timbreHz:250, timbreDb:+2.0,pan:+0.10,chorusRate:0.80,chorusDepth:0.003,reverbWet:0.14},
  5:{pitchVar:3.5,timingMs:20,timbreHz:1800,timbreDb:+0.8,pan:-0.15,chorusRate:1.25,chorusDepth:0.005,reverbWet:0.19},
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
// Utilise Rubber Band pour le pitch shift, garde le reste intact
// ═══════════════════════════════════════════════════════════════
function processSingle(mono, semitones, sampleRate, trackIndex) {
  const profile = LAYER_PROFILES[trackIndex] || LAYER_PROFILES[2];
  const seed = (trackIndex || 2) * 7919;

  // 1. Pitch shift via Rubber Band WASM (FormantPreserved + HQ offline)
  let shifted = rbPitchShift(mono, semitones, sampleRate);

  // 2. AGC — égaliser le niveau sur l'original
  shifted = applyAGC(shifted, mono);

  // 3. Saturation douce (harmonies aiguës uniquement)
  if (semitones >= 4) {
    shifted = applySoftSaturation(shifted, 0.03 + (semitones - 4) / 12 * 0.04);
  }

  // 4. Variation de phrase
  shifted = applyPhraseVariation(shifted, sampleRate, profile.pitchVar, seed);

  // 5. Jitter naturel déterministe
  shifted = applyOrganicJitter(shifted, sampleRate, seed ^ 0xABCD1234);

  // 6. Coloration timbrale par voix
  shifted = applyTimbreColor(shifted, profile.timbreHz, profile.timbreDb, 1.3, sampleRate);

  // 7. Offset temporel
  shifted = applyTimingOffset(shifted, profile.timingMs, sampleRate);

  // 8. Reverb Plate
  shifted = applyPlateReverb(shifted, sampleRate, profile.reverbWet);

  // 9. Limiteur de sécurité
  let peakOut = 0;
  for (let i = 0; i < shifted.length; i++) peakOut = Math.max(peakOut, Math.abs(shifted[i]));
  if (peakOut > 0.98) {
    const n = 0.98 / peakOut;
    for (let i = 0; i < shifted.length; i++) shifted[i] *= n;
  }

  return shifted;
}

// Traitement chunked pour les longs enregistrements (>40s)
function processChunked(mono, semitones, sampleRate, trackIndex) {
  const chunkSamp = Math.floor(sampleRate * 40);
  if (mono.length <= chunkSamp) return processSingle(mono, semitones, sampleRate, trackIndex);
  const overlapSamp = Math.floor(sampleRate * 0.4);
  const results = [];
  let pos = 0;
  while (pos < mono.length) {
    const end = Math.min(pos + chunkSamp, mono.length);
    const chunk = mono.slice(pos, end < mono.length ? end + overlapSamp : end);
    const processed = processSingle(chunk, semitones, sampleRate, trackIndex);
    const keepLen = end < mono.length ? Math.floor(processed.length * (chunkSamp / chunk.length)) : processed.length;
    results.push(processed.slice(0, keepLen));
    pos = end;
  }
  const totalLen = results.reduce((s, r) => s + r.length, 0);
  const final = new Float32Array(totalLen);
  let off = 0;
  for (const r of results) { final.set(r, off); off += r.length; }
  return final;
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
    // Rubber Band doit être initialisé via message 'init' avant tout traitement
    if (!rbReady) throw new Error('Rubber Band non prêt — init non reçu');
    const len = channelL.length;
    const mono = new Float32Array(len);
    for (let i = 0; i < len; i++) mono[i] = ((channelL[i] || 0) + (channelR[i] || 0)) * 0.5;

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

    // Pipeline principal
    const shifted = processChunked(mono, semitones, sampleRate, trackIndex);

    // Chorus stéréo
    const profile = LAYER_PROFILES[trackIndex] || LAYER_PROFILES[2];
    self.postMessage({ id, type: 'progress', label: 'Chorus stéréo...' });
    const chorus = applyChorusStereo(shifted, sampleRate, profile.chorusDepth, profile.chorusRate, (trackIndex || 2) * 7919);

    outLen = shifted.length;

    // Pan sur chaque canal
    const gp = applyGainPanStereo(chorus.outL, chorus.outR, outLen, gain, pan);

    self.postMessage({ id, type: 'progress', label: 'Encodage WAV...' });
    const wavBuf = audioToWav(gp.outL, gp.outR, sampleRate);
    self.postMessage({ id, type: 'done', wavBuf }, [wavBuf]);

  } catch(err) {
    self.postMessage({ id, type: 'error', message: err.message || String(err) });
  }
};
