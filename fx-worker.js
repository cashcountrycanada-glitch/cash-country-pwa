// fx-worker.js v3 — EQ pro 4 bandes + HPF + Compresseur avec makeup + Reverb améliorée

// ── High-Pass Filter (coupe-bas) ─────────────────────────────────────────
// Élimine les fréquences sous fcHz — essentiel sur toute voix pro
// Butterworth 2nd order pour une coupure nette sans phase trop marquée
function applyHPF(data, fcHz, sr) {
  if (fcHz <= 0) return data;
  const wc  = 2 * Math.PI * fcHz / sr;
  const k   = Math.tan(wc / 2);
  const norm = 1 / (1 + Math.SQRT2 * k + k * k);
  const b0  =  norm;
  const b1  = -2 * norm;
  const b2  =  norm;
  const a1  = 2 * (k * k - 1) * norm;
  const a2  = (1 - Math.SQRT2 * k + k * k) * norm;
  const out = new Float32Array(data.length);
  let x1=0,x2=0,y1=0,y2=0;
  for (let i=0;i<data.length;i++) {
    const x0 = data[i];
    const y0  = b0*x0 + b1*x1 + b2*x2 - a1*y1 - a2*y2;
    out[i]=y0; x2=x1; x1=x0; y2=y1; y1=y0;
  }
  return out;
}

// ── EQ paramétrique 4 bandes ─────────────────────────────────────────────
// Bande 'low'    : shelving graves à 200Hz   (avant: gain flat, maintenant vrai shelving)
// Bande 'low_mid': peak bell à 300Hz         (NEW — coupe la boue vocale)
// Bande 'mid'    : peak bell à 3000Hz        (présence/intelligibilité)
// Bande 'high'   : shelving aigus à 8000Hz   (air et brillance)
// Bande 'air'    : peak bell à 12000Hz       (NEW — air de studio)
function applyEQBand(data, gainDB, type, fcHz, Q, sr) {
  if (Math.abs(gainDB) < 0.3) return data;
  const A   = Math.pow(10, gainDB / 40); // amplitude = 10^(dB/40)
  const w0  = 2 * Math.PI * fcHz / sr;
  const cosW= Math.cos(w0);
  const sinW= Math.sin(w0);
  const alpha = sinW / (2 * Q);
  let b0,b1,b2,a0,a1,a2;

  if (type === 'peak') {
    // Peak (bell) EQ
    b0 =  1 + alpha * A;
    b1 = -2 * cosW;
    b2 =  1 - alpha * A;
    a0 =  1 + alpha / A;
    a1 = -2 * cosW;
    a2 =  1 - alpha / A;
  } else if (type === 'lowShelf') {
    // Low shelving
    b0 =    A*((A+1)-(A-1)*cosW + 2*Math.sqrt(A)*alpha);
    b1 =  2*A*((A-1)-(A+1)*cosW);
    b2 =    A*((A+1)-(A-1)*cosW - 2*Math.sqrt(A)*alpha);
    a0 =       (A+1)+(A-1)*cosW + 2*Math.sqrt(A)*alpha;
    a1 =   -2*((A-1)+(A+1)*cosW);
    a2 =       (A+1)+(A-1)*cosW - 2*Math.sqrt(A)*alpha;
  } else {
    // High shelving
    b0 =    A*((A+1)+(A-1)*cosW + 2*Math.sqrt(A)*alpha);
    b1 = -2*A*((A-1)+(A+1)*cosW);
    b2 =    A*((A+1)+(A-1)*cosW - 2*Math.sqrt(A)*alpha);
    a0 =       (A+1)-(A-1)*cosW + 2*Math.sqrt(A)*alpha;
    a1 =    2*((A-1)-(A+1)*cosW);
    a2 =       (A+1)-(A-1)*cosW - 2*Math.sqrt(A)*alpha;
  }

  const out = new Float32Array(data.length);
  let x1=0,x2=0,y1=0,y2=0;
  for (let i=0;i<data.length;i++) {
    const x0=data[i];
    const y0=(b0*x0+b1*x1+b2*x2-a1*y1-a2*y2)/a0;
    out[i]=y0; x2=x1; x1=x0; y2=y1; y1=y0;
  }
  return out;
}

