// fx-worker.js v5 — Reverb Dattorro 1997 + Early Reflections + Modulation LFO

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

// ── Compresseur avec ballistic detection ────────────────────────────────
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

// ── Reverb Dattorro (1997) — algorithme studio pro ───────────────────────
// Référence: Jon Dattorro, "Effect Design Part 1: Reverberator and Other Filters"
// Journal of the Audio Engineering Society, 1997
//
// Architecture :
//   Input → Pre-EQ (HPF 200Hz) → Pre-delay → 4 allpass d'entrée
//   → 2 tanks stéréo en boucle (chacun : delay + allpass modulé + diffusion)
//   → Early Reflections mixées séparément
//   → Mix dry/wet
//
// Améliorations vs Schroeder :
//   - Modulation LFO sur les délais des allpass du tank → évite la coloration tonale
//   - Early reflections réalistes → définit la taille perçue de la salle
//   - Pre-EQ HPF sur le signal envoyé à la reverb → évite la boue dans les graves
//   - Décorrélation stéréo naturelle via les deux tanks indépendants

function reverb(dL, dR, type, mix, sr) {
  if (type==='none'||type==='sec'||mix<=0) return {L:dL,R:dR};
  const len=dL.length;

  // Paramètres par type de salle
  const cfgs = {
    room:  { preDelayMs:8,   decay:0.50, inputDiff1:0.750, inputDiff2:0.625, tankDiff:0.700, tankDecay:0.500, modDepth:0.3, modRate:0.10, erMix:0.25 },
    hall:  { preDelayMs:20,  decay:0.75, inputDiff1:0.750, inputDiff2:0.625, tankDiff:0.700, tankDecay:0.750, modDepth:0.5, modRate:0.07, erMix:0.20 },
    plate: { preDelayMs:5,   decay:0.60, inputDiff1:0.750, inputDiff2:0.625, tankDiff:0.700, tankDecay:0.600, modDepth:0.6, modRate:0.14, erMix:0.15 },
  };
  const c=cfgs[type]||cfgs.room;

  // ── Pre-EQ : HPF 200Hz sur le signal envoyé à la reverb ─────────────────
  // Évite la boue dans les graves — standard studio
  const preEQ=(sig)=>{
    const wc=2*Math.PI*200/sr, k=Math.tan(wc/2);
    const norm=1/(1+Math.SQRT2*k+k*k);
    const b0=norm,b1=-2*norm,b2=norm,a1=2*(k*k-1)*norm,a2=(1-Math.SQRT2*k+k*k)*norm;
    const out=new Float32Array(sig.length); let x1=0,x2=0,y1=0,y2=0;
    for (let i=0;i<sig.length;i++) {
      const x0=sig[i],y0=b0*x0+b1*x1+b2*x2-a1*y1-a2*y2;
      out[i]=y0; x2=x1; x1=x0; y2=y1; y1=y0;
    }
    return out;
  };
  const inL=preEQ(dL), inR=preEQ(dR);

  // ── Early Reflections ─────────────────────────────────────────────────────
  // 7 réflexions précoces par canal avec délais et gains calibrés
  // Simule les premières réflexions des murs d'une vraie salle
  const erTapsMs = [
    {ms:5.0, gL:0.70, gR:0.50}, {ms:11.0,gL:0.60,gR:0.70},
    {ms:17.3,gL:0.50,gR:0.40}, {ms:23.0,gL:0.40,gR:0.55},
    {ms:31.7,gL:0.35,gR:0.30}, {ms:40.2,gL:0.25,gR:0.35},
    {ms:55.0,gL:0.15,gR:0.20},
  ];
  const erL=new Float32Array(len), erR=new Float32Array(len);
  for (const tap of erTapsMs) {
    const d=Math.floor(tap.ms*sr/1000);
    for (let i=d;i<len;i++) {
      erL[i]+=inL[i-d]*tap.gL;
      erR[i]+=inR[i-d]*tap.gR;
    }
  }

  // ── Pre-delay ─────────────────────────────────────────────────────────────
  const preD=Math.max(1,Math.floor(c.preDelayMs*sr/1000));
  const preBufL=new Float32Array(preD), preBufR=new Float32Array(preD); let prePtr=0;

  // ── 4 Allpass d'entrée (diffusion du signal entrant) ─────────────────────
  // Ces allpass "éparpillent" le signal dans le temps avant le tank
  const apInDelays=[142,107,379,277].map(d=>Math.floor(d*sr/44100));
  const apInBufsL=apInDelays.map(d=>new Float32Array(d));
  const apInBufsR=apInDelays.map(d=>new Float32Array(d));
  const apInPtrsL=new Int32Array(4), apInPtrsR=new Int32Array(4);

  // ── Tank L : boucle de réverbération gauche ──────────────────────────────
  // Délais du tank (en samples à 44.1kHz, normalisés au sr actuel)
  const tankLDelays=[4453,3720,4217].map(d=>Math.floor(d*sr/44100));
  const tankLBufs=tankLDelays.map(d=>new Float32Array(d+8)); // +8 pour la modulation
  const tankLPtrs=new Int32Array(3);
  // Allpass du tank L avec modulation LFO
  const apLDelays=[908,2656].map(d=>Math.floor(d*sr/44100));
  const apLBufs=apLDelays.map(d=>new Float32Array(d+8));
  const apLPtrs=new Int32Array(2);

  // ── Tank R : boucle de réverbération droite ──────────────────────────────
  const tankRDelays=[4217,3163,3720].map(d=>Math.floor(d*sr/44100));
  const tankRBufs=tankRDelays.map(d=>new Float32Array(d+8));
  const tankRPtrs=new Int32Array(3);
  const apRDelays=[2656,908].map(d=>Math.floor(d*sr/44100));
  const apRBufs=apRDelays.map(d=>new Float32Array(d+8));
  const apRPtrs=new Int32Array(2);

  // État des tanks (feedback)
  let tankL=0, tankR=0;

  // LFO pour la modulation des allpass du tank (évite la coloration tonale)
  const lfoRate=c.modRate; // Hz
  const lfoInc=2*Math.PI*lfoRate/sr;
  let lfoPhaseL=0, lfoPhaseR=Math.PI*0.5; // déphasés pour stéréo naturel
  const modDepthSamp=Math.floor(c.modDepth*sr/1000); // profondeur en samples

  const wetL=new Float32Array(len), wetR=new Float32Array(len);

  // Fonction allpass modulé (cœur du tank Dattorro)
  const allpassMod=(buf, ptr, len, coeff, input, modOffset)=>{
    const readPtr=(ptr-Math.floor(modOffset)+len+len)%len;
    const delayed=buf[readPtr];
    const out=delayed+input*(-coeff);
    buf[ptr%len]=input+delayed*coeff;
    return { out, next:(ptr+1)%len };
  };

  for (let i=0;i<len;i++) {
    // Pre-delay
    const pdL=preBufL[prePtr], pdR=preBufR[prePtr];
    preBufL[prePtr]=inL[i]||0; preBufR[prePtr]=inR[i]||0;
    prePtr=(prePtr+1)%preD;

    // Mixer les deux canaux en entrée des allpass (mono diffusion)
    let sigL=(pdL+pdR)*0.5, sigR=sigL;

    // 4 Allpass d'entrée (même pour L et R, diffusion identique)
    for (let a=0;a<4;a++) {
      // Canal L
      const dL2=apInBufsL[a][apInPtrsL[a]];
      const outL2=dL2-c.inputDiff1*sigL;
      apInBufsL[a][apInPtrsL[a]]=sigL+dL2*c.inputDiff1;
      sigL=outL2; apInPtrsL[a]=(apInPtrsL[a]+1)%apInDelays[a];
      // Canal R (légèrement différent pour décorrélation stéréo)
      const dR2=apInBufsR[a][apInPtrsR[a]];
      const outR2=dR2-c.inputDiff2*sigR;
      apInBufsR[a][apInPtrsR[a]]=sigR+dR2*c.inputDiff2;
      sigR=outR2; apInPtrsR[a]=(apInPtrsR[a]+1)%apInDelays[a];
    }

    // LFO modulation
    lfoPhaseL+=lfoInc; if (lfoPhaseL>2*Math.PI) lfoPhaseL-=2*Math.PI;
    lfoPhaseR+=lfoInc; if (lfoPhaseR>2*Math.PI) lfoPhaseR-=2*Math.PI;
    const lfoL=0.5*(1+Math.sin(lfoPhaseL))*modDepthSamp;
    const lfoR=0.5*(1+Math.sin(lfoPhaseR))*modDepthSamp;

    // ── Tank gauche ───────────────────────────────────────────────────────
    let tL=sigL+tankR*c.decay;
    // Delay 1
    const tL_d0=tankLBufs[0][tankLPtrs[0]];
    tankLBufs[0][tankLPtrs[0]]=tL; tankLPtrs[0]=(tankLPtrs[0]+1)%tankLDelays[0];
    tL=tL_d0;
    // Allpass modulé 1
    const apLmod1=allpassMod(apLBufs[0],apLPtrs[0],apLDelays[0],c.tankDiff,tL,lfoL);
    tL=apLmod1.out; apLPtrs[0]=apLmod1.next;
    // Delay 2
    const tL_d1=tankLBufs[1][tankLPtrs[1]];
    tankLBufs[1][tankLPtrs[1]]=tL*c.tankDecay; tankLPtrs[1]=(tankLPtrs[1]+1)%tankLDelays[1];
    tL=tL_d1;
    // Allpass modulé 2
    const apLmod2=allpassMod(apLBufs[1],apLPtrs[1],apLDelays[1],c.tankDiff,tL,lfoL*0.7);
    tL=apLmod2.out; apLPtrs[1]=apLmod2.next;
    // Delay 3
    const tL_d2=tankLBufs[2][tankLPtrs[2]];
    tankLBufs[2][tankLPtrs[2]]=tL; tankLPtrs[2]=(tankLPtrs[2]+1)%tankLDelays[2];
    tankL=tL_d2;

    // ── Tank droit ────────────────────────────────────────────────────────
    let tR=sigR+tankL*c.decay;
    const tR_d0=tankRBufs[0][tankRPtrs[0]];
    tankRBufs[0][tankRPtrs[0]]=tR; tankRPtrs[0]=(tankRPtrs[0]+1)%tankRDelays[0];
    tR=tR_d0;
    const apRmod1=allpassMod(apRBufs[0],apRPtrs[0],apRDelays[0],c.tankDiff,tR,lfoR);
    tR=apRmod1.out; apRPtrs[0]=apRmod1.next;
    const tR_d1=tankRBufs[1][tankRPtrs[1]];
    tankRBufs[1][tankRPtrs[1]]=tR*c.tankDecay; tankRPtrs[1]=(tankRPtrs[1]+1)%tankRDelays[1];
    tR=tR_d1;
    const apRmod2=allpassMod(apRBufs[1],apRPtrs[1],apRDelays[1],c.tankDiff,tR,lfoR*0.7);
    tR=apRmod2.out; apRPtrs[1]=apRmod2.next;
    const tR_d2=tankRBufs[2][tankRPtrs[2]];
    tankRBufs[2][tankRPtrs[2]]=tR; tankRPtrs[2]=(tankRPtrs[2]+1)%tankRDelays[2];
    tankR=tR_d2;

    // Sorties wet : taps multiples sur les tanks (technique Dattorro)
    // Plusieurs points de lecture sur les délais du tank → densité naturelle
    const outL2 = tankLBufs[1][(tankLPtrs[1]+Math.floor(tankLDelays[1]*0.28))%tankLDelays[1]]
                + tankLBufs[2][(tankLPtrs[2]+Math.floor(tankLDelays[2]*0.54))%tankLDelays[2]]
                - apRBufs[0][(apRPtrs[0]+Math.floor(apRDelays[0]*0.63))%apRDelays[0]]
                + tankRBufs[1][(tankRPtrs[1]+Math.floor(tankRDelays[1]*0.41))%tankRDelays[1]]
                - tankLBufs[0][(tankLPtrs[0]+Math.floor(tankLDelays[0]*0.72))%tankLDelays[0]]
                - apLBufs[1][(apLPtrs[1]+Math.floor(apLDelays[1]*0.35))%apLDelays[1]];

    const outR2 = tankRBufs[1][(tankRPtrs[1]+Math.floor(tankRDelays[1]*0.28))%tankRDelays[1]]
                + tankRBufs[2][(tankRPtrs[2]+Math.floor(tankRDelays[2]*0.54))%tankRDelays[2]]
                - apLBufs[0][(apLPtrs[0]+Math.floor(apLDelays[0]*0.63))%apLDelays[0]]
                + tankLBufs[1][(tankLPtrs[1]+Math.floor(tankLDelays[1]*0.41))%tankLDelays[1]]
                - tankRBufs[0][(tankRPtrs[0]+Math.floor(tankRDelays[0]*0.72))%tankRDelays[0]]
                - apRBufs[1][(apRPtrs[1]+Math.floor(apRDelays[1]*0.35))%apRDelays[1]];

    wetL[i]=outL2; wetR[i]=outR2;
  }

  // Normaliser wet
  let peak=0;
  for (let i=0;i<len;i++) peak=Math.max(peak,Math.abs(wetL[i]),Math.abs(wetR[i]));
  if (peak>0.001) { const n=0.85/peak; for(let i=0;i<len;i++){wetL[i]*=n;wetR[i]*=n;} }

  // Mix final : dry + early reflections + wet tank
  const erAmt=c.erMix;
  const outL=new Float32Array(len), outR=new Float32Array(len);
  for (let i=0;i<len;i++) {
    outL[i]=dL[i]*(1-mix) + (wetL[i]*(1-erAmt)+erL[i]*erAmt)*mix;
    outR[i]=dR[i]*(1-mix) + (wetR[i]*(1-erAmt)+erR[i]*erAmt)*mix;
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
    self.postMessage({id,type:'progress',pct:8, label:'EQ...'});
    pL=applyEQChain(pL,fx,sampleRate); pR=applyEQChain(pR,fx,sampleRate);
    self.postMessage({id,type:'progress',pct:18,label:'De-esser...'});
    pL=applyDeEsser(pL,sampleRate,-20,7500,2500,-6);
    pR=applyDeEsser(pR,sampleRate,-20,7500,2500,-6);
    self.postMessage({id,type:'progress',pct:32,label:'Compression...'});
    pL=compress(pL,fx.compThreshold,fx.compRatio,fx.compAttack,fx.compRelease,sampleRate,fx.compKnee,0.6);
    pR=compress(pR,fx.compThreshold,fx.compRatio,fx.compAttack,fx.compRelease,sampleRate,fx.compKnee,0.6);
    self.postMessage({id,type:'progress',pct:48,label:'Auto-Tune...'});
    if ((fx.autotune||0)>0) {
      const speedMs=fx.autotuneSpeed==='fast'?30:fx.autotuneSpeed==='medium'?80:150;
      pL=autotune(pL,fx.autotune,speedMs,sampleRate);
      pR=autotune(pR,fx.autotune,speedMs,sampleRate);
    }
    self.postMessage({id,type:'progress',pct:60,label:'Saturation...'});
    pL=saturate(pL,fx.saturation||0); pR=saturate(pR,fx.saturation||0);
    self.postMessage({id,type:'progress',pct:72,label:'Reverb Dattorro...'});
    const rv=reverb(pL,pR,fx.reverb,fx.reverbMix,sampleRate);
    pL=rv.L; pR=rv.R;
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
