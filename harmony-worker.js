// harmony-worker.js v14 — Rubber Band WASM (rubberband-wasm v3.3.0 par daninet)
// Pitch shift haute qualité avec préservation des formants
// Fichiers requis sur Railway : /rubberband.umd.min.js + /rubberband.wasm
// Pipeline : Rubber Band → AGC → Saturation → Jitter → Timbre → Timing → Reverb → Chorus → Pan

// ═══════════════════════════════════════════════════════════════
// PRNG déterministe — Mulberry32
// ═══════════════════════════════════════════════════════════════
function makePRNG(seed) {
  let s = (seed >>> 0) | 1;
  return function() {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ═══════════════════════════════════════════════════════════════
// SOUNDTOUCH JS — Fallback si Rubber Band WASM indisponible
// ═══════════════════════════════════════════════════════════════
/*
 * SoundTouch JS v0.3.0 audio processing library
 * Copyright (c) Olli Parviainen
 * Copyright (c) Ryan Berdeen
 * Copyright (c) Jakub Fiala
 * Copyright (c) Steve 'Cutter' Blades
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
 */

class FifoSampleBuffer {
  constructor() {
    this._vector = new Float32Array();
    this._position = 0;
    this._frameCount = 0;
  }
  get vector() {
    return this._vector;
  }
  get position() {
    return this._position;
  }
  get startIndex() {
    return this._position * 2;
  }
  get frameCount() {
    return this._frameCount;
  }
  get endIndex() {
    return (this._position + this._frameCount) * 2;
  }
  clear() {
    this._vector.fill(0);
    this._position = 0;
    this._frameCount = 0;
  }
  put(numFrames) {
    this._frameCount += numFrames;
  }
  putSamples(samples, position, numFrames = 0) {
    position = position || 0;
    const sourceOffset = position * 2;
    if (!(numFrames >= 0)) {
      numFrames = (samples.length - sourceOffset) / 2;
    }
    const numSamples = numFrames * 2;
    this.ensureCapacity(numFrames + this._frameCount);
    const destOffset = this.endIndex;
    this.vector.set(samples.subarray(sourceOffset, sourceOffset + numSamples), destOffset);
    this._frameCount += numFrames;
  }
  putBuffer(buffer, position, numFrames = 0) {
    position = position || 0;
    if (!(numFrames >= 0)) {
      numFrames = buffer.frameCount - position;
    }
    this.putSamples(buffer.vector, buffer.position + position, numFrames);
  }
  receive(numFrames) {
    if (!(numFrames >= 0) || numFrames > this._frameCount) {
      numFrames = this.frameCount;
    }
    this._frameCount -= numFrames;
    this._position += numFrames;
  }
  receiveSamples(output, numFrames = 0) {
    const numSamples = numFrames * 2;
    const sourceOffset = this.startIndex;
    output.set(this._vector.subarray(sourceOffset, sourceOffset + numSamples));
    this.receive(numFrames);
  }
  extract(output, position = 0, numFrames = 0) {
    const sourceOffset = this.startIndex + position * 2;
    const numSamples = numFrames * 2;
    output.set(this._vector.subarray(sourceOffset, sourceOffset + numSamples));
  }
  ensureCapacity(numFrames = 0) {
    const minLength = parseInt(numFrames * 2);
    if (this._vector.length < minLength) {
      const newVector = new Float32Array(minLength);
      newVector.set(this._vector.subarray(this.startIndex, this.endIndex));
      this._vector = newVector;
      this._position = 0;
    } else {
      this.rewind();
    }
  }
  ensureAdditionalCapacity(numFrames = 0) {
    this.ensureCapacity(this._frameCount + numFrames);
  }
  rewind() {
    if (this._position > 0) {
      this._vector.set(this._vector.subarray(this.startIndex, this.endIndex));
      this._position = 0;
    }
  }
}

class AbstractFifoSamplePipe {
  constructor(createBuffers) {
    if (createBuffers) {
      this._inputBuffer = new FifoSampleBuffer();
      this._outputBuffer = new FifoSampleBuffer();
    } else {
      this._inputBuffer = this._outputBuffer = null;
    }
  }
  get inputBuffer() {
    return this._inputBuffer;
  }
  set inputBuffer(inputBuffer) {
    this._inputBuffer = inputBuffer;
  }
  get outputBuffer() {
    return this._outputBuffer;
  }
  set outputBuffer(outputBuffer) {
    this._outputBuffer = outputBuffer;
  }
  clear() {
    this._inputBuffer.clear();
    this._outputBuffer.clear();
  }
}

class RateTransposer extends AbstractFifoSamplePipe {
  constructor(createBuffers) {
    super(createBuffers);
    this.reset();
    this._rate = 1;
  }
  set rate(rate) {
    this._rate = rate;
  }
  reset() {
    this.slopeCount = 0;
    this.prevSampleL = 0;
    this.prevSampleR = 0;
  }
  clear() {
    super.clear();
    this.reset();
  }
  clone() {
    const result = new RateTransposer();
    result.rate = this._rate;
    return result;
  }
  process() {
    const numFrames = this._inputBuffer.frameCount;
    this._outputBuffer.ensureAdditionalCapacity(numFrames / this._rate + 1);
    const numFramesOutput = this.transpose(numFrames);
    this._inputBuffer.receive();
    this._outputBuffer.put(numFramesOutput);
  }
  transpose(numFrames = 0) {
    if (numFrames === 0) {
      return 0;
    }
    const src = this._inputBuffer.vector;
    const srcOffset = this._inputBuffer.startIndex;
    const dest = this._outputBuffer.vector;
    const destOffset = this._outputBuffer.endIndex;
    let used = 0;
    let i = 0;
    while (this.slopeCount < 1.0) {
      dest[destOffset + 2 * i] = (1.0 - this.slopeCount) * this.prevSampleL + this.slopeCount * src[srcOffset];
      dest[destOffset + 2 * i + 1] = (1.0 - this.slopeCount) * this.prevSampleR + this.slopeCount * src[srcOffset + 1];
      i = i + 1;
      this.slopeCount += this._rate;
    }
    this.slopeCount -= 1.0;
    if (numFrames !== 1) {
      out: while (true) {
        while (this.slopeCount > 1.0) {
          this.slopeCount -= 1.0;
          used = used + 1;
          if (used >= numFrames - 1) {
            break out;
          }
        }
        const srcIndex = srcOffset + 2 * used;
        dest[destOffset + 2 * i] = (1.0 - this.slopeCount) * src[srcIndex] + this.slopeCount * src[srcIndex + 2];
        dest[destOffset + 2 * i + 1] = (1.0 - this.slopeCount) * src[srcIndex + 1] + this.slopeCount * src[srcIndex + 3];
        i = i + 1;
        this.slopeCount += this._rate;
      }
    }
    this.prevSampleL = src[srcOffset + 2 * numFrames - 2];
    this.prevSampleR = src[srcOffset + 2 * numFrames - 1];
    return i;
  }
}

class FilterSupport {
  constructor(pipe) {
    this._pipe = pipe;
  }
  get pipe() {
    return this._pipe;
  }
  get inputBuffer() {
    return this._pipe.inputBuffer;
  }
  get outputBuffer() {
    return this._pipe.outputBuffer;
  }
  fillInputBuffer(
  ) {
    throw new Error('fillInputBuffer() not overridden');
  }
  fillOutputBuffer(numFrames = 0) {
    while (this.outputBuffer.frameCount < numFrames) {
      const numInputFrames = 8192 * 2 - this.inputBuffer.frameCount;
      this.fillInputBuffer(numInputFrames);
      if (this.inputBuffer.frameCount < 8192 * 2) {
        break;
      }
      this._pipe.process();
    }
  }
  clear() {
    this._pipe.clear();
  }
}

const noop = function () {
  return;
};

class SimpleFilter extends FilterSupport {
  constructor(sourceSound, pipe, callback = noop) {
    super(pipe);
    this.callback = callback;
    this.sourceSound = sourceSound;
    this.historyBufferSize = 22050;
    this._sourcePosition = 0;
    this.outputBufferPosition = 0;
    this._position = 0;
  }
  get position() {
    return this._position;
  }
  set position(position) {
    if (position > this._position) {
      throw new RangeError('New position may not be greater than current position');
    }
    const newOutputBufferPosition = this.outputBufferPosition - (this._position - position);
    if (newOutputBufferPosition < 0) {
      throw new RangeError('New position falls outside of history buffer');
    }
    this.outputBufferPosition = newOutputBufferPosition;
    this._position = position;
  }
  get sourcePosition() {
    return this._sourcePosition;
  }
  set sourcePosition(sourcePosition) {
    this.clear();
    this._sourcePosition = sourcePosition;
  }
  onEnd() {
    this.callback();
  }
  fillInputBuffer(numFrames = 0) {
    const samples = new Float32Array(numFrames * 2);
    const numFramesExtracted = this.sourceSound.extract(samples, numFrames, this._sourcePosition);
    this._sourcePosition += numFramesExtracted;
    this.inputBuffer.putSamples(samples, 0, numFramesExtracted);
  }
  extract(target, numFrames = 0) {
    this.fillOutputBuffer(this.outputBufferPosition + numFrames);
    const numFramesExtracted = Math.min(numFrames, this.outputBuffer.frameCount - this.outputBufferPosition);
    this.outputBuffer.extract(target, this.outputBufferPosition, numFramesExtracted);
    const currentFrames = this.outputBufferPosition + numFramesExtracted;
    this.outputBufferPosition = Math.min(this.historyBufferSize, currentFrames);
    this.outputBuffer.receive(Math.max(currentFrames - this.historyBufferSize, 0));
    this._position += numFramesExtracted;
    return numFramesExtracted;
  }
  handleSampleData(event) {
    this.extract(event.data, 4096);
  }
  clear() {
    super.clear();
    this.outputBufferPosition = 0;
  }
}

const USE_AUTO_SEQUENCE_LEN = 0;
const DEFAULT_SEQUENCE_MS = USE_AUTO_SEQUENCE_LEN;
const USE_AUTO_SEEKWINDOW_LEN = 0;
const DEFAULT_SEEKWINDOW_MS = USE_AUTO_SEEKWINDOW_LEN;
const DEFAULT_OVERLAP_MS = 8;
const _SCAN_OFFSETS = [[124, 186, 248, 310, 372, 434, 496, 558, 620, 682, 744, 806, 868, 930, 992, 1054, 1116, 1178, 1240, 1302, 1364, 1426, 1488, 0], [-100, -75, -50, -25, 25, 50, 75, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [-20, -15, -10, -5, 5, 10, 15, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [-4, -3, -2, -1, 1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]];
const AUTOSEQ_TEMPO_LOW = 0.25;
const AUTOSEQ_TEMPO_TOP = 4.0;
const AUTOSEQ_AT_MIN = 125.0;
const AUTOSEQ_AT_MAX = 50.0;
const AUTOSEQ_K = (AUTOSEQ_AT_MAX - AUTOSEQ_AT_MIN) / (AUTOSEQ_TEMPO_TOP - AUTOSEQ_TEMPO_LOW);
const AUTOSEQ_C = AUTOSEQ_AT_MIN - AUTOSEQ_K * AUTOSEQ_TEMPO_LOW;
const AUTOSEEK_AT_MIN = 25.0;
const AUTOSEEK_AT_MAX = 15.0;
const AUTOSEEK_K = (AUTOSEEK_AT_MAX - AUTOSEEK_AT_MIN) / (AUTOSEQ_TEMPO_TOP - AUTOSEQ_TEMPO_LOW);
const AUTOSEEK_C = AUTOSEEK_AT_MIN - AUTOSEEK_K * AUTOSEQ_TEMPO_LOW;
class Stretch extends AbstractFifoSamplePipe {
  constructor(createBuffers) {
    super(createBuffers);
    this._quickSeek = true;
    this.midBufferDirty = false;
    this.midBuffer = null;
    this.overlapLength = 0;
    this.autoSeqSetting = true;
    this.autoSeekSetting = true;
    this._tempo = 1;
    this.setParameters(44100, DEFAULT_SEQUENCE_MS, DEFAULT_SEEKWINDOW_MS, DEFAULT_OVERLAP_MS);
  }
  clear() {
    super.clear();
    this.clearMidBuffer();
  }
  clearMidBuffer() {
    this.midBufferDirty = false;
    this.midBuffer = null;
    if (this.refMidBuffer) {
      this.refMidBuffer.fill(0);
    }
    this.skipFract = 0;
  }
  setParameters(sampleRate, sequenceMs, seekWindowMs, overlapMs) {
    if (sampleRate > 0) {
      this.sampleRate = sampleRate;
    }
    if (overlapMs > 0) {
      this.overlapMs = overlapMs;
    }
    if (sequenceMs > 0) {
      this.sequenceMs = sequenceMs;
      this.autoSeqSetting = false;
    } else {
      this.autoSeqSetting = true;
    }
    if (seekWindowMs > 0) {
      this.seekWindowMs = seekWindowMs;
      this.autoSeekSetting = false;
    } else {
      this.autoSeekSetting = true;
    }
    this.calculateSequenceParameters();
    this.calculateOverlapLength(this.overlapMs);
    this.tempo = this._tempo;
  }
  set tempo(newTempo) {
    let intskip;
    this._tempo = newTempo;
    this.calculateSequenceParameters();
    this.nominalSkip = this._tempo * (this.seekWindowLength - this.overlapLength);
    this.skipFract = 0;
    intskip = Math.floor(this.nominalSkip + 0.5);
    this.sampleReq = Math.max(intskip + this.overlapLength, this.seekWindowLength) + this.seekLength;
  }
  get tempo() {
    return this._tempo;
  }
  get inputChunkSize() {
    return this.sampleReq;
  }
  get outputChunkSize() {
    return this.overlapLength + Math.max(0, this.seekWindowLength - 2 * this.overlapLength);
  }
  calculateOverlapLength(overlapInMsec = 0) {
    let newOvl;
    newOvl = this.sampleRate * overlapInMsec / 1000;
    newOvl = newOvl < 16 ? 16 : newOvl;
    newOvl -= newOvl % 8;
    this.overlapLength = newOvl;
    this.refMidBuffer = new Float32Array(this.overlapLength * 2);
    this.midBuffer = new Float32Array(this.overlapLength * 2);
  }
  checkLimits(x, mi, ma) {
    return x < mi ? mi : x > ma ? ma : x;
  }
  calculateSequenceParameters() {
    let seq;
    let seek;
    if (this.autoSeqSetting) {
      seq = AUTOSEQ_C + AUTOSEQ_K * this._tempo;
      seq = this.checkLimits(seq, AUTOSEQ_AT_MAX, AUTOSEQ_AT_MIN);
      this.sequenceMs = Math.floor(seq + 0.5);
    }
    if (this.autoSeekSetting) {
      seek = AUTOSEEK_C + AUTOSEEK_K * this._tempo;
      seek = this.checkLimits(seek, AUTOSEEK_AT_MAX, AUTOSEEK_AT_MIN);
      this.seekWindowMs = Math.floor(seek + 0.5);
    }
    this.seekWindowLength = Math.floor(this.sampleRate * this.sequenceMs / 1000);
    this.seekLength = Math.floor(this.sampleRate * this.seekWindowMs / 1000);
  }
  set quickSeek(enable) {
    this._quickSeek = enable;
  }
  clone() {
    const result = new Stretch();
    result.tempo = this._tempo;
    result.setParameters(this.sampleRate, this.sequenceMs, this.seekWindowMs, this.overlapMs);
    return result;
  }
  seekBestOverlapPosition() {
    return this._quickSeek ? this.seekBestOverlapPositionStereoQuick() : this.seekBestOverlapPositionStereo();
  }
  seekBestOverlapPositionStereo() {
    let bestOffset;
    let bestCorrelation;
    let correlation;
    let i = 0;
    this.preCalculateCorrelationReferenceStereo();
    bestOffset = 0;
    bestCorrelation = Number.MIN_VALUE;
    for (; i < this.seekLength; i = i + 1) {
      correlation = this.calculateCrossCorrelationStereo(2 * i, this.refMidBuffer);
      if (correlation > bestCorrelation) {
        bestCorrelation = correlation;
        bestOffset = i;
      }
    }
    return bestOffset;
  }
  seekBestOverlapPositionStereoQuick() {
    let bestOffset;
    let bestCorrelation;
    let correlation;
    let scanCount = 0;
    let correlationOffset;
    let tempOffset;
    this.preCalculateCorrelationReferenceStereo();
    bestCorrelation = Number.MIN_VALUE;
    bestOffset = 0;
    correlationOffset = 0;
    tempOffset = 0;
    for (; scanCount < 4; scanCount = scanCount + 1) {
      let j = 0;
      while (_SCAN_OFFSETS[scanCount][j]) {
        tempOffset = correlationOffset + _SCAN_OFFSETS[scanCount][j];
        if (tempOffset >= this.seekLength) {
          break;
        }
        correlation = this.calculateCrossCorrelationStereo(2 * tempOffset, this.refMidBuffer);
        if (correlation > bestCorrelation) {
          bestCorrelation = correlation;
          bestOffset = tempOffset;
        }
        j = j + 1;
      }
      correlationOffset = bestOffset;
    }
    return bestOffset;
  }
  preCalculateCorrelationReferenceStereo() {
    let i = 0;
    let context;
    let temp;
    for (; i < this.overlapLength; i = i + 1) {
      temp = i * (this.overlapLength - i);
      context = i * 2;
      this.refMidBuffer[context] = this.midBuffer[context] * temp;
      this.refMidBuffer[context + 1] = this.midBuffer[context + 1] * temp;
    }
  }
  calculateCrossCorrelationStereo(mixingPosition, compare) {
    const mixing = this._inputBuffer.vector;
    mixingPosition += this._inputBuffer.startIndex;
    let correlation = 0;
    let i = 2;
    const calcLength = 2 * this.overlapLength;
    let mixingOffset;
    for (; i < calcLength; i = i + 2) {
      mixingOffset = i + mixingPosition;
      correlation += mixing[mixingOffset] * compare[i] + mixing[mixingOffset + 1] * compare[i + 1];
    }
    return correlation;
  }
  overlap(overlapPosition) {
    this.overlapStereo(2 * overlapPosition);
  }
  overlapStereo(inputPosition) {
    const input = this._inputBuffer.vector;
    inputPosition += this._inputBuffer.startIndex;
    const output = this._outputBuffer.vector;
    const outputPosition = this._outputBuffer.endIndex;
    let i = 0;
    let context;
    let tempFrame;
    const frameScale = 1 / this.overlapLength;
    let fi;
    let inputOffset;
    let outputOffset;
    for (; i < this.overlapLength; i = i + 1) {
      tempFrame = (this.overlapLength - i) * frameScale;
      fi = i * frameScale;
      context = 2 * i;
      inputOffset = context + inputPosition;
      outputOffset = context + outputPosition;
      output[outputOffset + 0] = input[inputOffset + 0] * fi + this.midBuffer[context + 0] * tempFrame;
      output[outputOffset + 1] = input[inputOffset + 1] * fi + this.midBuffer[context + 1] * tempFrame;
    }
  }
  process() {
    let offset;
    let temp;
    let overlapSkip;
    if (this.midBuffer === null) {
      if (this._inputBuffer.frameCount < this.overlapLength) {
        return;
      }
      this.midBuffer = new Float32Array(this.overlapLength * 2);
      this._inputBuffer.receiveSamples(this.midBuffer, this.overlapLength);
    }
    while (this._inputBuffer.frameCount >= this.sampleReq) {
      offset = this.seekBestOverlapPosition();
      this._outputBuffer.ensureAdditionalCapacity(this.overlapLength);
      this.overlap(Math.floor(offset));
      this._outputBuffer.put(this.overlapLength);
      temp = this.seekWindowLength - 2 * this.overlapLength;
      if (temp > 0) {
        this._outputBuffer.putBuffer(this._inputBuffer, offset + this.overlapLength, temp);
      }
      const start = this._inputBuffer.startIndex + 2 * (offset + this.seekWindowLength - this.overlapLength);
      this.midBuffer.set(this._inputBuffer.vector.subarray(start, start + 2 * this.overlapLength));
      this.skipFract += this.nominalSkip;
      overlapSkip = Math.floor(this.skipFract);
      this.skipFract -= overlapSkip;
      this._inputBuffer.receive(overlapSkip);
    }
  }
}

const testFloatEqual = function (a, b) {
  return (a > b ? a - b : b - a) > 1e-10;
};

class SoundTouch {
  constructor() {
    this.transposer = new RateTransposer(false);
    this.stretch = new Stretch(false);
    this._inputBuffer = new FifoSampleBuffer();
    this._intermediateBuffer = new FifoSampleBuffer();
    this._outputBuffer = new FifoSampleBuffer();
    this._rate = 0;
    this._tempo = 0;
    this.virtualPitch = 1.0;
    this.virtualRate = 1.0;
    this.virtualTempo = 1.0;
    this.calculateEffectiveRateAndTempo();
  }
  clear() {
    this.transposer.clear();
    this.stretch.clear();
  }
  clone() {
    const result = new SoundTouch();
    result.rate = this.rate;
    result.tempo = this.tempo;
    return result;
  }
  get rate() {
    return this._rate;
  }
  set rate(rate) {
    this.virtualRate = rate;
    this.calculateEffectiveRateAndTempo();
  }
  set rateChange(rateChange) {
    this._rate = 1.0 + 0.01 * rateChange;
  }
  get tempo() {
    return this._tempo;
  }
  set tempo(tempo) {
    this.virtualTempo = tempo;
    this.calculateEffectiveRateAndTempo();
  }
  set tempoChange(tempoChange) {
    this.tempo = 1.0 + 0.01 * tempoChange;
  }
  set pitch(pitch) {
    this.virtualPitch = pitch;
    this.calculateEffectiveRateAndTempo();
  }
  set pitchOctaves(pitchOctaves) {
    this.pitch = Math.exp(0.69314718056 * pitchOctaves);
    this.calculateEffectiveRateAndTempo();
  }
  set pitchSemitones(pitchSemitones) {
    this.pitchOctaves = pitchSemitones / 12.0;
  }
  get inputBuffer() {
    return this._inputBuffer;
  }
  get outputBuffer() {
    return this._outputBuffer;
  }
  calculateEffectiveRateAndTempo() {
    const previousTempo = this._tempo;
    const previousRate = this._rate;
    this._tempo = this.virtualTempo / this.virtualPitch;
    this._rate = this.virtualRate * this.virtualPitch;
    if (testFloatEqual(this._tempo, previousTempo)) {
      this.stretch.tempo = this._tempo;
    }
    if (testFloatEqual(this._rate, previousRate)) {
      this.transposer.rate = this._rate;
    }
    if (this._rate > 1.0) {
      if (this._outputBuffer != this.transposer.outputBuffer) {
        this.stretch.inputBuffer = this._inputBuffer;
        this.stretch.outputBuffer = this._intermediateBuffer;
        this.transposer.inputBuffer = this._intermediateBuffer;
        this.transposer.outputBuffer = this._outputBuffer;
      }
    } else {
      if (this._outputBuffer != this.stretch.outputBuffer) {
        this.transposer.inputBuffer = this._inputBuffer;
        this.transposer.outputBuffer = this._intermediateBuffer;
        this.stretch.inputBuffer = this._intermediateBuffer;
        this.stretch.outputBuffer = this._outputBuffer;
      }
    }
  }
  process() {
    if (this._rate > 1.0) {
      this.stretch.process();
      this.transposer.process();
    } else {
      this.transposer.process();
      this.stretch.process();
    }
  }
}



function soundTouchPitchShift(mono, semitones, sampleRate) {
  if (semitones === 0) return mono.slice();
  const pitchFactor = Math.pow(2, semitones / 12);
  const st = new SoundTouch();
  st.pitch = pitchFactor;
  st.tempo = 1.0;
  const len = mono.length;
  const src = {
    buffer: mono,
    sampleRate: sampleRate,
    extract: function(target, numFrames, position) {
      const framesAvail = Math.min(numFrames, len - position);
      if (framesAvail <= 0) return 0;
      for (let i = 0; i < framesAvail; i++) {
        target[i * 2]     = this.buffer[position + i];
        target[i * 2 + 1] = this.buffer[position + i];
      }
      return framesAvail;
    }
  };
  const filter = new SimpleFilter(src, st);
  const outputFrames = [];
  const chunkSize = 4096;
  const tmpBuf = new Float32Array(chunkSize * 2);
  let totalExtracted = 0;
  while (true) {
    const extracted = filter.extract(tmpBuf, chunkSize);
    if (extracted === 0) break;
    outputFrames.push(tmpBuf.slice(0, extracted * 2));
    totalExtracted += extracted;
    if (totalExtracted > len * 2) break;
  }
  if (outputFrames.length === 0) return mono.slice();
  const out = new Float32Array(totalExtracted);
  let off = 0;
  for (const chunk of outputFrames) {
    const frames = chunk.length / 2;
    for (let i = 0; i < frames; i++) out[off++] = (chunk[i*2] + chunk[i*2+1]) * 0.5;
  }
  if (out.length >= mono.length) return out.subarray(0, mono.length).slice();
  const padded = new Float32Array(mono.length);
  padded.set(out);
  return padded;
}

// ═══════════════════════════════════════════════════════════════
// RUBBER BAND WASM — Init
// ═══════════════════════════════════════════════════════════════
let rbApi = null;
let rbReady = false;
let rbInitPromise = null; // lazy — initialisé seulement au premier appel

async function initRubberBand() {
  if (rbInitPromise) return rbInitPromise;
  rbInitPromise = (async () => {
  try {
    const jsResp = await fetch('/rubberband.umd.min.js', { cache: 'no-store' });
    if (!jsResp.ok) throw new Error('rubberband.umd.min.js HTTP ' + jsResp.status);
    const ct = jsResp.headers.get('content-type') || '';
    if (ct.includes('text/html')) throw new Error('rubberband.umd.min.js retourne HTML');
    const jsText = await jsResp.text();

    // Exécuter le UMD en fournissant un faux module/exports pour capturer l'export
    const fakeModule = { exports: {} };
    // eslint-disable-next-line no-new-func
    (new Function('module', 'exports', jsText))(fakeModule, fakeModule.exports);

    // Le UMD peut exporter via module.exports ou assigner à self.rubberband
    const rb = fakeModule.exports?.default || fakeModule.exports
      || self.rubberband || (globalThis as any).rubberband;

    if (!rb) throw new Error('rubberband export non trouvé');
    const RBI = rb.RubberBandInterface || rb.default?.RubberBandInterface;
    if (!RBI) throw new Error('RubberBandInterface non trouvé dans le module');

    // Charger le WASM — utiliser compile (pas compileStreaming) pour éviter
    // les problèmes de Content-Type sur certains environnements
    const wasmResp = await fetch('/rubberband.wasm', { cache: 'no-store' });
    if (!wasmResp.ok) throw new Error('rubberband.wasm HTTP ' + wasmResp.status);
    const wasmBuf = await wasmResp.arrayBuffer();
    const wasm = await WebAssembly.compile(wasmBuf);
    rbApi = await RBI.initialize(wasm);
    rbReady = true;
    console.log('[HarmonyWorker] Rubber Band WASM prêt ✅');
  } catch(e: any) {
    console.error('[HarmonyWorker] Rubber Band init failed:', e.message);
    rbReady = false;
  }
  })();
  return rbInitPromise;
}

// ═══════════════════════════════════════════════════════════════
// RUBBER BAND PITCH SHIFT — API officielle rubberband-wasm v3.3.0
// Options : FormantPreserved (0x01000000) + HighQualityPitch (0x02000000)
// Deux passes : study (analyse) + process (traitement) → meilleure qualité
// ═══════════════════════════════════════════════════════════════
function rbPitchShift(mono, semitones, sampleRate) {
  // Fallback SoundTouch si Rubber Band non disponible
  if (!rbApi || !rbReady) {
    console.warn('[HarmonyWorker] Rubber Band indisponible — fallback SoundTouch');
    return soundTouchPitchShift(mono, semitones, sampleRate);
  }
  if (semitones === 0) return mono.slice();

  const pitchScale = Math.pow(2, semitones / 12);
  const timeRatio = 1.0; // durée inchangée

  // Options : FormantPreserved + HighQualityPitch
  const RB_OPTION_FORMANT_PRESERVED = 0x01000000;
  const RB_OPTION_PITCH_HIGH_QUALITY = 0x02000000;
  const options = RB_OPTION_FORMANT_PRESERVED | RB_OPTION_PITCH_HIGH_QUALITY;

  const numChannels = 1;
  const rbState = rbApi.rubberband_new(sampleRate, numChannels, options, timeRatio, pitchScale);
  rbApi.rubberband_set_pitch_scale(rbState, pitchScale);
  rbApi.rubberband_set_time_ratio(rbState, timeRatio);
  rbApi.rubberband_set_expected_input_duration(rbState, mono.length);

  const samplesRequired = Math.max(rbApi.rubberband_get_samples_required(rbState) || 1024, 512);
  const outputSamples = Math.ceil(mono.length * timeRatio) + 8192;
  const outputBuffer = new Float32Array(outputSamples);

  // Allouer la mémoire WASM
  const channelArrayPtr = rbApi.malloc(numChannels * 4);
  const channelDataPtr = rbApi.malloc(samplesRequired * 4);
  rbApi.memWritePtr(channelArrayPtr, channelDataPtr);

  try {
    // ── Passe 1 : Study (analyse du signal complet) ──────────────────
    let read = 0;
    while (read < mono.length) {
      const remaining = Math.min(samplesRequired, mono.length - read);
      const chunk = mono.subarray(read, read + remaining);
      rbApi.memWrite(channelDataPtr, chunk);
      const isFinal = (read + remaining >= mono.length) ? 1 : 0;
      rbApi.rubberband_study(rbState, channelArrayPtr, remaining, isFinal);
      read += remaining;
    }

    // ── Passe 2 : Process (traitement) ───────────────────────────────
    read = 0;
    let write = 0;

    const tryRetrieve = (final) => {
      while (true) {
        const available = rbApi.rubberband_available(rbState);
        if (available < 1) break;
        if (!final && available < samplesRequired) break;
        const toRead = Math.min(samplesRequired, available, outputSamples - write);
        if (toRead <= 0) break;
        const recv = rbApi.rubberband_retrieve(rbState, channelArrayPtr, toRead);
        const out = rbApi.memReadF32(channelDataPtr, recv);
        outputBuffer.set(out.subarray(0, recv), write);
        write += recv;
      }
    };

    while (read < mono.length) {
      const remaining = Math.min(samplesRequired, mono.length - read);
      const chunk = mono.subarray(read, read + remaining);
      rbApi.memWrite(channelDataPtr, chunk);
      const isFinal = (read + remaining >= mono.length) ? 1 : 0;
      rbApi.rubberband_process(rbState, channelArrayPtr, remaining, isFinal);
      tryRetrieve(false);
      read += remaining;
    }
    tryRetrieve(true);

    // Ajuster la longueur au signal original
    const result = write >= mono.length
      ? outputBuffer.subarray(0, mono.length)
      : (() => { const p = new Float32Array(mono.length); p.set(outputBuffer.subarray(0, write)); return p; })();

    return result.slice(); // slice pour détacher du buffer WASM

  } finally {
    rbApi.free(channelDataPtr);
    rbApi.free(channelArrayPtr);
    rbApi.rubberband_delete(rbState);
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
  const { id, op, channelL, channelR, semitones, gain, pan, sampleRate, trackIndex } = e.data;
  try {
    // Init Rubber Band au premier appel seulement (lazy)
    await initRubberBand();
    // Si Rubber Band échoue, rbPitchShift utilise SoundTouch automatiquement
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