// Chaîne EQ complète : HPF + 4 bandes paramétriques
// fx.hpf        : fréquence de coupure HPF (Hz, 0=désactivé)
// fx.lowGain    : shelving graves 200Hz
// fx.lowMidGain : peak 300Hz (coupe boue)
// fx.midGain    : peak 3000Hz (présence)
// fx.highGain   : shelving aigus 8000Hz
// fx.airGain    : peak 12000Hz (air)
function applyEQChain(data, fx, sr) {
  let s = data;
  // HPF — toujours en premier
  if ((fx.hpf||0) > 0) s = applyHPF(s, fx.hpf, sr);
  // Shelving graves
  if (Math.abs(fx.lowGain||0) >= 0.3)
    s = applyEQBand(s, fx.lowGain, 'lowShelf', 200, 0.707, sr);
  // Peak boue 300Hz
  if (Math.abs(fx.lowMidGain||0) >= 0.3)
    s = applyEQBand(s, fx.lowMidGain, 'peak', 300, 1.2, sr);
  // Peak présence 3kHz
  if (Math.abs(fx.midGain||0) >= 0.3)
    s = applyEQBand(s, fx.midGain, 'peak', 3000, 1.0, sr);
  // Shelving aigus 8kHz
  if (Math.abs(fx.highGain||0) >= 0.3)
    s = applyEQBand(s, fx.highGain, 'highShelf', 8000, 0.707, sr);
  // Peak air 12kHz
  if (Math.abs(fx.airGain||0) >= 0.3)
    s = applyEQBand(s, fx.airGain, 'peak', 12000, 0.8, sr);
  return s;
}

// ── Compresseur avec makeup gain automatique ──────────────────────────────
function compress(data, threshold, ratio, attackMs, releaseMs, sr, kneeDb) {
  if (ratio <= 1.0) return data;
  const out  = new Float32Array(data.length);
  const aC   = Math.exp(-1/Math.max(1, sr*attackMs/1000));
  const rC   = Math.exp(-1/Math.max(1, sr*releaseMs/1000));
  const tL   = Math.pow(10, threshold/20);
  const slope= 1 - 1/ratio;
  const knee = Math.max(0, kneeDb||6);
  const kL   = knee>0 ? Math.pow(10,(threshold-knee/2)/20) : tL;
  const kH   = knee>0 ? Math.pow(10,(threshold+knee/2)/20) : tL;
  let env=0;
  for (let i=0;i<data.length;i++) {
    const lv=Math.abs(data[i]);
    env = lv>env ? 1-(1-env)*aC : env*rC;
    const e=Math.max(1e-6,env);
    let gDB=0;
    if (knee>0 && e>kL && e<kH) {
      const t=(20*Math.log10(e/tL)+knee/2)/knee;
      gDB=-slope*(20*Math.log10(e/tL)+knee/2)*t*0.5;
    } else if (e>=kH) {
      gDB=-slope*(20*Math.log10(e/tL));
    }
    out[i]=data[i]*Math.pow(10,gDB/20);
  }
  // Makeup gain automatique — compense la réduction de volume
  if (threshold < 0 && ratio > 1) {
    const makeupDB  = (-threshold) * (1 - 1/ratio) * 0.5;
    const makeupLin = Math.pow(10, makeupDB/20);
    for (let i=0;i<out.length;i++) out[i] *= makeupLin;
  }
  return out;
}

// ── Auto-Tune ─────────────────────────────────────────────────────────────
function autotune(data, strength, speedMs, sr) {
  if (strength<=0) return data;
  const noteFreqs=[];
  for (let oct=2;oct<=6;oct++)
    for (let n=0;n<12;n++)
      noteFreqs.push(110*Math.pow(2,(oct-2)+n/12));
  const findNearest=freq=>{
    let best=noteFreqs[0],bestD=Infinity;
    for (const f of noteFreqs) { const d=Math.abs(Math.log2(freq/f)); if(d<bestD){bestD=d;best=f;} }
    return best;
  };
  const frameSize=Math.floor(sr*0.025);
  const hopSize=Math.max(32,Math.floor(sr*speedMs/1000/4));
  const minP=Math.floor(sr/1200), maxP=Math.floor(sr/60);
  const out=new Float32Array(data.length);
  let pitchRatio=1.0;
  const smoothK=Math.exp(-hopSize/(sr*speedMs/1000));
  for (let pos=0;pos<data.length;pos+=hopSize) {
    const end=Math.min(pos+hopSize,data.length);
    if (pos+frameSize<data.length) {
      let bestCorr=0,bestPeriod=0;
      for (let period=minP;period<=maxP;period+=2) {
        let corr=0;
        const cEnd=Math.min(frameSize,data.length-pos-period);
        for (let i=0;i<cEnd;i+=2) corr+=data[pos+i]*data[pos+i+period];
        if (corr>bestCorr) {bestCorr=corr;bestPeriod=period;}
      }
      if (bestPeriod>0&&bestCorr>0.005) {
        const freq=sr/bestPeriod;
        if (freq>60&&freq<1200) {
          const target=findNearest(freq);
          pitchRatio=pitchRatio*smoothK+(target/freq)*(1-smoothK);
        }
      }
    }
    const applied=1+(pitchRatio-1)*strength;
    for (let i=pos;i<end;i++) {
      const srcPos=pos+(i-pos)*applied;
      const idx=Math.min(Math.floor(srcPos),data.length-2);
      const frac=srcPos-Math.floor(srcPos);
      const pitched=data[idx]+(data[Math.min(idx+1,data.length-1)]-data[idx])*frac;
      out[i]=pitched*strength+data[i]*(1-strength);
    }
  }
  return out;
}

