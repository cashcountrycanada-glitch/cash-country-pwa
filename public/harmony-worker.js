// harmony-worker.js v2 — WSOLA amélioré, moins d'artefacts

function wsolaShift(inputData, semitones, sampleRate) {
  if (semitones === 0) return inputData.slice();
  const rate      = Math.pow(2, semitones / 12);
  // Frames plus grandes = moins d'artefacts sur les voyelles longues
  const frameSize = 2048;
  const overlap   = Math.floor(frameSize * 0.75);
  const hop_a     = frameSize - overlap;          // hop dans le signal source
  const hop_s     = Math.round(hop_a / rate);     // hop dans le signal sortie
  const outputLen = Math.floor(inputData.length / rate);
  const output    = new Float32Array(outputLen + frameSize);
  const norm      = new Float32Array(outputLen + frameSize);

  // Fenêtre de Hann
  const win = new Float32Array(frameSize);
  for (let i = 0; i < frameSize; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (frameSize - 1)));

  let pos_s = 0;
  let pos_a = 0;

  while (pos_s + frameSize < outputLen + frameSize) {
    const srcPos = Math.min(Math.round(pos_a), inputData.length - frameSize);
    if (srcPos < 0) { pos_a += hop_a; pos_s += hop_s; continue; }

    // OLA de base sans recherche pour pos_s=0, sinon recherche de corrélation
    let bestOffset = 0;
    if (pos_s > overlap) {
      let bestCorr = -Infinity;
      const searchRange = Math.min(hop_a * 2, srcPos, inputData.length - srcPos - frameSize);
      for (let d = -searchRange; d <= searchRange; d += 4) {
        const sp = srcPos + d;
        if (sp < 0 || sp + frameSize > inputData.length) continue;
        let corr = 0;
        const compareLen = Math.min(overlap, frameSize);
        const oStart = pos_s - overlap;
        if (oStart < 0) continue;
        for (let k = 0; k < compareLen; k += 2) {
          corr += output[oStart + k] * inputData[sp + k];
        }
        if (corr > bestCorr) { bestCorr = corr; bestOffset = d; }
      }
    }

    const readPos = Math.max(0, Math.min(srcPos + bestOffset, inputData.length - frameSize));
    const writeEnd = Math.min(pos_s + frameSize, output.length);
    for (let i = 0; i < writeEnd - pos_s; i++) {
      output[pos_s + i] += inputData[readPos + i] * win[i];
      norm[pos_s + i]   += win[i];
    }

    pos_a += hop_a;
    pos_s += hop_s;
  }

  // Normaliser par la somme des fenêtres
  const result = new Float32Array(outputLen);
  for (let i = 0; i < outputLen; i++) {
    result[i] = norm[i] > 0.001 ? output[i] / norm[i] : 0;
  }
  return result;
}

function doubleTrack(mono, sr) {
  const len = mono.length;
  const resample = (src, ratio) => {
    const outLen = Math.floor(src.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio; const idx = Math.floor(pos); const frac = pos - idx;
      out[i] = (src[idx] || 0) + ((src[Math.min(idx+1, src.length-1)] || 0) - (src[idx] || 0)) * frac;
    }
    return out;
  };
  const shiftedL = resample(mono, 1 / Math.pow(2, 0.08 / 12));
  const shiftedR = resample(mono, 1 / Math.pow(2, -0.07 / 12));
  const delayL = Math.floor(0.012 * sr), delayR = Math.floor(0.023 * sr);
  const outLen = len + Math.floor(0.030 * sr);
  const outL = new Float32Array(outLen), outR = new Float32Array(outLen);
  for (let i = 0; i < len; i++) { outL[i] += mono[i] * 0.70; outR[i] += mono[i] * 0.70; }
  const llLen = Math.min(shiftedL.length, outLen - delayL);
  for (let i = 0; i < llLen; i++) { const s = shiftedL[i] * 0.60; outL[i+delayL] += s*0.80; outR[i+delayL] += s*0.20; }
  const rrLen = Math.min(shiftedR.length, outLen - delayR);
  for (let i = 0; i < rrLen; i++) { const s = shiftedR[i] * 0.60; outL[i+delayR] += s*0.20; outR[i+delayR] += s*0.80; }
  let peak = 0;
  for (let i = 0; i < outLen; i++) peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
  if (peak > 0.95) { const n = 0.95/peak; for (let i = 0; i < outLen; i++) { outL[i]*=n; outR[i]*=n; } }
  return { outL, outR, outLen };
}

