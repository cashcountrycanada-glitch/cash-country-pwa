// harmony-worker.js v8 — Studio Pro Max
// Nouvelles améliorations vs v7 :
//   1. Hop adaptatif aux transients (HNS — Hybrid Transient/Steady-state)
//      → consonnes nettes, voyelles fluides
//   2. Détection F0 (YIN algorithm) + phase locking sur le fondamental
//      → harmonies vraiment "dans la note"
//   3. Correction formants par voyelle détectée (A/E/I/O/U)
//      → timbre naturel par voyelle, pas une correction générique
//   4. Jitter organique continu (pitch drift + amplitude flutter + micro-vibrato)
//      → simule les micro-variations d'un vrai chanteur
//   5. Reverb de salle courte (Schroeder allpass + comb filters)
//      → place les harmonies "dans l'espace", les sépare de la voix sèche

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

// ── Détection F0 — algorithme YIN simplifié ───────────────────────────────
// YIN : Cheveigné & Kawahara (2002) — standard industrie pour pitch vocal
// Retourne le F0 en Hz (0 si non-voisé)
function detectF0(frame, sr) {
  const N = frame.length;
  const tauMax = Math.min(N >> 1, Math.floor(sr / 60));  // max 60 Hz
  const tauMin = Math.floor(sr / 1000);                  // min 1000 Hz

  // Fonction de différence
  const d = new Float32Array(tauMax+1);
  for (let tau=1;tau<=tauMax;tau++) {
    let sum=0;
    for (let j=0;j<tauMax;j++) {
      const diff=frame[j]-frame[j+tau]; sum+=diff*diff;
    }
    d[tau]=sum;
  }

  // Fonction de différence normalisée cumulative (CMNDF)
  const cmndf = new Float32Array(tauMax+1);
  cmndf[0]=1; let runSum=0;
  for (let tau=1;tau<=tauMax;tau++) {
    runSum+=d[tau];
    cmndf[tau]= runSum>0 ? d[tau]*tau/runSum : 1;
  }

  // Chercher le premier minimum sous le seuil 0.10
  const threshold=0.10;
  for (let tau=tauMin;tau<=tauMax;tau++) {
    if (cmndf[tau]<threshold) {
      // Raffinement parabolique
      if (tau>0 && tau<tauMax) {
        const s0=cmndf[tau-1], s1=cmndf[tau], s2=cmndf[tau+1];
        const refined=tau+(s2-s0)/(2*(2*s1-s0-s2));
        return sr/refined;
      }
      return sr/tau;
    }
  }
  return 0; // non-voisé
}

// ── Détection de voyelle par formants F1/F2 ───────────────────────────────
// Mesure les deux premiers formants et classe dans A/E/I/O/U
// F1 basse + F2 basse = O/U, F1 haute = A, F2 très haute = I/E
function detectVowel(frame, sr) {
  const N = 512;
  const win = new Float32Array(N);
  for (let i=0;i<N;i++) win[i]=0.5*(1-Math.cos(2*Math.PI*i/(N-1)));
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let i=0;i<N;i++) re[i]=(i<frame.length?frame[i]:0)*win[i];
  fft(re,im);

  const mag = new Float32Array(N/2+1);
  for (let k=0;k<=N/2;k++) mag[k]=Math.sqrt(re[k]*re[k]+im[k]*im[k]);

  // Lissage spectral (moving average 5 bins) pour trouver les vrais pics formants
  const smooth = new Float32Array(N/2+1);
  for (let k=2;k<N/2-2;k++) smooth[k]=(mag[k-2]+mag[k-1]+mag[k]+mag[k+1]+mag[k+2])/5;

  // Trouver les 2 premiers pics formants (F1 entre 200-1000Hz, F2 entre 700-3000Hz)
  const binHz = sr / N;
  const f1Min=Math.floor(200/binHz), f1Max=Math.floor(1000/binHz);
  const f2Min=Math.floor(700/binHz), f2Max=Math.floor(3000/binHz);

  let f1=0, f1Mag=0;
  for (let k=f1Min;k<f1Max;k++) {
    if (smooth[k]>smooth[k-1]&&smooth[k]>=smooth[k+1]&&smooth[k]>f1Mag) { f1=k*binHz; f1Mag=smooth[k]; }
  }
  let f2=0, f2Mag=0;
  for (let k=f2Min;k<f2Max;k++) {
    if (smooth[k]>smooth[k-1]&&smooth[k]>=smooth[k+1]&&smooth[k]>f2Mag&&k*binHz>f1*1.2) { f2=k*binHz; f2Mag=smooth[k]; }
  }

  if (f1===0||f2===0) return 'neutral';

  // Classification F1/F2 (valeurs moyennes langue française/anglaise)
  //        F1      F2
  // A :   800    1200
  // E :   400    2200
  // I :   300    2700
  // O :   500     700
  // U :   350     700
  if (f1>650) return 'A';
  if (f2>2400) return 'I';
  if (f2>1800) return 'E';
  if (f1>420) return 'O';
  return 'U';
}

