// fx-worker.js v6 — Reverb Schroeder/Moorer corrigée + chaîne FX

// ── High-Pass Filter Butterworth 2nd order ───────────────────────────────
function applyHPF(data, fcHz, sr) {
  if (fcHz <= 0) return data;
  const wc=2*Math.PI*fcHz/sr, k=Math.tan(wc/2);
  const norm=1/(1+Math.SQRT2*k+k*k);
  const b0=norm, b1=-2*norm, b2=norm;
  const a1=2*(k*k-1)*norm, a2=(1-Math.SQRT2*k+k*k)*norm;
  const out=new Float32Array(data.length);
  let x1=0,x2=0,y1=0,y2=0;
  for (let i=0;i<data.length;i++) {
    const x0=data[i], y0=b0*x0+b1*x1+b2*x2-a1*y1-a2*y2;
    out[i]=y0; x2=x1; x1=x0; y2=y1; y1=y0;
  }
  return out;
}

// ── EQ paramétrique biquad ───────────────────────────────────────────────
function applyEQBand(data, gainDB, type, fcHz, Q, sr) {
  if (Math.abs(gainDB)<0.3) return data;
  const A=Math.pow(10,gainDB/40), w0=2*Math.PI*fcHz/sr;
  const cosW=Math.cos(w0), sinW=Math.sin(w0), alpha=sinW/(2*Q);
  let b0,b1,b2,a0,a1,a2;
  if (type==='peak') {
    b0=1+alpha*A; b1=-2*cosW; b2=1-alpha*A;
    a0=1+alpha/A; a1=-2*cosW; a2=1-alpha/A;
  } else if (type==='lowShelf') {
    b0=A*((A+1)-(A-1)*cosW+2*Math.sqrt(A)*alpha);
    b1=2*A*((A-1)-(A+1)*cosW);
    b2=A*((A+1)-(A-1)*cosW-2*Math.sqrt(A)*alpha);
    a0=(A+1)+(A-1)*cosW+2*Math.sqrt(A)*alpha;
    a1=-2*((A-1)+(A+1)*cosW);
    a2=(A+1)+(A-1)*cosW-2*Math.sqrt(A)*alpha;
  } else {
    b0=A*((A+1)+(A-1)*cosW+2*Math.sqrt(A)*alpha);
    b1=-2*A*((A-1)+(A+1)*cosW);
    b2=A*((A+1)+(A-1)*cosW-2*Math.sqrt(A)*alpha);
    a0=(A+1)-(A-1)*cosW+2*Math.sqrt(A)*alpha;
    a1=2*((A-1)-(A+1)*cosW);
    a2=(A+1)-(A-1)*cosW-2*Math.sqrt(A)*alpha;
  }
  const out=new Float32Array(data.length);
  let x1=0,x2=0,y1=0,y2=0;
  for (let i=0;i<data.length;i++) {
    const x0=data[i], y0=(b0*x0+b1*x1+b2*x2-a1*y1-a2*y2)/a0;
    out[i]=y0; x2=x1; x1=x0; y2=y1; y1=y0;
  }
  return out;
}

function applyEQChain(data, fx, sr) {
  let s=data;
  if ((fx.hpf||0)>0) s=applyHPF(s,fx.hpf,sr);
  if (Math.abs(fx.lowGain||0)>=0.3) s=applyEQBand(s,fx.lowGain,'lowShelf',200,0.707,sr);
  if (Math.abs(fx.lowMidGain||0)>=0.3) s=applyEQBand(s,fx.lowMidGain,'peak',300,1.2,sr);
  if (Math.abs(fx.midGain||0)>=0.3) s=applyEQBand(s,fx.midGain,'peak',3000,1.0,sr);
  if (Math.abs(fx.highGain||0)>=0.3) s=applyEQBand(s,fx.highGain,'highShelf',8000,0.707,sr);
  if (Math.abs(fx.airGain||0)>=0.3) s=applyEQBand(s,fx.airGain,'peak',12000,0.8,sr);
  return s;
}

