// harmony-worker.js v4 — Phase Vocoder FFT + correction de formants
// Qualité professionnelle : préserve les formants vocaux indépendamment du pitch

// ── FFT Cooley-Tukey ───────────────────────────────────────────────────────
function fft(re, im) {
  const n = re.length;
  // Bit-reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // Butterfly
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i+j], uIm = im[i+j];
        const vRe = re[i+j+len/2]*curRe - im[i+j+len/2]*curIm;
        const vIm = re[i+j+len/2]*curIm + im[i+j+len/2]*curRe;
        re[i+j] = uRe+vRe; im[i+j] = uIm+vIm;
        re[i+j+len/2] = uRe-vRe; im[i+j+len/2] = uIm-vIm;
        const newRe = curRe*wRe - curIm*wIm;
        curIm = curRe*wIm + curIm*wRe; curRe = newRe;
      }
    }
  }
}

function ifft(re, im) {
  for (let i = 0; i < im.length; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < re.length; i++) { re[i] /= re.length; im[i] = -im[i] / re.length; }
}

// ── Phase Vocoder pitch shift ───────────────────────────────────────────────
function phaseVocoderShift(input, semitones, sampleRate) {
  if (semitones === 0) return input.slice();

  const pitchFactor = Math.pow(2, semitones / 12);
  const N    = 2048;   // taille FFT
  const hop  = 512;    // hop analysis
  const hopS = Math.round(hop / pitchFactor); // hop synthesis

  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 * (1 - Math.cos(2*Math.PI*i/(N-1)));
  const winSum = win.reduce((a,b) => a+b, 0);

  const numFrames = Math.ceil((input.length - N) / hop) + 1;
  const outLen    = Math.ceil(numFrames * hopS) + N;
  const output    = new Float32Array(outLen);
  const normOut   = new Float32Array(outLen);

  // Phase accumulators
  const phaseIn  = new Float32Array(N/2+1);
  const phaseOut = new Float32Array(N/2+1);
  const lastPhaseIn = new Float32Array(N/2+1);

  for (let frame = 0; frame < numFrames; frame++) {
    const inOff = frame * hop;
    const outOff = frame * hopS;

    // Fenêtrer le frame
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const idx = inOff + i;
      re[i] = (idx < input.length ? input[idx] : 0) * win[i];
    }

    // FFT
    fft(re, im);

    // Traitement phase vocoder
    const outRe = new Float32Array(N);
    const outIm = new Float32Array(N);
    for (let k = 0; k <= N/2; k++) {
      const mag   = Math.sqrt(re[k]*re[k] + im[k]*im[k]);
      const phase = Math.atan2(im[k], re[k]);

      // Phase difference depuis le frame précédent
      let dPhase = phase - lastPhaseIn[k];
      lastPhaseIn[k] = phase;

      // Fréquence vraie du bin
      const expectedPhase = 2 * Math.PI * k * hop / N;
      dPhase -= expectedPhase;
      // Ramener dans [-π, π]
      dPhase -= 2*Math.PI * Math.round(dPhase / (2*Math.PI));

      const trueFreq = (k + dPhase * N / (2*Math.PI*hop));

      // Accumuler la phase de sortie
      phaseOut[k] += 2 * Math.PI * trueFreq * hopS / N;

      outRe[k] = mag * Math.cos(phaseOut[k]);
      outIm[k] = mag * Math.sin(phaseOut[k]);
      // Symétrie hermitienne
      if (k > 0 && k < N/2) {
        outRe[N-k] = outRe[k]; outIm[N-k] = -outIm[k];
      }
    }

    // IFFT
    ifft(outRe, outIm);

    // OLA avec fenêtre
    for (let i = 0; i < N && outOff+i < outLen; i++) {
      output[outOff+i]  += outRe[i] * win[i];
      normOut[outOff+i] += win[i] * win[i];
    }
  }

  // Normaliser
  const result = new Float32Array(Math.floor(input.length / pitchFactor));
  for (let i = 0; i < result.length; i++) {
    result[i] = normOut[i] > 0.001 ? output[i] / normOut[i] : 0;
  }
  return result;
}

