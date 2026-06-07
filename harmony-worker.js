// harmony-worker.js v5 — Phase Vocoder FFT + correction formants
// Nettoyé : dead code supprimé, paramètres inutilisés retirés

// ── FFT Cooley-Tukey ──────────────────────────────────────────────────────
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i],re[j]]=[re[j],re[i]]; [im[i],im[j]]=[im[j],im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe=re[i+j], uIm=im[i+j];
        const vRe=re[i+j+len/2]*curRe - im[i+j+len/2]*curIm;
        const vIm=re[i+j+len/2]*curIm + im[i+j+len/2]*curRe;
        re[i+j]=uRe+vRe; im[i+j]=uIm+vIm;
        re[i+j+len/2]=uRe-vRe; im[i+j+len/2]=uIm-vIm;
        const nr=curRe*wRe-curIm*wIm; curIm=curRe*wIm+curIm*wRe; curRe=nr;
      }
    }
  }
}
function ifft(re, im) {
  for (let i=0;i<im.length;i++) im[i]=-im[i];
  fft(re, im);
  for (let i=0;i<re.length;i++) { re[i]/=re.length; im[i]=-im[i]/re.length; }
}

// ── Phase Vocoder ─────────────────────────────────────────────────────────
function phaseVocoderShift(input, semitones) {
  if (semitones === 0) return input.slice();
  const pitchFactor = Math.pow(2, semitones / 12);
  const N = 4096, hop = N >> 2; // N/4 = 1024, overlap fixe de 4 — stable pour tous les semitones
  // hopS plafonné à N/2 pour garantir overlap >= 2 minimum
  // Pour les shifts extrêmes (-12ST), on time-stretch avec hopS raisonnable
  // puis on resample le résultat au pitch correct
  const hopS = Math.min(Math.round(hop / pitchFactor), N >> 1);
  const stretchFactor = hopS / hop; // ratio temps réel obtenu
  const win=new Float32Array(N);
  for (let i=0;i<N;i++) win[i]=0.5*(1-Math.cos(2*Math.PI*i/(N-1)));
  const numFrames=Math.ceil((input.length-N)/hop)+1;
  // outLen basé sur stretchFactor — toujours suffisant
  const stretchedLen = Math.ceil(numFrames * hopS) + N;
  const outLen = stretchedLen;
  const output=new Float32Array(outLen), normOut=new Float32Array(outLen);
  const output=new Float32Array(outLen), normOut=new Float32Array(outLen);
  const lastPhaseIn=new Float32Array(N/2+1), phaseOut=new Float32Array(N/2+1);
  for (let frame=0;frame<numFrames;frame++) {
    const inOff=frame*hop, outOff=frame*hopS;
    const re=new Float32Array(N), im=new Float32Array(N);
    for (let i=0;i<N;i++) re[i]=(inOff+i<input.length?input[inOff+i]:0)*win[i];
    fft(re, im);
    const outRe=new Float32Array(N), outIm=new Float32Array(N);
    for (let k=0;k<=N/2;k++) {
      const mag=Math.sqrt(re[k]*re[k]+im[k]*im[k]);
      const phase=Math.atan2(im[k],re[k]);
      let dPhase=phase-lastPhaseIn[k]; lastPhaseIn[k]=phase;
      const exp=2*Math.PI*k*hop/N; dPhase-=exp;
      dPhase-=2*Math.PI*Math.round(dPhase/(2*Math.PI));
      const trueFreq=k+dPhase*N/(2*Math.PI*hop);
      phaseOut[k]+=2*Math.PI*trueFreq*hopS/N;
      outRe[k]=mag*Math.cos(phaseOut[k]); outIm[k]=mag*Math.sin(phaseOut[k]);
      if (k>0&&k<N/2) { outRe[N-k]=outRe[k]; outIm[N-k]=-outIm[k]; }
    }
    ifft(outRe, outIm);
    for (let i=0;i<N&&outOff+i<outLen;i++) {
      output[outOff+i]+=outRe[i]*win[i]; normOut[outOff+i]+=win[i]*win[i];
    }
  }
  const targetLen=Math.floor(input.length/pitchFactor);
  // Resample depuis outLen vers targetLen avec interpolation lineaire
  const result=new Float32Array(targetLen);
  const resampleRatio = outLen / targetLen;
  for (let i=0;i<targetLen;i++) {
    const src = i * resampleRatio;
    const i0 = Math.floor(src); const frac = src - i0;
    const i1 = Math.min(i0+1, outLen-1);
    const v0 = i0<outLen && normOut[i0]>0.001 ? output[i0]/normOut[i0] : 0;
    const v1 = i1<outLen && normOut[i1]>0.001 ? output[i1]/normOut[i1] : 0;
    result[i] = v0 + (v1-v0)*frac;
  }
  return result;
}