// ── De-esser dynamique ────────────────────────────────────────────────────
function applyDeEsser(data, sr, thresholdDB, freqHz, bwHz, maxCutDB) {
  thresholdDB=thresholdDB||-20; freqHz=freqHz||7500; bwHz=bwHz||2500; maxCutDB=maxCutDB||-6;
  const blockSize=Math.floor(sr*0.005);
  const out=new Float32Array(data.length);
  const fLow=freqHz-bwHz/2, fHigh=freqHz+bwHz/2;
  const bandpass=(x,fc1,fc2,srr)=>{
    const rc1=1/(2*Math.PI*fc1), rc2=1/(2*Math.PI*fc2), dt=1/srr;
    const a1=rc1/(rc1+dt), a2=dt/(rc2+dt);
    const filtered=new Float32Array(x.length); let hp=0,lp=0;
    for (let i=0;i<x.length;i++) {
      hp=a1*(hp+x[i]-(i>0?x[i-1]:0));
      lp=lp+a2*(hp-lp); filtered[i]=lp;
    }
    return filtered;
  };
  const sibilant=bandpass(data,fLow,fHigh,sr);
  const thresh=Math.pow(10,thresholdDB/20), maxCut=Math.pow(10,maxCutDB/20);
  for (let b=0;b*blockSize<data.length;b++) {
    const start=b*blockSize, end=Math.min(start+blockSize,data.length);
    let energy=0;
    for (let i=start;i<end;i++) energy+=sibilant[i]*sibilant[i];
    const rms=Math.sqrt(energy/(end-start));
    const gain=rms>thresh?Math.max(maxCut,1/(rms/thresh)):1.0;
    for (let i=start;i<end;i++) out[i]=data[i]*gain;
  }
  return out;
}

// ── Compresseur ────────────────────────────────────────────────────────
function compress(data, threshold, ratio, attackMs, releaseMs, sr, kneeDb, blend) {
  if (ratio<=1.0) return data;
  blend=blend!==undefined?blend:0.5;
  const out=new Float32Array(data.length);
  const aC=Math.exp(-1/Math.max(1,sr*attackMs/1000));
  const rC=Math.exp(-1/Math.max(1,sr*releaseMs/1000));
  const rmsC=Math.exp(-1/Math.max(1,sr*Math.max(attackMs*3,30)/1000));
  const tL=Math.pow(10,threshold/20), slope=1-1/ratio;
  const knee=Math.max(0,kneeDb||6);
  const kL=knee>0?Math.pow(10,(threshold-knee/2)/20):tL;
  const kH=knee>0?Math.pow(10,(threshold+knee/2)/20):tL;
  let envPeak=0,envRms=0,rmsSq=0;
  for (let i=0;i<data.length;i++) {
    const lv=Math.abs(data[i]);
    envPeak=lv>envPeak?1-(1-envPeak)*aC:envPeak*rC;
    rmsSq=rmsSq*rmsC+lv*lv*(1-rmsC); envRms=Math.sqrt(Math.max(0,rmsSq));
    const e=Math.max(1e-6,envPeak*blend+envRms*(1-blend));
    let gDB=0;
    if (knee>0&&e>kL&&e<kH) { const t=(20*Math.log10(e/tL)+knee/2)/knee; gDB=-slope*(20*Math.log10(e/tL)+knee/2)*t*0.5; }
    else if (e>=kH) gDB=-slope*(20*Math.log10(e/tL));
    out[i]=data[i]*Math.pow(10,gDB/20);
  }
  if (threshold<0&&ratio>1) {
    const makeupDB=(-threshold)*(1-1/ratio)*0.35;
    const makeupLin=Math.pow(10,makeupDB/20);
    for (let i=0;i<out.length;i++) out[i]*=makeupLin;
    let peak=0;
    for (let i=0;i<out.length;i++) { const a=Math.abs(out[i]); if(a>peak) peak=a; }
    if (peak>0.92) { const n=0.92/peak; for(let i=0;i<out.length;i++) out[i]*=n; }
  }
  return out;
}

