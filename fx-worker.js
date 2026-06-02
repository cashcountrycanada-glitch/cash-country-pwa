// fx-worker.js v2 — EQ + Compresseur + Auto-Tune + Saturation + Reverb + WAV

function applyEQ(data, gainDB, freq, sr) {
  if (Math.abs(gainDB) < 0.5) return data;
  const g = Math.pow(10, gainDB / 20);
  if (freq === 'mid') {
    const out = new Float32Array(data.length);
    for (let i=0;i<data.length;i++) out[i]=data[i]*g;
    return out;
  }
  const fc = freq==='low' ? 250/(sr/2) : 8000/(sr/2);
  const alpha = Math.exp(-2*Math.PI*fc);
  const out = new Float32Array(data.length);
  let lp = 0;
  for (let i=0;i<data.length;i++) {
    lp = alpha*lp + (1-alpha)*data[i];
    out[i] = freq==='low' ? lp*g+(data[i]-lp) : lp+(data[i]-lp)*g;
  }
  return out;
}

function compress(data, threshold, ratio, attackMs, releaseMs, sr, kneeDb) {
  if (ratio <= 1.0) return data;
  const out=new Float32Array(data.length);
  const aC=Math.exp(-1/Math.max(1,sr*attackMs/1000));
  const rC=Math.exp(-1/Math.max(1,sr*releaseMs/1000));
  const tL=Math.pow(10,threshold/20);
  const slope=1-1/ratio;
  const knee=Math.max(0, kneeDb||6); // knee en dB, 0=hard knee
  const kL=knee>0?Math.pow(10,(threshold-knee/2)/20):tL; // début du knee
  const kH=knee>0?Math.pow(10,(threshold+knee/2)/20):tL; // fin du knee
  let env=0;
  for (let i=0;i<data.length;i++) {
    const lv=Math.abs(data[i]);
    env=lv>env?1-(1-env)*aC:env*rC;
    const e=Math.max(1e-6,env);
    let gDB=0;
    if (knee>0 && e>kL && e<kH) {
      // Zone de knee : interpolation douce
      const t=(20*Math.log10(e/tL)+knee/2)/knee;
      gDB=-slope*(20*Math.log10(e/tL)+knee/2)*t*0.5;
    } else if (e>=kH) {
      gDB=-slope*(20*Math.log10(e/tL));
    }
    out[i]=data[i]*Math.pow(10,gDB/20)*0.95;
  }
  return out;
}

function autotune(data, strength, speedMs, sr) {
  if (strength<=0) return data;
  // Gamme chromatique 60–1200 Hz
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
    // Détecter le pitch sur ce hop
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
    // Appliquer le pitch ratio sur ce hop
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

function saturate(data, amount) {
  if (amount<=0) return data;
  const k=amount*200;
  const out=new Float32Array(data.length);
  for (let i=0;i<data.length;i++)
    out[i]=(1+k/100)*data[i]/(1+k/100*Math.abs(data[i]));
  return out;
}

function reverb(dL, dR, type, mix, sr) {
  if (type==='none'||mix<=0) return {L:dL,R:dR};
  // Multi-tap comb + allpass pour un son plus diffus et stéréo
  const len=dL.length;
  const cfg = type==='hall'
    ? { taps:[0.043,0.081,0.127,0.173], decay:0.52, apDelay:0.011 }
    : type==='plate'
    ? { taps:[0.030,0.059,0.089,0.127], decay:0.42, apDelay:0.008 }
    : { taps:[0.020,0.037,0.059,0.083], decay:0.32, apDelay:0.006 };

  const rvL=new Float32Array(len), rvR=new Float32Array(len);
  // Multi-tap comb filter — L et R avec délais légèrement décalés (décorrélation stéréo)
  for (let t=0;t<cfg.taps.length;t++) {
    const dsL=Math.floor(cfg.taps[t]*sr);
    const dsR=Math.floor(cfg.taps[t]*sr * (t%2===0 ? 1.013 : 0.988)); // ±1.3% décorrélation
    const g=Math.pow(cfg.decay, t+1);
    for (let i=0;i<len;i++) {
      if (i>=dsL) rvL[i]+=dL[i-dsL]*g;
      if (i>=dsR) rvR[i]+=dR[i-dsR]*g;
    }
  }
  // Allpass léger pour disperser les réflexions
  const apD=Math.floor(cfg.apDelay*sr);
  const apG=0.5;
  for (let i=apD;i<len;i++) {
    rvL[i]= rvL[i] + rvL[i-apD]*apG;
    rvR[i]= rvR[i] + rvR[i-apD]*apG;
  }
  // Normaliser la reverb pour éviter les clips
  let peak=0;
  for (let i=0;i<len;i++) peak=Math.max(peak,Math.abs(rvL[i]),Math.abs(rvR[i]));
  if (peak>1.0) { const n=1.0/peak; for(let i=0;i<len;i++){rvL[i]*=n;rvR[i]*=n;} }

  const outL=new Float32Array(len), outR=new Float32Array(len);
  for (let i=0;i<len;i++) { outL[i]=dL[i]*(1-mix)+rvL[i]*mix; outR[i]=dR[i]*(1-mix)+rvR[i]*mix; }
  return {L:outL,R:outR};
}

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

self.onmessage = function(e) {
  const {id,channelL,channelR,sampleRate,fx}=e.data;
  try {
    self.postMessage({id,type:'progress',pct:10,label:'EQ...'});
    let pL=channelL.slice(), pR=channelR.slice();
    pL=applyEQ(pL,fx.lowGain,'low',sampleRate);   pR=applyEQ(pR,fx.lowGain,'low',sampleRate);
    pL=applyEQ(pL,fx.midGain,'mid',sampleRate);   pR=applyEQ(pR,fx.midGain,'mid',sampleRate);
    pL=applyEQ(pL,fx.highGain,'high',sampleRate); pR=applyEQ(pR,fx.highGain,'high',sampleRate);
    self.postMessage({id,type:'progress',pct:30,label:'Compression...'});
    pL=compress(pL,fx.compThreshold,fx.compRatio,fx.compAttack,fx.compRelease,sampleRate,fx.compKnee);
    pR=compress(pR,fx.compThreshold,fx.compRatio,fx.compAttack,fx.compRelease,sampleRate,fx.compKnee);
    self.postMessage({id,type:'progress',pct:50,label:'Auto-Tune...'});
    const atStrength=fx.autotune||0;
    if (atStrength>0) {
      const speedMs=fx.autotuneSpeed==='fast'?30:fx.autotuneSpeed==='medium'?80:150;
      pL=autotune(pL,atStrength,speedMs,sampleRate);
      pR=autotune(pR,atStrength,speedMs,sampleRate);
    }
    self.postMessage({id,type:'progress',pct:65,label:'Saturation...'});
    pL=saturate(pL,fx.saturation); pR=saturate(pR,fx.saturation);
    self.postMessage({id,type:'progress',pct:75,label:'Reverb...'});
    const rv=reverb(pL,pR,fx.reverb,fx.reverbMix,sampleRate);
    pL=rv.L; pR=rv.R;
    // Normalisation
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