// ── Correction formants ───────────────────────────────────────────────────
function applyFormantShift(shifted, semitones) {
  if (Math.abs(semitones) < 5) return shifted;
  // Pour les voix graves (-10ST et moins): pas de correction formant
  // La voix de géant naturelle sonne mieux sans réhaussement des formants
  if (semitones <= -10) return shifted;
  const N=1024, hop=256;
  const win=new Float32Array(N);
  for (let i=0;i<N;i++) win[i]=0.5*(1-Math.cos(2*Math.PI*i/(N-1)));
  // Atténuer la correction pour les semitones négatifs (shifts vers le bas)
  // pour éviter le son robotique/nasillard
  const rawFactor = Math.pow(Math.pow(2,semitones/12),-0.65);
  const formantFactor = semitones < 0
    ? 1 + (rawFactor - 1) * 0.3  // 30% de la correction pour les graves
    : rawFactor;                   // 100% pour les aigus (normal)
  const outLen=shifted.length;
  const output=new Float32Array(outLen), norm=new Float32Array(outLen);
  const numFrames=Math.ceil((outLen-N)/hop)+1;
  for (let frame=0;frame<numFrames;frame++) {
    const off=frame*hop;
    const re=new Float32Array(N), im=new Float32Array(N);
    for (let i=0;i<N;i++) re[i]=(off+i<outLen?shifted[off+i]:0)*win[i];
    fft(re,im);
    const mag=new Float32Array(N/2+1);
    for (let k=0;k<=N/2;k++) mag[k]=Math.sqrt(re[k]*re[k]+im[k]*im[k])+1e-10;
    const outRe=new Float32Array(N), outIm=new Float32Array(N);
    for (let k=0;k<=N/2;k++) {
      const srcK=k/formantFactor;
      const srcIdx=Math.min(Math.floor(srcK),N/2-1);
      const frac=srcK-Math.floor(srcK);
      const srcMag=mag[srcIdx]+(mag[Math.min(srcIdx+1,N/2)]-mag[srcIdx])*frac;
      const ratio=mag[k]>1e-10?srcMag/mag[k]:1;
      outRe[k]=re[k]*ratio; outIm[k]=im[k]*ratio;
      if (k>0&&k<N/2) { outRe[N-k]=outRe[k]; outIm[N-k]=-outIm[k]; }
    }
    ifft(outRe,outIm);
    for (let i=0;i<N&&off+i<outLen;i++) {
      output[off+i]+=outRe[i]*win[i]; norm[off+i]+=win[i]*win[i];
    }
  }
  const result=new Float32Array(outLen);
  for (let i=0;i<outLen;i++) result[i]=norm[i]>0.001?output[i]/norm[i]:0;
  return result;
}