// ── Enveloppe spectrale cepstrale ─────────────────────────────────────────
function extractSpectralEnvelope(mag, N, lifterOrder) {
  const logMag = new Float32Array(N);
  for (let k=0;k<N;k++) logMag[k]=Math.log(Math.max(mag[k],1e-10));
  const cRe=new Float32Array(N), cIm=new Float32Array(N);
  for (let k=0;k<N;k++) cRe[k]=logMag[k];
  fft(cRe,cIm);
  for (let k=lifterOrder;k<N-lifterOrder;k++) { cRe[k]=0; cIm[k]=0; }
  ifft(cRe,cIm);
  const env=new Float32Array(N);
  for (let k=0;k<N;k++) env[k]=Math.exp(cRe[k]);
  return env;
}

// ── Phase Vocoder avec hop adaptatif + phase locking F0 ───────────────────
function phaseVocoderShift(input, semitones, sr) {
  if (semitones===0) return input.slice();
  const pitchFactor = Math.pow(2, semitones/12);
  const N = 4096;
  const hopBase = N >> 2; // 1024 — hop de base

  const win = new Float32Array(N);
  for (let i=0;i<N;i++) win[i]=0.5*(1-Math.cos(2*Math.PI*i/(N-1)));

  // Détection d'énergie par bloc (512 samples) pour repérer les transients
  const blockSize = 512;
  const numBlocks = Math.floor(input.length / blockSize);
  const energy = new Float32Array(numBlocks);
  for (let b=0;b<numBlocks;b++) {
    let e=0;
    for (let i=0;i<blockSize;i++) { const s=input[b*blockSize+i]||0; e+=s*s; }
    energy[b]=e/blockSize;
  }

  // Construire la liste des hops adaptatifs
  // Sur un transient (énergie monte >3x) → hop court (N/8) pour préserver l'attaque
  // Sur du steady-state → hop normal (N/4)
  const frames = [];
  let pos = 0;
  while (pos < input.length - N) {
    const blockIdx = Math.floor(pos / blockSize);
    const prevIdx  = Math.max(0, blockIdx-1);
    const isTransient = blockIdx>0 && energy[blockIdx] > energy[prevIdx]*3.0;
    const hop = isTransient ? (N >> 3) : hopBase; // N/8=512 sur transient, N/4=1024 sinon
    frames.push({ pos, hop });
    pos += hop;
  }
  if (frames.length===0) frames.push({ pos:0, hop:hopBase });

  // Calculer outLen total
  const hopS_base = Math.min(Math.round(hopBase/pitchFactor), N>>1);
  const outLen = Math.ceil(frames.length * hopS_base * 1.1) + N;
  const output  = new Float32Array(outLen);
  const normOut = new Float32Array(outLen);
  const lastPhaseIn = new Float32Array(N/2+1);
  const phaseOut    = new Float32Array(N/2+1);

  // Init phase sur le premier frame
  {
    const re0=new Float32Array(N), im0=new Float32Array(N);
    for (let i=0;i<N;i++) re0[i]=(i<input.length?input[i]:0)*win[i];
    fft(re0,im0);
    for (let k=0;k<=N/2;k++) lastPhaseIn[k]=Math.atan2(im0[k],re0[k]);
  }

  // Buffers pré-alloués hors boucle — évite 863MB de GC pressure sur iPhone
  const re      = new Float32Array(N);
  const im      = new Float32Array(N);
  const mag     = new Float32Array(N/2+1);
  const trueFreq= new Float32Array(N/2+1);
  const isPeak  = new Uint8Array(N/2+1);
  const peakOf  = new Int32Array(N/2+1);
  const peakPhaseOut = new Float32Array(N/2+1);
  const outRe   = new Float32Array(N);
  const outIm   = new Float32Array(N);
  let outPos = 0;
  let cachedF0Hz = 0;
  let frameIdx = 0;
  for (const { pos, hop } of frames) {
    frameIdx++;
    const hopS = Math.min(Math.round(hop/pitchFactor), N>>1);
    // Réutiliser les buffers pré-alloués (évite GC pressure)
    re.fill(0); im.fill(0);
    for (let i=0;i<N;i++) re[i]=(pos+i<input.length?input[pos+i]:0)*win[i];
    fft(re,im);

    // Magnitudes + true frequencies
    mag.fill(0); trueFreq.fill(0);
    for (let k=0;k<=N/2;k++) {
      mag[k]=Math.sqrt(re[k]*re[k]+im[k]*im[k]);
      const phase=Math.atan2(im[k],re[k]);
      let dPhase=phase-lastPhaseIn[k]; lastPhaseIn[k]=phase;
      const exp=2*Math.PI*k*hop/N; dPhase-=exp;
      dPhase-=2*Math.PI*Math.round(dPhase/(2*Math.PI));
      trueFreq[k]=k+dPhase*N/(2*Math.PI*hop);
    }

    // Détecter F0 toutes les 20 frames seulement (économie CPU ×20)
    // F0 vocal change lentement — 20 frames ≈ 460ms, largement suffisant
    if (frameIdx % 20 === 0) {
      const frameSlice = input.slice(pos, Math.min(pos+N, input.length));
      cachedF0Hz = detectF0(frameSlice, sr);
    }
    const f0Bin = cachedF0Hz > 0 ? Math.round(cachedF0Hz * N / sr) : 0;

    // Phase locking : pics spectraux + verrouillage sur les harmoniques du F0
    isPeak.fill(0);
    for (let k=1;k<N/2;k++) {
      if (mag[k]>mag[k-1]&&mag[k]>=mag[k+1]) {
        // Renforcer les pics qui coïncident avec un harmonique du F0
        if (f0Bin>0) {
          const harmonic = Math.round(k/f0Bin);
          if (harmonic>=1 && Math.abs(k - harmonic*f0Bin) <= 2) isPeak[k]=1;
          else if (mag[k] > mag[k-1]*1.3) isPeak[k]=1; // pic fort non-harmonique
        } else {
          isPeak[k]=1;
        }
      }
    }

    // Propagation vers les bins voisins
    peakOf.fill(0);
    let lastP=0;
    for (let k=0;k<=N/2;k++) { if(isPeak[k]) lastP=k; peakOf[k]=lastP; }
    let nextP=N/2;
    for (let k=N/2;k>=0;k--) {
      if(isPeak[k]) nextP=k;
      if(Math.abs(k-peakOf[k])>Math.abs(k-nextP)) peakOf[k]=nextP;
    }

    peakPhaseOut.fill(0);
    outRe.fill(0); outIm.fill(0);
    for (let k=0;k<=N/2;k++) {
      if(isPeak[k]) {
        phaseOut[k]+=2*Math.PI*trueFreq[k]*hopS/N;
        peakPhaseOut[k]=phaseOut[k];
      }
    }
    for (let k=0;k<=N/2;k++) {
      const p=peakOf[k];
      const phase=isPeak[k]
        ? peakPhaseOut[k]
        : peakPhaseOut[p]+(Math.atan2(im[k],re[k])-Math.atan2(im[p],re[p]));
      if(!isPeak[k]) phaseOut[k]=phase;
      outRe[k]=mag[k]*Math.cos(phase); outIm[k]=mag[k]*Math.sin(phase);
      if(k>0&&k<N/2) { outRe[N-k]=outRe[k]; outIm[N-k]=-outIm[k]; }
    }

    ifft(outRe,outIm);
    for (let i=0;i<N&&outPos+i<outLen;i++) {
      output[outPos+i]+=outRe[i]*win[i]; normOut[outPos+i]+=win[i]*win[i];
    }
    outPos+=hopS;
  }

  const targetLen=Math.floor(input.length/pitchFactor);
  const result=new Float32Array(targetLen);
  const resampleRatio=outLen/targetLen;
  for (let i=0;i<targetLen;i++) {
    const src=i*resampleRatio;
    const i0=Math.floor(src), frac=src-i0;
    const i1=Math.min(i0+1,outLen-1);
    const v0=i0<outLen&&normOut[i0]>0.001?output[i0]/normOut[i0]:0;
    const v1=i1<outLen&&normOut[i1]>0.001?output[i1]/normOut[i1]:0;
    result[i]=v0+(v1-v0)*frac;
  }
  return result;
}