// ── YIN pitch detection ───────────────────────────────────────────────────
function detectF0_YIN(frame, sr) {
  const N=frame.length, tauMax=Math.min(N>>1,Math.floor(sr/60)), tauMin=Math.floor(sr/1000);
  const d=new Float32Array(tauMax+1);
  for (let tau=1;tau<=tauMax;tau++) {
    let sum=0;
    for (let j=0;j<tauMax;j++) { const diff=frame[j]-(j+tau<N?frame[j+tau]:0); sum+=diff*diff; }
    d[tau]=sum;
  }
  const cmndf=new Float32Array(tauMax+1); cmndf[0]=1; let runSum=0;
  for (let tau=1;tau<=tauMax;tau++) { runSum+=d[tau]; cmndf[tau]=runSum>0?d[tau]*tau/runSum:1; }
  for (let tau=tauMin;tau<=tauMax;tau++) {
    if (cmndf[tau]<0.10) {
      if (tau>0&&tau<tauMax) {
        const s0=cmndf[tau-1],s1=cmndf[tau],s2=cmndf[tau+1];
        return sr/(tau+(s2-s0)/(2*(2*s1-s0-s2)));
      }
      return sr/tau;
    }
  }
  return 0;
}

function autotune(data, strength, speedMs, sr) {
  if (strength<=0) return data;
  const noteFreqs=[];
  for (let oct=2;oct<=6;oct++) for (let n=0;n<12;n++) noteFreqs.push(110*Math.pow(2,(oct-2)+n/12));
  const findNearest=freq=>{ let best=noteFreqs[0],bestD=Infinity; for (const f of noteFreqs) { const d=Math.abs(Math.log2(freq/f)); if(d<bestD){bestD=d;best=f;} } return best; };
  const frameSize=Math.floor(sr*0.025), hopSize=Math.max(32,Math.floor(sr*speedMs/1000/4));
  const out=new Float32Array(data.length); let pitchRatio=1.0, cachedF0=0, frameIdx=0;
  const smoothK=Math.exp(-hopSize/(sr*speedMs/1000));
  for (let pos=0;pos<data.length;pos+=hopSize) {
    const end=Math.min(pos+hopSize,data.length);
    if (frameIdx%40===0&&pos+frameSize<data.length) { cachedF0=detectF0_YIN(data.slice(pos,pos+frameSize),sr); }
    frameIdx++;
    if (cachedF0>60&&cachedF0<1200) { const target=findNearest(cachedF0); pitchRatio=pitchRatio*smoothK+(target/cachedF0)*(1-smoothK); }
    const applied=1+(pitchRatio-1)*strength;
    for (let i=pos;i<end;i++) {
      const srcPos=pos+(i-pos)*applied, idx=Math.min(Math.floor(srcPos),data.length-2), frac=srcPos-Math.floor(srcPos);
      out[i]=(data[idx]+(data[Math.min(idx+1,data.length-1)]-data[idx])*frac)*strength+data[i]*(1-strength);
    }
  }
  return out;
}

// ── Saturation analogique tube ────────────────────────────────────────────
function saturate(data, amount) {
  if (amount<=0) return data;
  const k=amount*200, out=new Float32Array(data.length);
  for (let i=0;i<data.length;i++) out[i]=(1+k/100)*data[i]/(1+k/100*Math.abs(data[i]));
  return out;
}

// ── Reverb Schroeder/Moorer corrigée — 4 combs + 2 allpass par canal ────
// Architecture classique mais fiable, réponse audible garantie.
// Stéréo naturel : délais légèrement différents L/R.
//
// Bug v5 corrigé : les taps Dattorro lisaient aux mauvais offsets
// (pointeur déjà avancé). Cette implémentation utilise des délais
// circulaires simples avec lecture ARRIÈRE garantie.

function makeDelay(size) {
  return { buf: new Float32Array(size), ptr: 0, size };
}

function delayRead(d) {
  return d.buf[d.ptr];
}

function delayWrite(d, v) {
  d.buf[d.ptr] = v;
  d.ptr = (d.ptr + 1) % d.size;
}

function combFilter(d, input, feedback, damp) {
  // Schroeder comb with damping (lowpass in feedback loop)
  const delayed = delayRead(d);
  const filtered = delayed * (1 - damp) + (d._last || 0) * damp;
  d._last = filtered;
  delayWrite(d, input + filtered * feedback);
  return filtered;
}

function allpassFilter(d, input, coeff) {
  const delayed = delayRead(d);
  const out = -input * coeff + delayed;
  delayWrite(d, input + delayed * coeff);
  return out;
}

