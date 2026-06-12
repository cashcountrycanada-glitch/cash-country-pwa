// fx-worker.js v4 — Studio Pro
// Améliorations vs v3 :
//   1. De-esser dynamique fréquentiel (6-9kHz) — contrôle les sibilantes
//   2. Compresseur avec ballistic detection (peak + RMS blend)
//   3. Reverb avec HF damping — decay naturel, pas brillant artificiel
//   4. Auto-Tune avec YIN pitch detection (depuis harmony-worker)

// ── High-Pass Filter Butterworth 2nd order ───────────────────────────────
function applyHPF(data, fcHz, sr) {
  if (fcHz <= 0) return data;
  const wc = 2*Math.PI*fcHz/sr, k = Math.tan(wc/2);
  const norm = 1/(1+Math.SQRT2*k+k*k);
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
  if (Math.abs(gainDB) < 0.3) return data;
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
// Mesure l'énergie dans la bande sibilante (6-9kHz) par blocs
// Si elle dépasse le seuil → applique une atténuation ciblée
// Beaucoup plus naturel qu'un EQ fixe
function applyDeEsser(data, sr, thresholdDB, freqHz, bwHz, maxCutDB) {
  thresholdDB = thresholdDB || -20;
  freqHz      = freqHz      || 7500;
  bwHz        = bwHz        || 2500;
  maxCutDB    = maxCutDB    || -6;

  const blockSize = Math.floor(sr * 0.005); // blocs 5ms
  const out = new Float32Array(data.length);

  // Filtre passe-bande sur la bande sibilante pour mesure
  const fLow  = freqHz - bwHz/2;
  const fHigh = freqHz + bwHz/2;

  // Filtre simple pour isoler la bande sibilante
  const bandpass = (x, fc1, fc2, srr) => {
    // 2 filtres first-order en cascade
    const rc1 = 1/(2*Math.PI*fc1), rc2 = 1/(2*Math.PI*fc2), dt = 1/srr;
    const a1 = rc1/(rc1+dt), a2 = dt/(rc2+dt);
    const filtered = new Float32Array(x.length);
    let hp=0, lp=0;
    for (let i=0;i<x.length;i++) {
      hp = a1*(hp+x[i]-(i>0?x[i-1]:0));
      lp = lp + a2*(hp-lp);
      filtered[i] = lp;
    }
    return filtered;
  };

  const sibilant = bandpass(data, fLow, fHigh, sr);
  const thresh   = Math.pow(10, thresholdDB/20);
  const maxCut   = Math.pow(10, maxCutDB/20);

  for (let b=0; b*blockSize<data.length; b++) {
    const start=b*blockSize, end=Math.min(start+blockSize, data.length);
    // RMS de la bande sibilante dans ce bloc
    let energy=0;
    for (let i=start;i<end;i++) energy+=sibilant[i]*sibilant[i];
    const rms = Math.sqrt(energy/(end-start));
    // Calcul du gain de réduction
    let gain = 1.0;
    if (rms > thresh) {
      const excess = rms/thresh;
      // Réduction proportionnelle : plus l'excès est grand, plus on coupe
      gain = Math.max(maxCut, 1/excess);
    }
    for (let i=start;i<end;i++) out[i]=data[i]*gain;
  }
  return out;
}

// ── Compresseur avec ballistic detection (peak + RMS blend) ─────────────
// Standard industrie : peak detection pour les transitoires, RMS pour la tenue
// blend=0 → pure RMS (doux), blend=1 → pure peak (rapide)
function compress(data, threshold, ratio, attackMs, releaseMs, sr, kneeDb, blend) {
  if (ratio<=1.0) return data;
  blend = blend !== undefined ? blend : 0.5; // 50/50 par défaut
  const out=new Float32Array(data.length);
  const aC=Math.exp(-1/Math.max(1,sr*attackMs/1000));
  const rC=Math.exp(-1/Math.max(1,sr*releaseMs/1000));
  // RMS : constante de temps plus longue
  const rmsC=Math.exp(-1/Math.max(1,sr*Math.max(attackMs*3,30)/1000));
  const tL=Math.pow(10,threshold/20);
  const slope=1-1/ratio;
  const knee=Math.max(0,kneeDb||6);
  const kL=knee>0?Math.pow(10,(threshold-knee/2)/20):tL;
  const kH=knee>0?Math.pow(10,(threshold+knee/2)/20):tL;
  let envPeak=0, envRms=0, rmsSq=0;
  for (let i=0;i<data.length;i++) {
    const lv=Math.abs(data[i]);
    // Peak envelope
    envPeak = lv>envPeak ? 1-(1-envPeak)*aC : envPeak*rC;
    // RMS envelope
    rmsSq = rmsSq*rmsC + lv*lv*(1-rmsC);
    envRms = Math.sqrt(Math.max(0,rmsSq));
    // Blend peak + RMS
    const e=Math.max(1e-6, envPeak*blend + envRms*(1-blend));
    let gDB=0;
    if (knee>0&&e>kL&&e<kH) {
      const t=(20*Math.log10(e/tL)+knee/2)/knee;
      gDB=-slope*(20*Math.log10(e/tL)+knee/2)*t*0.5;
    } else if (e>=kH) {
      gDB=-slope*(20*Math.log10(e/tL));
    }
    out[i]=data[i]*Math.pow(10,gDB/20);
  }
  // Makeup gain avec plafonnement
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

// ── Auto-Tune avec YIN pitch detection ───────────────────────────────────
// YIN est beaucoup plus précis que l'autocorrélation simple
function detectF0_YIN(frame, sr) {
  const N=frame.length, tauMax=Math.min(N>>1,Math.floor(sr/60)), tauMin=Math.floor(sr/1000);
  const d=new Float32Array(tauMax+1);
  for (let tau=1;tau<=tauMax;tau++) {
    let sum=0;
    for (let j=0;j<tauMax;j++) { const diff=frame[j]-(j+tau<N?frame[j+tau]:0); sum+=diff*diff; }
    d[tau]=sum;
  }
  const cmndf=new Float32Array(tauMax+1); cmndf[0]=1; let runSum=0;
  for (let tau=1;tau<=tauMax;tau++) {
    runSum+=d[tau]; cmndf[tau]=runSum>0?d[tau]*tau/runSum:1;
  }
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
  for (let oct=2;oct<=6;oct++)
    for (let n=0;n<12;n++) noteFreqs.push(110*Math.pow(2,(oct-2)+n/12));
  const findNearest=freq=>{
    let best=noteFreqs[0],bestD=Infinity;
    for (const f of noteFreqs) { const d=Math.abs(Math.log2(freq/f)); if(d<bestD){bestD=d;best=f;} }
    return best;
  };
  const frameSize=Math.floor(sr*0.025);
  const hopSize=Math.max(32,Math.floor(sr*speedMs/1000/4));
  const out=new Float32Array(data.length);
  let pitchRatio=1.0;
  let cachedF0=0, frameIdx=0;
  const smoothK=Math.exp(-hopSize/(sr*speedMs/1000));
  for (let pos=0;pos<data.length;pos+=hopSize) {
    const end=Math.min(pos+hopSize,data.length);
    // YIN throttlé toutes les 40 frames (~930ms) — économie CPU ×40
    if (frameIdx % 40 === 0 && pos+frameSize<data.length) {
      const frame=data.slice(pos,pos+frameSize);
      cachedF0=detectF0_YIN(frame,sr);
    }
    frameIdx++;
    if (cachedF0>60&&cachedF0<1200) {
      const target=findNearest(cachedF0);
      pitchRatio=pitchRatio*smoothK+(target/cachedF0)*(1-smoothK);
    }
    const applied=1+(pitchRatio-1)*strength;
    for (let i=pos;i<end;i++) {
      const srcPos=pos+(i-pos)*applied;
      const idx=Math.min(Math.floor(srcPos),data.length-2);
      const frac=srcPos-Math.floor(srcPos);
      out[i]=(data[idx]+(data[Math.min(idx+1,data.length-1)]-data[idx])*frac)*strength+data[i]*(1-strength);
    }
  }
  return out;
}

// ── Saturation analogique tube asymétrique ───────────────────────────────
function saturate(data, amount) {
  if (amount<=0) return data;
  const k=amount*200, out=new Float32Array(data.length);
  for (let i=0;i<data.length;i++)
    out[i]=(1+k/100)*data[i]/(1+k/100*Math.abs(data[i]));
  return out;
}

// ── Reverb Schroeder avec HF damping ────────────────────────────────────
// HF damping : filtre passe-bas dans chaque comb filter
// Simule l'absorption des hautes fréquences dans une vraie salle
// Sans ça, la reverb sonne "digital" et trop brillante
function reverb(dL, dR, type, mix, sr) {
  if (type==='none'||mix<=0) return {L:dL,R:dR};
  const len=dL.length;
  const cfgs = {
    room:  { preDelayMs:8,  combDelays:[0.0297,0.0350,0.0411,0.0437], combGains:[0.80,0.81,0.78,0.77], apDelays:[0.0127,0.0090], apGains:[0.65,0.65], hfDamping:0.45 },
    hall:  { preDelayMs:18, combDelays:[0.0351,0.0400,0.0453,0.0487], combGains:[0.83,0.84,0.81,0.80], apDelays:[0.0150,0.0105], apGains:[0.68,0.68], hfDamping:0.55 },
    plate: { preDelayMs:5,  combDelays:[0.0253,0.0300,0.0357,0.0390], combGains:[0.77,0.78,0.75,0.74], apDelays:[0.0100,0.0075], apGains:[0.60,0.60], hfDamping:0.30 },
  };
  const cfg=cfgs[type]||cfgs.room;
  const preD=Math.max(1,Math.floor(cfg.preDelayMs*sr/1000));
  const preBufL=new Float32Array(preD), preBufR=new Float32Array(preD);
  let prePtr=0;
  const numCombs=cfg.combDelays.length;
  const combBufsL=cfg.combDelays.map(d=>new Float32Array(Math.floor(d*sr)));
  const combBufsR=cfg.combDelays.map((d,i)=>new Float32Array(Math.floor(d*sr*(i%2===0?1.013:0.988))));
  const combPtrsL=new Int32Array(numCombs), combPtrsR=new Int32Array(numCombs);
  // États du filtre HF damping pour chaque comb (LP simple 1er ordre)
  const dampStateL=new Float32Array(numCombs), dampStateR=new Float32Array(numCombs);
  const numAP=cfg.apDelays.length;
  const apBufsL=cfg.apDelays.map(d=>new Float32Array(Math.floor(d*sr)));
  const apBufsR=cfg.apDelays.map(d=>new Float32Array(Math.floor(d*sr)));
  const apPtrsL=new Int32Array(numAP), apPtrsR=new Int32Array(numAP);
  const wetL=new Float32Array(len), wetR=new Float32Array(len);
  const d=cfg.hfDamping; // coefficient damping (0=aucun, 1=maximum)

  for (let i=0;i<len;i++) {
    const pdL=preBufL[prePtr], pdR=preBufR[prePtr];
    preBufL[prePtr]=dL[i]||0; preBufR[prePtr]=dR[i]||0;
    prePtr=(prePtr+1)%preD;
    let combOutL=0, combOutR=0;
    for (let c=0;c<numCombs;c++) {
      const dlyL=combBufsL[c].length, dlyR=combBufsR[c].length;
      const pL=combPtrsL[c], pR=combPtrsR[c];
      const delL=combBufsL[c][pL], delR=combBufsR[c][pR];
      // HF damping : LP 1er ordre dans le loop du comb
      dampStateL[c]=delL*(1-d)+dampStateL[c]*d;
      dampStateR[c]=delR*(1-d)+dampStateR[c]*d;
      combBufsL[c][pL]=pdL+dampStateL[c]*cfg.combGains[c];
      combBufsR[c][pR]=pdR+dampStateR[c]*cfg.combGains[c];
      combPtrsL[c]=(pL+1)%dlyL; combPtrsR[c]=(pR+1)%dlyR;
      combOutL+=delL; combOutR+=delR;
    }
    combOutL/=numCombs; combOutR/=numCombs;
    let apL=combOutL, apR=combOutR;
    for (let a=0;a<numAP;a++) {
      const dlyL=apBufsL[a].length;
      const pL=apPtrsL[a], pR=apPtrsR[a];
      const delL=apBufsL[a][pL], delR=apBufsR[a][pR];
      const inL=apL+delL*cfg.apGains[a], inR=apR+delR*cfg.apGains[a];
      apBufsL[a][pL]=inL; apBufsR[a][pR]=inR;
      apPtrsL[a]=(pL+1)%dlyL; apPtrsR[a]=(pR+1)%dlyL;
      apL=delL-cfg.apGains[a]*inL; apR=delR-cfg.apGains[a]*inR;
    }
    wetL[i]=apL; wetR[i]=apR;
  }
  let peak=0;
  for (let i=0;i<len;i++) peak=Math.max(peak,Math.abs(wetL[i]),Math.abs(wetR[i]));
  if (peak>1.0) { const n=1.0/peak; for(let i=0;i<len;i++){wetL[i]*=n;wetR[i]*=n;} }
  const outL=new Float32Array(len), outR=new Float32Array(len);
  for (let i=0;i<len;i++) {
    outL[i]=dL[i]*(1-mix)+wetL[i]*mix;
    outR[i]=dR[i]*(1-mix)+wetR[i]*mix;
  }
  return {L:outL,R:outR};
}

// ── WAV ───────────────────────────────────────────────────────────────────
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

    // 1. EQ (HPF + 5 bandes paramétriques)
    self.postMessage({id,type:'progress',pct:10,label:'EQ...'});
    pL=applyEQChain(pL,fx,sampleRate);
    pR=applyEQChain(pR,fx,sampleRate);

    // 2. De-esser dynamique — avant la compression pour ne pas amplifier les sibilantes
    self.postMessage({id,type:'progress',pct:20,label:'De-esser...'});
    pL=applyDeEsser(pL,sampleRate,-20,7500,2500,-6);
    pR=applyDeEsser(pR,sampleRate,-20,7500,2500,-6);

    // 3. Compression avec ballistic detection (peak+RMS blend)
    self.postMessage({id,type:'progress',pct:35,label:'Compression...'});
    pL=compress(pL,fx.compThreshold,fx.compRatio,fx.compAttack,fx.compRelease,sampleRate,fx.compKnee,0.6);
    pR=compress(pR,fx.compThreshold,fx.compRatio,fx.compAttack,fx.compRelease,sampleRate,fx.compKnee,0.6);

    // 4. Auto-Tune YIN (optionnel)
    self.postMessage({id,type:'progress',pct:50,label:'Auto-Tune...'});
    if ((fx.autotune||0)>0) {
      const speedMs=fx.autotuneSpeed==='fast'?30:fx.autotuneSpeed==='medium'?80:150;
      pL=autotune(pL,fx.autotune,speedMs,sampleRate);
      pR=autotune(pR,fx.autotune,speedMs,sampleRate);
    }

    // 5. Saturation analogique
    self.postMessage({id,type:'progress',pct:65,label:'Saturation...'});
    pL=saturate(pL,fx.saturation||0);
    pR=saturate(pR,fx.saturation||0);

    // 6. Reverb avec HF damping
    self.postMessage({id,type:'progress',pct:78,label:'Reverb...'});
    const rv=reverb(pL,pR,fx.reverb,fx.reverbMix,sampleRate);
    pL=rv.L; pR=rv.R;

    // 7. Normalisation finale
    let peak=0;
    for(let i=0;i<pL.length;i++) peak=Math.max(peak,Math.abs(pL[i]),Math.abs(pR[i]));
    if(peak>0.95){const n=0.95/peak;for(let i=0;i<pL.length;i++){pL[i]*=n;pR[i]*=n;}}

    self.postMessage({id,type:'progress',pct:92,label:'Encodage WAV...'});
    const wavBuf=toWav(pL,pR,sampleRate);
    self.postMessage({id,type:'done',wavBuf},[wavBuf]);
  } catch(err) {
    self.postMessage({id,type:'error',message:err.message||String(err)});
  }
};