// ── Correction formants par voyelle ──────────────────────────────────────
// Blend adapté selon la voyelle détectée :
// A : correction forte (F1 haut, formants très distincts)
// I/E : correction modérée (F2 très élevé, risque chipmunk)
// O/U : correction légère (graves, éviter le son nasal)
function applyFormantShift(shifted, semitones, sr) {
  const absST=Math.abs(semitones);
  if (absST<3) return shifted;
  if (semitones<=-10) return shifted;

  const N=1024, hop=256;
  const LIFTER=32;
  const win=new Float32Array(N);
  for (let i=0;i<N;i++) win[i]=0.5*(1-Math.cos(2*Math.PI*i/(N-1)));

  // Analyser la voyelle dominante sur une fenêtre centrale de la piste
  const centerStart = Math.floor(shifted.length/2 - N/2);
  const vowelFrame  = shifted.slice(Math.max(0,centerStart), centerStart+N);
  const vowel       = detectVowel(vowelFrame, sr);

  // Blend par voyelle + direction du shift
  let blend;
  if (semitones<0) {
    // Graves : toujours léger
    blend = vowel==='A' ? 0.30 : 0.20;
  } else if (absST<6) {
    const t=(absST-3)/3;
    if      (vowel==='A') blend=0.50+t*0.30;       // A : 50→80%
    else if (vowel==='I'||vowel==='E') blend=0.30+t*0.25; // I/E : 30→55%
    else                  blend=0.35+t*0.25;        // O/U/neutral : 35→60%
  } else {
    if      (vowel==='A') blend=0.80;
    else if (vowel==='I'||vowel==='E') blend=0.55;
    else                  blend=0.65;
  }

  const pitchFactor=Math.pow(2,semitones/12);
  const outLen=shifted.length;
  const output=new Float32Array(outLen), norm=new Float32Array(outLen);
  const numFrames=Math.ceil((outLen-N)/hop)+1;

  for (let frame=0;frame<numFrames;frame++) {
    const off=frame*hop;
    const re=new Float32Array(N), im=new Float32Array(N);
    for (let i=0;i<N;i++) re[i]=(off+i<outLen?shifted[off+i]:0)*win[i];
    fft(re,im);

    const fullMag=new Float32Array(N);
    for (let k=0;k<=N/2;k++) {
      fullMag[k]=Math.sqrt(re[k]*re[k]+im[k]*im[k])+1e-10;
      fullMag[N-1-k]=fullMag[k];
    }
    const envShifted=extractSpectralEnvelope(fullMag,N,LIFTER);
    const outRe=new Float32Array(N), outIm=new Float32Array(N);

    for (let k=0;k<=N/2;k++) {
      const srcK=k/pitchFactor;
      const srcIdx=Math.min(Math.floor(srcK),N/2-1);
      const frac=srcK-Math.floor(srcK);
      const envSrc=envShifted[srcIdx]+(envShifted[Math.min(srcIdx+1,N/2)]-envShifted[srcIdx])*frac;
      const envCurrent=envShifted[k];
      const rawRatio=envCurrent>1e-10?envSrc/envCurrent:1;
      const ratio=1+(rawRatio-1)*blend;
      outRe[k]=re[k]*ratio; outIm[k]=im[k]*ratio;
      if(k>0&&k<N/2) { outRe[N-k]=outRe[k]; outIm[N-k]=-outIm[k]; }
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

// ── Jitter organique continu ──────────────────────────────────────────────
// Trois couches de variation simultanées :
//   A) Pitch drift : LFO basse fréquence (0.05Hz) ±4 cents via resampling
//   B) Amplitude flutter : LFO 6Hz ±3% (tremblement naturel de la voix)
//   C) Micro-vibrato : LFO 5.2Hz ±8 cents (vibrato léger, humain)
// Seed déterministe basé sur le contenu → même résultat à chaque génération
function applyOrganicJitter(signal, sr) {
  const len=signal.length;
  const result=new Float32Array(len);

  // Seed pseudo-random reproductible
  let seed=0;
  for (let i=0;i<Math.min(128,len);i++) seed=(seed*31+Math.round(signal[i]*10000))|0;
  const rand=()=>{ seed=(seed*1664525+1013904223)|0; return (seed>>>0)/0xFFFFFFFF; };

  // Paramètres des LFOs — phases légèrement aléatoires pour éviter la synchronicité
  const driftRate  = 0.05;  // Hz — dérive lente
  const flutterRate= 6.0;   // Hz — flutter amplitude
  const vibratoRate= 5.2;   // Hz — vibrato

  const driftPhase0  = rand()*Math.PI*2;
  const flutterPhase0= rand()*Math.PI*2;
  const vibratoPhase0= rand()*Math.PI*2;

  // Amplitude du vibrato varie dans le temps (un vrai chanteur ne vibrate pas uniformément)
  // On module l'amplitude du vibrato avec un LFO très lent (0.07Hz)
  const vibratoModRate = 0.07;
  const vibratoModPhase= rand()*Math.PI*2;

  for (let i=0;i<len;i++) {
    const t=i/sr;

    // A) Pitch drift ±4 cents → ratio de resampling
    const driftCents = Math.sin(2*Math.PI*driftRate*t + driftPhase0) * 4.0;

    // B) Vibrato ±8 cents avec amplitude modulée
    const vibratoAmp = 8.0 * (0.5 + 0.5*Math.sin(2*Math.PI*vibratoModRate*t + vibratoModPhase));
    const vibratoCents = Math.sin(2*Math.PI*vibratoRate*t + vibratoPhase0) * vibratoAmp;

    // Total pitch en cents → ratio
    const totalCents = driftCents + vibratoCents;
    const pitchRatio = Math.pow(2, totalCents/1200);

    // Position source avec pitch ratio
    const srcPos = i * pitchRatio;
    const s0=Math.floor(srcPos), s1=Math.min(s0+1,len-1);
    const frac=srcPos-s0;
    const pitched = s0>=0&&s0<len
      ? (signal[s0]||0)*(1-frac)+(signal[s1]||0)*frac
      : 0;

    // C) Flutter d'amplitude ±3%
    const flutter = 1.0 + Math.sin(2*Math.PI*flutterRate*t + flutterPhase0) * 0.03;

    result[i] = pitched * flutter;
  }
  return result;
}

// ── Reverb de salle courte (Schroeder) ───────────────────────────────────
// 4 comb filters en parallèle + 2 allpass en série
// Pre-delay 8ms, decay ~400ms — place les harmonies dans l'espace
// dryWet : 0=sec, 1=100% reverb (on utilise 0.18 = 18% wet)
function applyRoomReverb(signal, sr, dryWet) {
  if (dryWet<=0) return signal;
  const len=signal.length;

  // Paramètres Schroeder classiques (ajustés pour voix)
  const combDelays = [
    Math.floor(0.0297*sr), Math.floor(0.0371*sr),
    Math.floor(0.0411*sr), Math.floor(0.0437*sr)
  ];
  const combGains  = [0.805, 0.827, 0.783, 0.764];
  const apDelays   = [Math.floor(0.0127*sr), Math.floor(0.0090*sr)];
  const apGains    = [0.7, 0.7];
  const preDelay   = Math.floor(0.008*sr); // 8ms pre-delay

  // Buffers comb
  const combBufs = combDelays.map(d => new Float32Array(d));
  const combPtrs = new Int32Array(4);

  // Buffers allpass
  const apBufs = apDelays.map(d => new Float32Array(d));
  const apPtrs = new Int32Array(2);

  // Buffer pre-delay
  const preBuf = new Float32Array(preDelay);
  let prePtr = 0;

  const wet = new Float32Array(len);

  for (let i=0;i<len;i++) {
    // Pre-delay
    const preSample = preBuf[prePtr];
    preBuf[prePtr] = signal[i]||0;
    prePtr = (prePtr+1) % preDelay;

    // 4 comb filters en parallèle
    let combOut=0;
    for (let c=0;c<4;c++) {
      const buf=combBufs[c];
      const dly=combDelays[c];
      const ptr=combPtrs[c];
      const delayed=buf[ptr];
      buf[ptr]=preSample+delayed*combGains[c];
      combPtrs[c]=(ptr+1)%dly;
      combOut+=delayed;
    }
    combOut*=0.25; // normaliser

    // 2 allpass en série
    let apOut=combOut;
    for (let a=0;a<2;a++) {
      const buf=apBufs[a];
      const dly=apDelays[a];
      const ptr=apPtrs[a];
      const delayed=buf[ptr];
      const inp=apOut+delayed*apGains[a];
      buf[ptr]=inp;
      apPtrs[a]=(ptr+1)%dly;
      apOut=delayed-apGains[a]*inp;
    }

    wet[i]=apOut;
  }

  // Mélanger dry + wet
  const result=new Float32Array(len);
  for (let i=0;i<len;i++) result[i]=signal[i]*(1-dryWet)+wet[i]*dryWet;
  return result;
}

// ── Saturation harmonique douce ───────────────────────────────────────────
function applySoftSaturation(signal, drive) {
  if (drive<=0) return signal;
  const result=new Float32Array(signal.length);
  const gain=1+drive*2.5;
  for (let i=0;i<signal.length;i++) {
    const x=signal[i]*gain;
    result[i]=x/(1+Math.abs(x))*(1/gain)*1.05;
  }
  return result;
}

// ── Double tracking pro ───────────────────────────────────────────────────
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
  const sL=resample(mono,1/Math.pow(2, 0.13/12));
  const sR=resample(mono,1/Math.pow(2,-0.13/12));
  const dL=Math.floor(0.018*sr), dR=Math.floor(0.035*sr);
  const outLen=len+Math.floor(0.045*sr);
  const outL=new Float32Array(outLen), outR=new Float32Array(outLen);
  for (let i=0;i<len;i++) { outL[i]+=mono[i]*0.70; outR[i]+=mono[i]*0.70; }
  const llLen=Math.min(sL.length,outLen-dL);
  for (let i=0;i<llLen;i++) { const s=sL[i]*0.55; outL[i+dL]+=s*0.85; outR[i+dL]+=s*0.15; }
  const rrLen=Math.min(sR.length,outLen-dR);
  for (let i=0;i<rrLen;i++) { const s=sR[i]*0.55; outL[i+dR]+=s*0.15; outR[i+dR]+=s*0.85; }
  let peak=0;
  for (let i=0;i<outLen;i++) peak=Math.max(peak,Math.abs(outL[i]),Math.abs(outR[i]));
  if (peak>0.95) { const n=0.95/peak; for(let i=0;i<outLen;i++){outL[i]*=n;outR[i]*=n;} }
  return { outL, outR, outLen };
}

// ── Gain/Pan ──────────────────────────────────────────────────────────────
function applyGainPan(inL, inR, len, gain, pan, isDouble) {
  const outL=new Float32Array(len), outR=new Float32Array(len);
  if (isDouble) {
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

// ── Main v9 — Layering Pro ───────────────────────────────────────────────
// Profils par trackIndex — chaque harmonie a sa personnalité unique
const LAYER_PROFILES = {
  2: { pitchVar:3,  timingMs:15, timbreHz:2800, timbreDb:+1.5, panDrift:0.05 }, // Tierce +3
  3: { pitchVar:5,  timingMs:28, timbreHz:3500, timbreDb:-1.0, panDrift:0.08 }, // Quinte +7
  4: { pitchVar:2,  timingMs:8,  timbreHz:200,  timbreDb:+2.0, panDrift:0.03 }, // Octave -12
  5: { pitchVar:4,  timingMs:22, timbreHz:1800, timbreDb:+0.5, panDrift:0.06 }, // Quarte +5
};

// Variation de pitch par phrase (±pitchVar cents aléatoires par phrase)
function applyPhraseVariation(signal, sr, pitchVarCents, seed) {
  const rand=()=>{ seed=(seed*1664525+1013904223)|0; return (seed>>>0)/0xFFFFFFFF; };
  const minPhraseSamp=Math.floor(sr*0.3);
  const result=new Float32Array(signal.length);
  let pos=0;
  while (pos<signal.length) {
    const phraseLen=Math.floor(minPhraseSamp+rand()*sr*0.9);
    const varCents=(rand()*2-1)*pitchVarCents;
    const ratio=Math.pow(2,varCents/1200);
    const end=Math.min(pos+phraseLen,signal.length);
    const fadeLen=Math.min(Math.floor(sr*0.020),phraseLen>>1);
    for (let i=pos;i<end;i++) {
      const srcPos=pos+(i-pos)*ratio;
      const s0=Math.min(Math.floor(srcPos),signal.length-2);
      const frac=srcPos-Math.floor(srcPos);
      let val=(signal[s0]||0)*(1-frac)+(signal[Math.min(s0+1,signal.length-1)]||0)*frac;
      const fromStart=i-pos, toEnd=end-i;
      if (fromStart<fadeLen) val*=fromStart/fadeLen;
      if (toEnd<fadeLen) val*=toEnd/fadeLen;
      result[i]+=val;
    }
    pos=end;
  }
  return result;
}

// Timing offset — les attaques arrivent à des moments légèrement différents
function applyTimingOffset(signal, offsetMs, sr) {
  if (offsetMs<=0) return signal;
  const offsetSamp=Math.floor(offsetMs*sr/1000);
  const result=new Float32Array(signal.length+offsetSamp);
  for (let i=0;i<signal.length;i++) result[i+offsetSamp]=signal[i];
  return result.slice(0,signal.length);
}

// Coloration timbrale — chaque voix a son espace frequentiel propre
function applyTimbreColor(signal, fcHz, gainDB, Q, sr) {
  if (Math.abs(gainDB)<0.3) return signal;
  const A=Math.pow(10,gainDB/40), w0=2*Math.PI*fcHz/sr;
  const cosW=Math.cos(w0), sinW=Math.sin(w0), alpha=sinW/(2*Q);
  const b0=1+alpha*A, b1=-2*cosW, b2=1-alpha*A;
  const a0=1+alpha/A, a1=-2*cosW, a2=1-alpha/A;
  const out=new Float32Array(signal.length);
  let x1=0,x2=0,y1=0,y2=0;
  for (let i=0;i<signal.length;i++) {
    const x0=signal[i], y0=(b0*x0+b1*x1+b2*x2-a1*y1-a2*y2)/a0;
    out[i]=y0; x2=x1; x1=x0; y2=y1; y1=y0;
  }
  return out;
}

// Pan automation — leger mouvement dans l espace stereo (LFO 0.03Hz)
function applyPanAutomation(outL, outR, len, basePan, driftAmt, sr) {
  const lfoInc=2*Math.PI*0.03/sr;
  let lfoPhase=0;
  for (let i=0;i<len;i++) {
    const pan=Math.max(-1,Math.min(1,basePan+Math.sin(lfoPhase)*driftAmt));
    const pr=(pan+1)*Math.PI/4;
    const mid=(outL[i]+outR[i])*0.5;
    outL[i]=mid*Math.cos(pr); outR[i]=mid*Math.sin(pr);
    lfoPhase+=lfoInc;
  }
}

// Wrapper chunked — traite les longs signaux par blocs de 45s
// Évite le crash mémoire iOS (~128MB Web Worker limit)
function processChunked(mono, semitones, sampleRate, trackIndex, onProgress) {
  const chunkSec = 45; // blocs 45s — ~60MB par bloc, sûr sur iOS
  const chunkSamples = Math.floor(sampleRate * chunkSec);
  if (mono.length <= chunkSamples) {
    return processSingle(mono, semitones, sampleRate, trackIndex, onProgress);
  }
  // Découper en blocs avec overlap de 0.5s pour éviter les artefacts aux jointures
  const overlapSamples = Math.floor(sampleRate * 0.5);
  const results = [];
  let pos = 0;
  while (pos < mono.length) {
    const end = Math.min(pos + chunkSamples, mono.length);
    const chunk = mono.slice(pos, end + (end < mono.length ? overlapSamples : 0));
    const processed = processSingle(chunk, semitones, sampleRate, trackIndex, null);
    // Garder seulement la partie sans overlap (sauf dernier bloc)
    const keepLen = end < mono.length ? Math.floor(processed.length * (chunkSamples / chunk.length)) : processed.length;
    results.push(processed.slice(0, keepLen));
    pos = end;
  }
  // Concaténer tous les blocs
  const totalLen = results.reduce((sum, r) => sum + r.length, 0);
  const final = new Float32Array(totalLen);
  let offset = 0;
  for (const r of results) { final.set(r, offset); offset += r.length; }
  return final;
}

function processSingle(mono, semitones, sampleRate, trackIndex, onProgress) {
  const profile = LAYER_PROFILES[trackIndex] || LAYER_PROFILES[2];
  let seed = (trackIndex||2)*7919;
  for (let i=0;i<Math.min(64,mono.length);i++) seed=(seed*31+Math.round(mono[i]*10000))|0;

  let shifted = phaseVocoderShift(mono, semitones, sampleRate);
  if (Math.abs(semitones)>=3) shifted = applyFormantShift(shifted, semitones, sampleRate);
  if (semitones>=5) { const drive=0.04+(semitones-5)/7*0.03; shifted=applySoftSaturation(shifted,drive); }
  shifted = applyPhraseVariation(shifted, sampleRate, profile.pitchVar, seed);
  shifted = applyOrganicJitter(shifted, sampleRate);
  shifted = applyTimbreColor(shifted, profile.timbreHz, profile.timbreDb, 1.2, sampleRate);
  shifted = applyTimingOffset(shifted, profile.timingMs, sampleRate);
  shifted = applyRoomReverb(shifted, sampleRate, 0.18);
  return shifted;
}

self.onmessage = function(e) {
  const { id, op, channelL, channelR, semitones, gain, pan, sampleRate, trackIndex } = e.data;
  try {
    const len=channelL.length;
    const mono=new Float32Array(len);
    for (let i=0;i<len;i++) mono[i]=((channelL[i]||0)+(channelR[i]||0))*0.5;

    let seed=(trackIndex||2)*7919;
    for (let i=0;i<Math.min(64,len);i++) seed=(seed*31+Math.round(mono[i]*10000))|0;

    let outL, outR, outLen;

    if (op==='double') {
      self.postMessage({id,type:'progress',label:'Double tracking...'});
      const res=doubleTrack(mono,sampleRate);
      outL=res.outL; outR=res.outR; outLen=res.outLen;

    } else {
      self.postMessage({id,type:'progress',label:`Génération harmonie ${semitones>0?'+':''}${semitones} ST...`});
      // Traitement par blocs de 45s — évite crash mémoire iOS (limite ~128MB)
      const shifted = processChunked(mono, semitones, sampleRate, trackIndex, null);
      outLen=shifted.length; outL=shifted; outR=shifted;
    }

    const gp=applyGainPan(outL,outR,outLen,gain,pan,op==='double');

    if (op!=='double') {
      const profile=LAYER_PROFILES[trackIndex]||LAYER_PROFILES[2];
      applyPanAutomation(gp.outL,gp.outR,outLen,pan,profile.panDrift,sampleRate);
    }

    self.postMessage({id,type:'progress',label:'Encodage WAV...'});
    const wavBuf=audioToWav(gp.outL,gp.outR,sampleRate);
    self.postMessage({id,type:'done',wavBuf},[wavBuf]);

  } catch(err) {
    self.postMessage({id,type:'error',message:err.message||String(err)});
  }
};