// ── Correction de formants (enveloppe spectrale) ───────────────────────────
// Shift l'enveloppe spectrale en sens inverse du pitch pour préserver les formants vocaux
function applyFormantShift(shifted, original, semitones, sampleRate) {
  // Pour les petits intervalles (< 5 ST) les formants sont acceptables sans correction
  if (Math.abs(semitones) < 5) return shifted;

  const N   = 1024;
  const hop = 256;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 * (1 - Math.cos(2*Math.PI*i/(N-1)));

  const pitchFactor = Math.pow(2, semitones / 12);
  // Facteur de correction formants : inverse partiel (pas 100% sinon ça sonne artificiel)
  const formantFactor = Math.pow(pitchFactor, -0.65);

  const outLen = shifted.length;
  const output = new Float32Array(outLen);
  const norm   = new Float32Array(outLen);
  const numFrames = Math.ceil((outLen - N) / hop) + 1;

  for (let frame = 0; frame < numFrames; frame++) {
    const off = frame * hop;
    const re  = new Float32Array(N); const im = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const idx = off + i;
      re[i] = (idx < outLen ? shifted[idx] : 0) * win[i];
    }
    fft(re, im);

    // Calculer l'enveloppe spectrale par lissage cepstral simplifié
    const mag = new Float32Array(N/2+1);
    for (let k = 0; k <= N/2; k++) mag[k] = Math.sqrt(re[k]*re[k]+im[k]*im[k]) + 1e-10;

    // Ré-échantillonner le spectre selon formantFactor
    const outRe = new Float32Array(N); const outIm = new Float32Array(N);
    for (let k = 0; k <= N/2; k++) {
      const srcK = k / formantFactor;
      const srcIdx = Math.min(Math.floor(srcK), N/2-1);
      const frac   = srcK - Math.floor(srcK);
      const srcMag = mag[srcIdx] + (mag[Math.min(srcIdx+1,N/2)] - mag[srcIdx]) * frac;
      const origMag = mag[k];
      const ratio = origMag > 1e-10 ? srcMag / origMag : 1;
      outRe[k] = re[k] * ratio; outIm[k] = im[k] * ratio;
      if (k > 0 && k < N/2) { outRe[N-k] = outRe[k]; outIm[N-k] = -outIm[k]; }
    }
    ifft(outRe, outIm);
    for (let i = 0; i < N && off+i < outLen; i++) {
      output[off+i] += outRe[i] * win[i];
      norm[off+i]   += win[i] * win[i];
    }
  }
  const result = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) result[i] = norm[i] > 0.001 ? output[i]/norm[i] : 0;
  return result;
}

// ── Double tracking JS pur ─────────────────────────────────────────────────
function doubleTrack(mono, sr) {
  const len = mono.length;
  const resample = (src, ratio) => {
    const outLen = Math.floor(src.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const idx = Math.min(Math.floor(pos), src.length - 2);
      const frac = pos - Math.floor(pos);
      out[i] = src[idx] + (src[idx+1] - src[idx]) * frac;
    }
    return out;
  };
  const shiftedL = resample(mono, 1 / Math.pow(2, 0.08 / 12));
  const shiftedR = resample(mono, 1 / Math.pow(2, -0.07 / 12));
  const delayL = Math.floor(0.012 * sr), delayR = Math.floor(0.023 * sr);
  const outLen = len + Math.floor(0.030 * sr);
  const outL = new Float32Array(outLen), outR = new Float32Array(outLen);
  for (let i = 0; i < len; i++) { outL[i] += mono[i]*0.70; outR[i] += mono[i]*0.70; }
  const llLen = Math.min(shiftedL.length, outLen-delayL);
  for (let i = 0; i < llLen; i++) { const s=shiftedL[i]*0.60; outL[i+delayL]+=s*0.80; outR[i+delayL]+=s*0.20; }
  const rrLen = Math.min(shiftedR.length, outLen-delayR);
  for (let i = 0; i < rrLen; i++) { const s=shiftedR[i]*0.60; outL[i+delayR]+=s*0.20; outR[i+delayR]+=s*0.80; }
  let peak = 0;
  for (let i = 0; i < outLen; i++) peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
  if (peak > 0.95) { const n=0.95/peak; for (let i=0;i<outLen;i++){outL[i]*=n;outR[i]*=n;} }
  return { outL, outR, outLen };
}