// ── Double tracking ───────────────────────────────────────────────────────
function doubleTrack(mono, sr) {
  const len=mono.length;
  const resample=(src,ratio)=>{
    const outLen=Math.floor(src.length/ratio), out=new Float32Array(outLen);
    for (let i=0;i<outLen;i++) {
      const pos=i*ratio, idx=Math.min(Math.floor(pos),src.length-2);
      out[i]=src[idx]+(src[idx+1]-src[idx])*(pos-Math.floor(pos));
    }
    return out;
  };
  const sL=resample(mono,1/Math.pow(2,0.08/12));
  const sR=resample(mono,1/Math.pow(2,-0.07/12));
  const dL=Math.floor(0.012*sr), dR=Math.floor(0.023*sr);
  const outLen=len+Math.floor(0.030*sr);
  const outL=new Float32Array(outLen), outR=new Float32Array(outLen);
  for (let i=0;i<len;i++) { outL[i]+=mono[i]*0.70; outR[i]+=mono[i]*0.70; }
  const llLen=Math.min(sL.length,outLen-dL);
  for (let i=0;i<llLen;i++) { const s=sL[i]*0.60; outL[i+dL]+=s*0.80; outR[i+dL]+=s*0.20; }
  const rrLen=Math.min(sR.length,outLen-dR);
  for (let i=0;i<rrLen;i++) { const s=sR[i]*0.60; outL[i+dR]+=s*0.20; outR[i+dR]+=s*0.80; }
  let peak=0;
  for (let i=0;i<outLen;i++) peak=Math.max(peak,Math.abs(outL[i]),Math.abs(outR[i]));
  if (peak>0.95) { const n=0.95/peak; for(let i=0;i<outLen;i++){outL[i]*=n;outR[i]*=n;} }
  return { outL, outR, outLen };
}

// ── Gain/Pan ──────────────────────────────────────────────────────────────
// isDouble=true : préserver la stéréo L/R déjà construite par doubleTrack
// (fusion mid+pan détruirait l'effet de largeur)
function applyGainPan(inL, inR, len, gain, pan, isDouble) {
  const outL=new Float32Array(len), outR=new Float32Array(len);
  if (isDouble) {
    // Conserver les canaux distincts de doubleTrack — appliquer seulement le gain global
    for (let i=0;i<len;i++) { outL[i]=(inL[i]||0)*gain; outR[i]=(inR[i]||0)*gain; }
  } else {
    const p=Math.max(-1,Math.min(1,pan)), pr=(p+1)*Math.PI/4;
    const pL=Math.cos(pr)*gain, pR=Math.sin(pr)*gain;
    for (let i=0;i<len;i++) {
      const mid=((inL[i]||0)+(inR[i]||0))*0.5;
      outL[i]=mid*pL; outR[i]=mid*pR;
    }
  }
  return { outL, outR };
}

// ── WAV ───────────────────────────────────────────────────────────────────
function audioToWav(chL, chR, sr) {
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
  const { id, op, channelL, channelR, semitones, gain, pan, sampleRate } = e.data;
  try {
    const len=channelL.length;
    const mono=new Float32Array(len);
    for (let i=0;i<len;i++) mono[i]=((channelL[i]||0)+(channelR[i]||0))*0.5;

    let outL, outR, outLen;
    if (op==='double') {
      self.postMessage({id,type:'progress',label:'Double tracking...'});
      const res=doubleTrack(mono,sampleRate);
      outL=res.outL; outR=res.outR; outLen=res.outLen;
    } else {
      self.postMessage({id,type:'progress',label:`Phase vocoder ${semitones>0?'+':''}${semitones} ST...`});
      let shifted=phaseVocoderShift(mono,semitones);
      if (Math.abs(semitones)>=5) {
        self.postMessage({id,type:'progress',label:'Correction formants...'});
        shifted=applyFormantShift(shifted,semitones);
      }
      outLen=shifted.length; outL=shifted; outR=shifted;
    }
    const gp=applyGainPan(outL,outR,outLen,gain,op==='double'?0:pan,op==='double');
    self.postMessage({id,type:'progress',label:'Encodage WAV...'});
    const wavBuf=audioToWav(gp.outL,gp.outR,sampleRate);
    self.postMessage({id,type:'done',wavBuf},[wavBuf]);
  } catch(err) {
    self.postMessage({id,type:'error',message:err.message||String(err)});
  }
};