function applyGainPan(inL, inR, len, gain, pan) {
  const panRad = (Math.max(-1, Math.min(1, pan)) + 1) * Math.PI / 4;
  const panL = Math.cos(panRad) * gain, panR = Math.sin(panRad) * gain;
  const outL = new Float32Array(len), outR = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const mid = ((inL[i]||0) + (inR[i]||0)) * 0.5;
    outL[i] = mid * panL; outR[i] = mid * panR;
  }
  return { outL, outR };
}

function audioToWav(chL, chR, sr) {
  const numSamp = chL.length;
  const dataLen = numSamp * 4; // 2ch * 2bytes
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o+i, s.charCodeAt(i)); };
  ws(0,'RIFF'); v.setUint32(4, 36+dataLen, true); ws(8,'WAVE'); ws(12,'fmt ');
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,2,true);
  v.setUint32(24,sr,true); v.setUint32(28,sr*4,true); v.setUint16(32,4,true); v.setUint16(34,16,true);
  ws(36,'data'); v.setUint32(40,dataLen,true);
  let off = 44;
  for (let i = 0; i < numSamp; i++) {
    const sL = Math.max(-1,Math.min(1,chL[i]||0)); const sR = Math.max(-1,Math.min(1,chR[i]||0));
    v.setInt16(off, sL<0?sL*0x8000:sL*0x7FFF, true); off+=2;
    v.setInt16(off, sR<0?sR*0x8000:sR*0x7FFF, true); off+=2;
  }
  return buf;
}

self.onmessage = function(e) {
  const { id, op, channelL, channelR, semitones, gain, pan, sampleRate } = e.data;
  try {
    const len = channelL.length;
    const mono = new Float32Array(len);
    for (let i = 0; i < len; i++) mono[i] = ((channelL[i]||0) + (channelR[i]||0)) * 0.5;

    let outL, outR, outLen;

    if (op === 'double') {
      const res = doubleTrack(mono, sampleRate);
      outL = res.outL; outR = res.outR; outLen = res.outLen;
    } else {
      self.postMessage({ id, type: 'progress', label: `Pitch shift ${semitones > 0 ? '+' : ''}${semitones} ST...` });
      let shifted = wsolaShift(mono, semitones, sampleRate);
      outLen = shifted.length;

      // Chorus léger pour harmonies courtes
      if (Math.abs(semitones) > 0 && Math.abs(semitones) <= 7) {
        const pitchMod = semitones > 0 ? 0.03 : -0.03;
        const ratioC = 1 / Math.pow(2, pitchMod / 12);
        const chorOut = new Float32Array(outLen);
        for (let j = 0; j < outLen; j++) {
          const pos = j * ratioC; const idx = Math.floor(pos); const frac = pos - idx;
          const sVal = (shifted[idx]||0) + ((shifted[Math.min(idx+1,outLen-1)]||0) - (shifted[idx]||0)) * frac;
          chorOut[j] = shifted[j] * 0.88 + sVal * 0.22;
        }
        shifted = chorOut;
      }
      outL = shifted; outR = shifted;
    }

    // Gain + pan
    const gp = applyGainPan(outL, outR, outLen, gain, op === 'double' ? 0 : pan);

    self.postMessage({ id, type: 'progress', label: 'Encodage WAV...' });
    const wavBuf = audioToWav(gp.outL, gp.outR, sampleRate);
    self.postMessage({ id, type: 'done', wavBuf }, [wavBuf]);
  } catch(err) {
    self.postMessage({ id, type: 'error', message: err.message || String(err) });
  }
};