// Délais en ms (seront convertis en samples selon sr)
// L/R légèrement différents pour décorrélation stéréo naturelle
const COMB_DELAYS_MS = {
  L: [29.7, 37.1, 41.1, 43.7],
  R: [30.1, 37.5, 41.5, 44.1],
};
const ALLPASS_DELAYS_MS = {
  L: [5.0, 1.7],
  R: [5.1, 1.8],
};

const REVERB_PARAMS = {
  room:  { feedback: 0.76, damp: 0.35, preDelayMs: 8,  erDecay: 0.55 },
  hall:  { feedback: 0.82, damp: 0.25, preDelayMs: 22, erDecay: 0.70 },
  plate: { feedback: 0.78, damp: 0.45, preDelayMs: 4,  erDecay: 0.60 },
};

function reverbChannel(input, combDelays, apDelays, sr, params) {
  const len = input.length;
  const { feedback, damp, preDelayMs } = params;

  // Pre-delay
  const preD = Math.max(1, Math.round(preDelayMs * sr / 1000));
  const preBuf = new Float32Array(preD);
  let prePtr = 0;

  // 4 comb filters
  const combs = combDelays.map(ms => makeDelay(Math.round(ms * sr / 1000)));

  // 2 allpass filters
  const allpasses = apDelays.map(ms => makeDelay(Math.round(ms * sr / 1000)));

  const out = new Float32Array(len);

  for (let i = 0; i < len; i++) {
    // Pre-delay
    const preSig = preBuf[prePtr];
    preBuf[prePtr] = input[i];
    prePtr = (prePtr + 1) % preD;

    // 4 combs en parallèle
    let combSum = 0;
    for (const c of combs) {
      combSum += combFilter(c, preSig, feedback, damp);
    }
    combSum *= 0.25; // moyenne des 4 combs

    // 2 allpass en série
    let sig = combSum;
    for (const ap of allpasses) {
      sig = allpassFilter(ap, sig, 0.5);
    }

    out[i] = sig;
  }
  return out;
}

// Early reflections simples (7 taps) — définissent la taille perçue
function earlyReflections(input, sr, erDecay) {
  const tapsMs = [5.0, 11.0, 17.3, 23.0, 31.7, 40.2, 55.0];
  const out = new Float32Array(input.length);
  for (let t = 0; t < tapsMs.length; t++) {
    const d = Math.round(tapsMs[t] * sr / 1000);
    const g = erDecay * Math.pow(0.75, t);
    for (let i = d; i < input.length; i++) {
      out[i] += input[i - d] * g;
    }
  }
  return out;
}

function reverb(dL, dR, type, mix, sr) {
  if (!type || type === 'none' || type === 'sec' || mix <= 0) return { L: dL, R: dR };

  const params = REVERB_PARAMS[type] || REVERB_PARAMS.room;
  const len = dL.length;

  // HPF sur signal entrant (coupe boue basse dans la reverb)
  const hpfRev = (sig) => applyHPF(sig, 120, sr);
  const inL = hpfRev(dL);
  const inR = hpfRev(dR);

  // Mixer légèrement L+R pour alimenter les deux canaux (évite reverb fantôme mono)
  const feedL = new Float32Array(len);
  const feedR = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    feedL[i] = inL[i] * 0.85 + inR[i] * 0.15;
    feedR[i] = inR[i] * 0.85 + inL[i] * 0.15;
  }

  // Early reflections
  const erL = earlyReflections(feedL, sr, params.erDecay);
  const erR = earlyReflections(feedR, sr, params.erDecay);

  // Comb + allpass par canal (délais différents L/R)
  const wetL = reverbChannel(feedL, COMB_DELAYS_MS.L, ALLPASS_DELAYS_MS.L, sr, params);
  const wetR = reverbChannel(feedR, COMB_DELAYS_MS.R, ALLPASS_DELAYS_MS.R, sr, params);

  // Normaliser wet
  let peakW = 0;
  for (let i = 0; i < len; i++) peakW = Math.max(peakW, Math.abs(wetL[i]), Math.abs(wetR[i]));
  // Normaliser ER séparément
  let peakER = 0;
  for (let i = 0; i < len; i++) peakER = Math.max(peakER, Math.abs(erL[i]), Math.abs(erR[i]));

  const nW = peakW > 0.001 ? 1.0 / peakW : 0;
  const nER = peakER > 0.001 ? 0.6 / peakER : 0;

  // Mix final : dry*(1-mix) + (wet*0.7 + er*0.3)*mix
  const outL = new Float32Array(len);
  const outR = new Float32Array(len);
  const erAmt = 0.30;
  for (let i = 0; i < len; i++) {
    const wL = wetL[i] * nW * (1 - erAmt) + erL[i] * nER * erAmt;
    const wR = wetR[i] * nW * (1 - erAmt) + erR[i] * nER * erAmt;
    outL[i] = dL[i] * (1 - mix) + wL * mix;
    outR[i] = dR[i] * (1 - mix) + wR * mix;
  }
  return { L: outL, R: outR };
}