function applyGainPan(inL, inR, len, gain, pan) {
  const p = Math.max(-1, Math.min(1, pan));
  const panRad = (p+1)*Math.PI/4;
  const pL = Math.cos(panRad)*gain, pR = Math.sin(panRad)*gain;
  const outL = new Float32Array(len), outR = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const mid = ((inL[i]||0)+(inR[i]||0))*0.5;
    outL[i]=mid*pL; outR[i]=mid*pR;
  }
  return { outL, outR };
}

function audioToWav(chL, chR, sr) {
  const n = chL.length, dataLen = n*4;
  const buf = new ArrayBuffer(44+dataLen); const v = new DataView(buf);
  const ws=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  ws(0,'RIFF');v.setUint32(4,36+dataLen,true);ws(8,'WAVE');ws(12,'fmt ');
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,2,true);
  v.setUint32(24,sr,true);v.setUint32(28,sr*4,true);v.setUint16(32,4,true);v.setUint16(34,16,true);
  ws(36,'data');v.setUint32(40,dataLen,true);
  let off=44;
  for(let i=0;i<n;i++){
    const sL=Math.max(-1,Math.min(1,chL[i]||0));
    const sR=Math.max(-1,Math.min(1,chR[i]||0));
    v.setInt16(off,sL<0?sL*0x8000:sL*0x7FFF,true);off+=2;
    v.setInt16(off,sR<0?sR*0x8000:sR*0x7FFF,true);off+=2;
  }
  return buf;
}

// ── Main ───────────────────────────────────────────────────────────────────
self.onmessage = function(e) {
  const { id, op, channelL, channelR, semitones, gain, pan, sampleRate } = e.data;
  try {
    const len = channelL.length;
    const mono = new Float32Array(len);
    for (let i = 0; i < len; i++) mono[i] = ((channelL[i]||0)+(channelR[i]||0))*0.5;

    let outL, outR, outLen;

    if (op === 'double') {
      self.postMessage({ id, type: 'progress', label: 'Double tracking...' });
      const res = doubleTrack(mono, sampleRate);
      outL=res.outL; outR=res.outR; outLen=res.outLen;
    } else {
      self.postMessage({ id, type: 'progress', label: `Phase vocoder ${semitones>0?'+':''}${semitones} ST...` });
      let shifted = phaseVocoderShift(mono, semitones, sampleRate);

      // Correction de formants pour les grands intervalles
      if (Math.abs(semitones) >= 5) {
        self.postMessage({ id, type: 'progress', label: 'Correction formants...' });
        shifted = applyFormantShift(shifted, mono, semitones, sampleRate);
      }

      outLen = shifted.length;
      outL = shifted; outR = shifted;
    }

    // Gain + pan
    const gp = applyGainPan(outL, outR, outLen, gain, op==='double' ? 0 : pan);

    self.postMessage({ id, type: 'progress', label: 'Encodage WAV...' });
    const wavBuf = audioToWav(gp.outL, gp.outR, sampleRate);
    self.postMessage({ id, type: 'done', wavBuf }, [wavBuf]);
  } catch(err) {
    self.postMessage({ id, type: 'error', message: err.message || String(err) });
  }
};