// ── Saturation analogique ────────────────────────────────────────────────
// Soft-clip asymétrique — simule chaleur tube/ruban
function saturate(data, amount) {
  if (amount<=0) return data;
  const k=amount*200;
  const out=new Float32Array(data.length);
  for (let i=0;i<data.length;i++)
    out[i]=(1+k/100)*data[i]/(1+k/100*Math.abs(data[i]));
  return out;
}

// ── Reverb de salle Schroeder améliorée ──────────────────────────────────
// room  : pièce intimée, pre-delay 8ms,  decay court  → voix présente
// hall  : grande salle,  pre-delay 18ms, decay moyen  → voix spacieuse
// plate : reverb à plaque, pre-delay 5ms, decay moyen → voix lisse et brillante
function reverb(dL, dR, type, mix, sr) {
  if (type==='none'||mix<=0) return {L:dL,R:dR};
  const len=dL.length;

  const cfgs = {
    room:  { preDelayMs:8,  combDelays:[0.0297,0.0350,0.0411,0.0437], combGains:[0.80,0.81,0.78,0.77], apDelays:[0.0127,0.0090], apGains:[0.65,0.65] },
    hall:  { preDelayMs:18, combDelays:[0.0351,0.0400,0.0453,0.0487], combGains:[0.83,0.84,0.81,0.80], apDelays:[0.0150,0.0105], apGains:[0.68,0.68] },
    plate: { preDelayMs:5,  combDelays:[0.0253,0.0300,0.0357,0.0390], combGains:[0.77,0.78,0.75,0.74], apDelays:[0.0100,0.0075], apGains:[0.60,0.60] },
  };
  const cfg = cfgs[type] || cfgs.room;

  // Pre-delay
  const preD = Math.max(1, Math.floor(cfg.preDelayMs * sr / 1000));
  const preBufL=new Float32Array(preD), preBufR=new Float32Array(preD);
  let prePtr=0;

  // Comb filters (L et R légèrement décorrélés ±1.3%)
  const numCombs = cfg.combDelays.length;
  const combBufsL = cfg.combDelays.map(d => new Float32Array(Math.floor(d*sr)));
  const combBufsR = cfg.combDelays.map((d,i) => new Float32Array(Math.floor(d*sr*(i%2===0?1.013:0.988))));
  const combPtrsL = new Int32Array(numCombs);
  const combPtrsR = new Int32Array(numCombs);

  // Allpass filters
  const numAP = cfg.apDelays.length;
  const apBufsL = cfg.apDelays.map(d => new Float32Array(Math.floor(d*sr)));
  const apBufsR = cfg.apDelays.map(d => new Float32Array(Math.floor(d*sr)));
  const apPtrsL = new Int32Array(numAP);
  const apPtrsR = new Int32Array(numAP);

  const wetL=new Float32Array(len), wetR=new Float32Array(len);

  for (let i=0;i<len;i++) {
    // Pre-delay
    const pdL=preBufL[prePtr], pdR=preBufR[prePtr];
    preBufL[prePtr]=dL[i]||0; preBufR[prePtr]=dR[i]||0;
    prePtr=(prePtr+1)%preD;

    // Comb filters en parallèle
    let combOutL=0, combOutR=0;
    for (let c=0;c<numCombs;c++) {
      const dlyL=combBufsL[c].length, dlyR=combBufsR[c].length;
      const pL=combPtrsL[c], pR=combPtrsR[c];
      const delL=combBufsL[c][pL], delR=combBufsR[c][pR];
      combBufsL[c][pL]=pdL+delL*cfg.combGains[c];
      combBufsR[c][pR]=pdR+delR*cfg.combGains[c];
      combPtrsL[c]=(pL+1)%dlyL;
      combPtrsR[c]=(pR+1)%dlyR;
      combOutL+=delL; combOutR+=delR;
    }
    combOutL/=numCombs; combOutR/=numCombs;

    // Allpass en série
    let apL=combOutL, apR=combOutR;
    for (let a=0;a<numAP;a++) {
      const dlyL=apBufsL[a].length;
      const pL=apPtrsL[a], pR=apPtrsR[a];
      const delL=apBufsL[a][pL], delR=apBufsR[a][pR];
      const inL=apL+delL*cfg.apGains[a];
      const inR=apR+delR*cfg.apGains[a];
      apBufsL[a][pL]=inL; apBufsR[a][pR]=inR;
      apPtrsL[a]=(pL+1)%dlyL; apPtrsR[a]=(pR+1)%dlyL;
      apL=delL-cfg.apGains[a]*inL;
      apR=delR-cfg.apGains[a]*inR;
    }
    wetL[i]=apL; wetR[i]=apR;
  }

  // Normaliser wet
  let peak=0;
  for (let i=0;i<len;i++) peak=Math.max(peak,Math.abs(wetL[i]),Math.abs(wetR[i]));
  if (peak>1.0) { const n=1.0/peak; for(let i=0;i<len;i++){wetL[i]*=n;wetR[i]*=n;} }

  const outL=new Float32Array(len), outR=new Float32Array(len);
  for (let i=0;i<len;i++) {
    outL[i]=dL[i]*(1-mix)+wetL[i]*mix;
    outR[i]=dR[i]*(1-mix)+wetR[i]*mix;
  }
  return {L:outL, R:outR};
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

    // 1. EQ (HPF + 4 bandes paramétriques)
    self.postMessage({id,type:'progress',pct:10,label:'EQ...'});
    pL=applyEQChain(pL,fx,sampleRate);
    pR=applyEQChain(pR,fx,sampleRate);

    // 2. Compression avec makeup gain
    self.postMessage({id,type:'progress',pct:30,label:'Compression...'});
    pL=compress(pL,fx.compThreshold,fx.compRatio,fx.compAttack,fx.compRelease,sampleRate,fx.compKnee);
    pR=compress(pR,fx.compThreshold,fx.compRatio,fx.compAttack,fx.compRelease,sampleRate,fx.compKnee);

    // 3. Auto-Tune (optionnel)
    self.postMessage({id,type:'progress',pct:50,label:'Auto-Tune...'});
    const atStrength=fx.autotune||0;
    if (atStrength>0) {
      const speedMs=fx.autotuneSpeed==='fast'?30:fx.autotuneSpeed==='medium'?80:150;
      pL=autotune(pL,atStrength,speedMs,sampleRate);
      pR=autotune(pR,atStrength,speedMs,sampleRate);
    }

    // 4. Saturation analogique
    self.postMessage({id,type:'progress',pct:65,label:'Saturation...'});
    pL=saturate(pL,fx.saturation||0);
    pR=saturate(pR,fx.saturation||0);

    // 5. Reverb
    self.postMessage({id,type:'progress',pct:75,label:'Reverb...'});
    const rv=reverb(pL,pR,fx.reverb,fx.reverbMix,sampleRate);
    pL=rv.L; pR=rv.R;

    // 6. Normalisation finale
    let peak=0;
    for(let i=0;i<pL.length;i++) peak=Math.max(peak,Math.abs(pL[i]),Math.abs(pR[i]));
    if(peak>0.95){const n=0.95/peak;for(let i=0;i<pL.length;i++){pL[i]*=n;pR[i]*=n;}}

    self.postMessage({id,type:'progress',pct:90,label:'Encodage WAV...'});
    const wavBuf=toWav(pL,pR,sampleRate);
    self.postMessage({id,type:'done',wavBuf},[wavBuf]);
  } catch(err) {
    self.postMessage({id,type:'error',message:err.message||String(err)});
  }
};