// ── WAV encoder ───────────────────────────────────────────────────────────
function toWav(chL, chR, sr) {
  const n=chL.length, dl=n*4, buf=new ArrayBuffer(44+dl), v=new DataView(buf);
  const ws=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  ws(0,'RIFF');v.setUint32(4,36+dl,true);ws(8,'WAVE');ws(12,'fmt ');
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,2,true);
  v.setUint32(24,sr,true);v.setUint32(28,sr*4,true);v.setUint16(32,4,true);v.setUint16(34,16,true);
  ws(36,'data');v.setUint32(40,dl,true);
  let off=44;
  for(let i=0;i<n;i++){
    const sL=Math.max(-1,Math.min(1,chL[i]||0)), sR=Math.max(-1,Math.min(1,chR[i]||0));
    v.setInt16(off,sL<0?sL*0x8000:sL*0x7FFF,true);off+=2;
    v.setInt16(off,sR<0?sR*0x8000:sR*0x7FFF,true);off+=2;
  }
  return buf;
}

// ── Main ──────────────────────────────────────────────────────────────────
self.onmessage = function(e) {
  const {id,channelL,channelR,sampleRate,fx}=e.data;
  try {
    let pL=new Float32Array(channelL), pR=new Float32Array(channelR);
    self.postMessage({id,type:'progress',pct:8,  label:'EQ...'});
    pL=applyEQChain(pL,fx,sampleRate); pR=applyEQChain(pR,fx,sampleRate);
    self.postMessage({id,type:'progress',pct:18, label:'De-esser...'});
    if ((fx.compRatio||1) > 1 || (fx.highGain||0) !== 0) {
      pL=applyDeEsser(pL,sampleRate,-20,7500,2500,-6);
      pR=applyDeEsser(pR,sampleRate,-20,7500,2500,-6);
    }
    self.postMessage({id,type:'progress',pct:32, label:'Compression...'});
    pL=compress(pL,fx.compThreshold,fx.compRatio,fx.compAttack,fx.compRelease,sampleRate,fx.compKnee,0.6);
    pR=compress(pR,fx.compThreshold,fx.compRatio,fx.compAttack,fx.compRelease,sampleRate,fx.compKnee,0.6);
    self.postMessage({id,type:'progress',pct:48, label:'Auto-Tune...'});
    if ((fx.autotune||0)>0) {
      const speedMs=fx.autotuneSpeed==='fast'?30:fx.autotuneSpeed==='medium'?80:150;
      pL=autotune(pL,fx.autotune,speedMs,sampleRate);
      pR=autotune(pR,fx.autotune,speedMs,sampleRate);
    }
    self.postMessage({id,type:'progress',pct:60, label:'Saturation...'});
    pL=saturate(pL,fx.saturation||0); pR=saturate(pR,fx.saturation||0);
    self.postMessage({id,type:'progress',pct:72, label:'Reverb...'});
    const rv=reverb(pL,pR,fx.reverb,fx.reverbMix,sampleRate);
    pL=rv.L; pR=rv.R;
    // Limiteur final doux
    let peak=0;
    for(let i=0;i<pL.length;i++) peak=Math.max(peak,Math.abs(pL[i]),Math.abs(pR[i]));
    if(peak>0.95){const n=0.95/peak;for(let i=0;i<pL.length;i++){pL[i]*=n;pR[i]*=n;}}
    self.postMessage({id,type:'progress',pct:92, label:'Encodage WAV...'});
    const wavBuf=toWav(pL,pR,sampleRate);
    self.postMessage({id,type:'done',wavBuf},[wavBuf]);
  } catch(err) {
    self.postMessage({id,type:'error',message:err.message||String(err)});
  }
};
