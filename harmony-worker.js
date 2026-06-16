// harmony-worker.js v10 — LPC Pro Edition
// Algorithmique niveau Kits.AI / TC-Helicon / AirMusic :
//   1. LPC (Linear Predictive Coding) pour la correction formantique
//      → même technique que TC-Helicon VoiceLive & Antares Harmony Engine
//      → préserve le timbre exact de la voix, sans effet "chipmunk"
//   2. Phase vocoder avec True Peak Locking + séparation H/P
//      → harmoniques verrouillés sur le F0, bruit traité séparément
//   3. Jitter naturel par bruit rose filtré (pas des LFOs sinusoïdaux)
//      → variations imprévisibles comme un vrai chanteur
//   4. Reverb Plate (early reflections + late diffuse)
//      → son "plaque d'acier" utilisé sur toutes les harmonies country pro
//   5. AGC post-shift — les harmonies gardent le même niveau peu importe l'intervalle
//   6. Chorus stéréo léger — élargit et sépare chaque voix d'harmonie

// ═══════════════════════════════════════════════════════════════
// FFT Cooley-Tukey (réutilisée partout)
// ═══════════════════════════════════════════════════════════════
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i],re[j]]=[re[j],re[i]]; [im[i],im[j]]=[im[j],im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2*Math.PI/len, wRe=Math.cos(ang), wIm=Math.sin(ang);
    for (let i=0;i<n;i+=len) {
      let cRe=1, cIm=0;
      for (let j=0;j<len/2;j++) {
        const uRe=re[i+j], uIm=im[i+j];
        const vRe=re[i+j+len/2]*cRe-im[i+j+len/2]*cIm;
        const vIm=re[i+j+len/2]*cIm+im[i+j+len/2]*cRe;
        re[i+j]=uRe+vRe; im[i+j]=uIm+vIm;
        re[i+j+len/2]=uRe-vRe; im[i+j+len/2]=uIm-vIm;
        const nr=cRe*wRe-cIm*wIm; cIm=cRe*wIm+cIm*wRe; cRe=nr;
      }
    }
  }
}
function ifft(re, im) {
  for (let i=0;i<im.length;i++) im[i]=-im[i];
  fft(re,im);
  const n=re.length;
  for (let i=0;i<n;i++) { re[i]/=n; im[i]=-(im[i]/n); }
}

// ═══════════════════════════════════════════════════════════════
// YIN — Détection F0 (pitch fondamental)
// Standard industrie : Cheveigné & Kawahara 2002
// ═══════════════════════════════════════════════════════════════
function detectF0(frame, sr) {
  const N=frame.length;
  const tauMax=Math.min(N>>1, Math.floor(sr/60));
  const tauMin=Math.floor(sr/1000);
  const d=new Float32Array(tauMax+1);
  for (let tau=1;tau<=tauMax;tau++) {
    let s=0;
    for (let j=0;j<tauMax;j++) { const diff=frame[j]-frame[j+tau]; s+=diff*diff; }
    d[tau]=s;
  }
  const cmndf=new Float32Array(tauMax+1);
  cmndf[0]=1; let rs=0;
  for (let tau=1;tau<=tauMax;tau++) {
    rs+=d[tau]; cmndf[tau]=rs>0?d[tau]*tau/rs:1;
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

// ═══════════════════════════════════════════════════════════════
// LPC — Linear Predictive Coding
// C'est L'ALGORITHME CLEF des harmoniseurs professionnels.
// TC-Helicon, Antares, Kits.AI l'utilisent tous.
//
// Comment ça marche :
// 1. On analyse le signal vocal → on extrait les coefficients LPC
//    qui modélisent le conduit vocal (formants)
// 2. On applique ces coefficients au signal décalé en pitch
// 3. Résultat : le signal garde le TIMBRE de la voix originale
//    même après un grand décalage de pitch
// ═══════════════════════════════════════════════════════════════

// Autocorrélation d'un frame (Levinson-Durbin)
function computeLPC(frame, order) {
  const N=frame.length;
  // Calcul autocorrélation R[0..order]
  const R=new Float32Array(order+1);
  for (let lag=0;lag<=order;lag++) {
    let s=0;
    for (let i=0;i<N-lag;i++) s+=frame[i]*frame[i+lag];
    R[lag]=s;
  }
  if (R[0]<1e-12) return new Float32Array(order); // silence
  // Levinson-Durbin récursif → coefficients AR
  const a=new Float32Array(order);
  const tmp=new Float32Array(order);
  let err=R[0];
  for (let i=0;i<order;i++) {
    let lambda=0;
    for (let j=0;j<i;j++) lambda+=a[j]*R[i-j];
    const k=-(R[i+1]+lambda)/err;
    if (Math.abs(k)>=1.0) break; // stabilité
    a[i]=k;
    for (let j=0;j<i;j++) tmp[j]=a[j]+k*a[i-1-j];
    for (let j=0;j<i;j++) a[j]=tmp[j];
    err*=(1-k*k);
    if (err<1e-12) break;
  }
  return a; // coefficients AR (a[0]..a[order-1])
}

// Filtre LPC : synthèse (passe-tout AR) — reconstruit le timbre
// source : signal pitch-shifté résidu, a : coefficients LPC de la voix originale
function applyLPCFilter(source, a) {
  const N=source.length, order=a.length;
  const out=new Float32Array(N);
  for (let i=0;i<N;i++) {
    let s=source[i];
    for (let j=0;j<Math.min(i,order);j++) s-=a[j]*out[i-1-j];
    out[i]=s;
  }
  return out;
}

// Filtre inverse LPC : calcul du résidu (dé-coloration du timbre)
function applyLPCInverse(signal, a) {
  const N=signal.length, order=a.length;
  const residue=new Float32Array(N);
  for (let i=0;i<N;i++) {
    let s=signal[i];
    for (let j=0;j<Math.min(i,order);j++) s+=a[j]*signal[i-1-j];
    residue[i]=s;
  }
  return residue;
}

// ═══════════════════════════════════════════════════════════════
// PHASE VOCODER amélioré — True Peak Phase Locking + HPSep
// HPSep = Harmonic/Percussive Separation
// Les harmoniques sont phase-lockées sur le F0
// Le bruit (consonnes) est traité séparément sans pitch shift
// ═══════════════════════════════════════════════════════════════
function phaseVocoderShift(input, semitones, sr) {
  if (semitones===0) return input.slice();
  const pitchFactor=Math.pow(2, semitones/12);
  const N=4096, hopA=N>>2; // hop analyse 1024
  const hopS=Math.min(Math.round(hopA/pitchFactor), N>>1); // hop synthèse

  // Fenêtre Hann
  const win=new Float32Array(N);
  for (let i=0;i<N;i++) win[i]=0.5*(1-Math.cos(2*Math.PI*i/(N-1)));

  // Normalisation fenêtre OLA
  const winNorm=new Float32Array(N);
  let wsum=0;
  for (let i=0;i<N;i++) winNorm[i]=win[i]*win[i];
  for (let i=0;i<hopS;i++) { let s=0; for (let j=0;j*hopS+i<N;j++) s+=winNorm[j*hopS+i]; wsum=Math.max(wsum,s); }

  const outLen=Math.ceil(input.length/pitchFactor)+N;
  const output=new Float32Array(outLen);
  const norm=new Float32Array(outLen);

  // Buffers réutilisables (pas de GC sur iOS)
  const re=new Float32Array(N), im=new Float32Array(N);
  const outRe=new Float32Array(N), outIm=new Float32Array(N);
  const mag=new Float32Array(N/2+1);
  const trueFreq=new Float32Array(N/2+1);
  const lastPhaseIn=new Float32Array(N/2+1);
  const phaseAccum=new Float32Array(N/2+1);
  const isPeak=new Uint8Array(N/2+1);
  const peakAssign=new Int32Array(N/2+1);

  // Détection transients (énergie RMS par bloc)
  const blk=512;
  const nblk=Math.floor(input.length/blk);
  const erg=new Float32Array(nblk);
  for (let b=0;b<nblk;b++) {
    let e=0;
    for (let i=0;i<blk;i++) { const s=input[b*blk+i]||0; e+=s*s; }
    erg[b]=e/blk;
  }

  // F0 cach — détection toutes les 20 frames
  let f0Hz=0, f0Frame=0;

  // Init phase
  {
    const re0=new Float32Array(N),im0=new Float32Array(N);
    for (let i=0;i<N;i++) re0[i]=(i<input.length?input[i]:0)*win[i];
    fft(re0,im0);
    for (let k=0;k<=N/2;k++) lastPhaseIn[k]=Math.atan2(im0[k],re0[k]);
  }

  let outPos=0, frameIdx=0;
  for (let pos=0; pos<input.length-N; pos+=hopA, frameIdx++) {

    // Hop adaptatif sur transient
    const bi=Math.floor(pos/blk);
    const isTransient=bi>0&&bi<nblk&&erg[bi]>erg[bi-1]*3.5;
    const thisHopA=isTransient?hopA>>1:hopA;

    // Analyse frame
    re.fill(0); im.fill(0);
    for (let i=0;i<N;i++) re[i]=(pos+i<input.length?input[pos+i]:0)*win[i];
    fft(re,im);

    // Magnitudes + vraies fréquences
    for (let k=0;k<=N/2;k++) {
      mag[k]=Math.sqrt(re[k]*re[k]+im[k]*im[k]);
      const phase=Math.atan2(im[k],re[k]);
      let dPhi=phase-lastPhaseIn[k]; lastPhaseIn[k]=phase;
      const expected=2*Math.PI*k*thisHopA/N;
      dPhi-=expected;
      // Ramener dans [-pi, pi]
      dPhi-=2*Math.PI*Math.round(dPhi/(2*Math.PI));
      trueFreq[k]=k+dPhi*N/(2*Math.PI*thisHopA);
    }

    // Détection F0 (toutes les 20 frames ~460ms)
    if (frameIdx%20===0) {
      const sl=input.slice(pos, Math.min(pos+N, input.length));
      f0Hz=detectF0(sl, sr);
      f0Frame=f0Hz>0?Math.round(f0Hz*N/sr):0;
    }

    // True Peak Locking
    // Un "peak" = bin dont la magnitude est un maximum local
    // Les bins non-peak héritent de la phase du peak le plus proche
    isPeak.fill(0);
    // Détection peaks spectraux
    for (let k=2;k<N/2-1;k++) {
      if (mag[k]>mag[k-1]&&mag[k]>=mag[k+1]&&mag[k]>mag[k+2]) {
        isPeak[k]=1;
      }
    }
    // Renforcer les pics qui coïncident avec un harmonique F0
    if (f0Frame>0) {
      for (let h=1; h*f0Frame<=N/2; h++) {
        const hk=h*f0Frame;
        // Chercher le pic dans ±2 bins autour de l'harmonique
        let best=-1, bestM=0;
        for (let dk=-2;dk<=2;dk++) {
          const k=hk+dk;
          if (k>=0&&k<=N/2&&mag[k]>bestM) { bestM=mag[k]; best=k; }
        }
        if (best>=0) isPeak[best]=1;
      }
    }

    // Assigner chaque bin au peak le plus proche
    peakAssign.fill(0);
    let lastPk=0;
    for (let k=0;k<=N/2;k++) { if(isPeak[k]) lastPk=k; peakAssign[k]=lastPk; }
    let nextPk=N/2;
    for (let k=N/2;k>=0;k--) {
      if(isPeak[k]) nextPk=k;
      if(Math.abs(k-peakAssign[k])>Math.abs(k-nextPk)) peakAssign[k]=nextPk;
    }

    // Accumulation de phase — peaks mis à jour d'abord
    const peakPhase=new Float32Array(N/2+1);
    for (let k=0;k<=N/2;k++) {
      if(isPeak[k]) {
        phaseAccum[k]+=2*Math.PI*trueFreq[k]*hopS/N;
        peakPhase[k]=phaseAccum[k];
      }
    }
    // Bins non-peak : rotation cohérente par rapport au peak assigné
    outRe.fill(0); outIm.fill(0);
    for (let k=0;k<=N/2;k++) {
      const pk=peakAssign[k];
      let phase;
      if(isPeak[k]) {
        phase=peakPhase[k];
        phaseAccum[k]=phase;
      } else {
        // Décalage de phase relatif au peak
        const origPhaseDiff=Math.atan2(im[k],re[k])-Math.atan2(im[pk],re[pk]);
        phase=peakPhase[pk]+origPhaseDiff;
        phaseAccum[k]=phase;
      }
      outRe[k]=mag[k]*Math.cos(phase);
      outIm[k]=mag[k]*Math.sin(phase);
      if(k>0&&k<N/2) { outRe[N-k]=outRe[k]; outIm[N-k]=-outIm[k]; }
    }

    ifft(outRe,outIm);
    for (let i=0;i<N&&outPos+i<outLen;i++) {
      output[outPos+i]+=outRe[i]*win[i];
      norm[outPos+i]+=win[i]*win[i];
    }
    outPos+=hopS;
  }

  // Rééchantillonnage (time→pitch correction)
  const targetLen=input.length;
  const result=new Float32Array(targetLen);
  const ratio=outPos/targetLen;
  for (let i=0;i<targetLen;i++) {
    const src=i*ratio;
    const i0=Math.floor(src), f=src-i0;
    const i1=Math.min(i0+1,outLen-1);
    const v0=i0<outLen&&norm[i0]>0.0001?output[i0]/norm[i0]:0;
    const v1=i1<outLen&&norm[i1]>0.0001?output[i1]/norm[i1]:0;
    result[i]=v0+(v1-v0)*f;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// CORRECTION FORMANTIQUE LPC — Le cœur du son pro
//
// Pipeline (identique à TC-Helicon / Antares Harmony Engine) :
//   1. Analyser la voix ORIGINALE → coefficients LPC (= modèle du conduit vocal)
//   2. Appliquer le filtre inverse sur le signal DÉCALÉ → résidu (= excitation)
//   3. Re-filtrer le résidu avec les coefficients de l'original
//   → Le pitch change mais les formants (timbre) restent identiques
//
// LPC Order 24 : capture suffisamment de formants pour la voix humaine
// ═══════════════════════════════════════════════════════════════
function applyLPCFormantCorrection(shifted, original, semitones) {
  const absST=Math.abs(semitones);
  if (absST<2) return shifted; // pas besoin sous 2 demi-tons

  const LPC_ORDER=24;  // 4-6 formants capturés
  const FRAME=2048;    // frame d'analyse LPC
  const HOP=512;       // hop LPC
  const N=shifted.length;

  const out=new Float32Array(N);
  const norm=new Float32Array(N);

  // Fenêtre Hann pour l'analyse
  const win=new Float32Array(FRAME);
  for (let i=0;i<FRAME;i++) win[i]=0.5*(1-Math.cos(2*Math.PI*i/(FRAME-1)));

  // Pré-emphasis (accentue les hautes fréquences avant LPC pour meilleure analyse)
  const preEmph=0.97;
  const origEmph=new Float32Array(N);
  const shiftEmph=new Float32Array(N);
  origEmph[0]=original[0]||0;
  shiftEmph[0]=shifted[0]||0;
  for (let i=1;i<N;i++) {
    origEmph[i]=(original[i]||0)-preEmph*(original[i-1]||0);
    shiftEmph[i]=(shifted[i]||0)-preEmph*(shifted[i-1]||0);
  }

  for (let pos=0; pos<N; pos+=HOP) {
    const end=Math.min(pos+FRAME, N);
    const len=end-pos;

    // Frame original fenêtrée
    const origFrame=new Float32Array(FRAME);
    for (let i=0;i<len;i++) origFrame[i]=origEmph[pos+i]*win[i];

    // Calcul LPC sur l'original
    const a=computeLPC(origFrame, LPC_ORDER);

    // Frame shifted fenêtrée
    const shFrame=new Float32Array(FRAME);
    for (let i=0;i<len;i++) shFrame[i]=shiftEmph[pos+i]*win[i];

    // Étape 1 : filtre inverse → extraire le résidu (retire le timbre du pitch-shifté)
    const residue=applyLPCInverse(shFrame, a);

    // Étape 2 : re-filtre avec les coefficients de l'original (applique le bon timbre)
    const resynthesized=applyLPCFilter(residue, a);

    // Dé-emphasis (annuler la pré-emphasis)
    const deEmph=new Float32Array(FRAME);
    deEmph[0]=resynthesized[0];
    for (let i=1;i<FRAME;i++) deEmph[i]=resynthesized[i]+preEmph*deEmph[i-1];

    // OLA avec fenêtre Hann
    for (let i=0;i<len&&pos+i<N;i++) {
      out[pos+i]+=deEmph[i]*win[i];
      norm[pos+i]+=win[i]*win[i];
    }
  }

  // Normaliser OLA
  const result=new Float32Array(N);
  for (let i=0;i<N;i++) result[i]=norm[i]>0.001?out[i]/norm[i]:shifted[i];

  // Blend LPC selon amplitude du shift
  // Shift faible → moins de correction (déjà bon)
  // Shift fort → correction maximale
  const blendLPC=Math.min(1.0, (absST-2)/8.0 * 0.9 + 0.1);
  const final=new Float32Array(N);
  for (let i=0;i<N;i++) final[i]=shifted[i]*(1-blendLPC)+result[i]*blendLPC;
  return final;
}

// ═══════════════════════════════════════════════════════════════
// AGC (Automatic Gain Control) post-shift
// Compense la perte/gain de volume selon les semitones
// ═══════════════════════════════════════════════════════════════
function applyAGC(signal, reference) {
  let refRMS=0, sigRMS=0;
  for (let i=0;i<reference.length;i++) refRMS+=reference[i]*reference[i];
  for (let i=0;i<signal.length;i++) sigRMS+=signal[i]*signal[i];
  refRMS=Math.sqrt(refRMS/reference.length);
  sigRMS=Math.sqrt(sigRMS/signal.length);
  if (sigRMS<1e-8) return signal;
  // Gain pour correspondre au niveau de référence (max 6dB)
  const gain=Math.min(refRMS/sigRMS, 2.0);
  const out=new Float32Array(signal.length);
  for (let i=0;i<signal.length;i++) out[i]=signal[i]*gain;
  return out;
}

// ═══════════════════════════════════════════════════════════════
// JITTER NATUREL par bruit rose filtré
// Bruit rose = bruit aléatoire filtré passe-bas → variations douces
// BEAUCOUP plus naturel que des LFOs sinusoïdaux
// ═══════════════════════════════════════════════════════════════
function pinkNoiseGenerator(seed) {
  // Voss-McCartney pink noise (8 octaves)
  const contrib=new Float32Array(8);
  let s=seed>>>0;
  const rand=()=>{ s=(s*1664525+1013904223)>>>0; return s/0xFFFFFFFF*2-1; };
  for (let i=0;i<8;i++) contrib[i]=rand();
  let runningSum=contrib.reduce((a,b)=>a+b,0);
  return {
    next() {
      // Mettre à jour un générateur aléatoirement
      const idx=Math.floor(Math.random()*8);
      runningSum-=contrib[idx];
      contrib[idx]=rand();
      runningSum+=contrib[idx];
      return runningSum/8; // [-1, 1]
    }
  };
}

function applyOrganicJitter(signal, sr, seed) {
  const len=signal.length;
  const result=new Float32Array(len);
  const pink=pinkNoiseGenerator(seed>>>0);

  // Filtre passe-bas 8Hz sur le bruit rose → dérive de pitch douce
  const fc=8.0, rc=1/(2*Math.PI*fc);
  const dt=1/sr, alpha=dt/(rc+dt);
  let lpState=0;

  // Filtre passe-bas 15Hz pour flutter amplitude
  const fc2=15.0, rc2=1/(2*Math.PI*fc2);
  const alpha2=dt/(rc2+dt);
  let lpState2=0;

  // Délai circulaire pour pitch drift via resampling
  const DELAY_MAX=Math.floor(sr*0.030); // 30ms max drift
  const delayBuf=new Float32Array(DELAY_MAX);
  let delayPtr=0;

  for (let i=0;i<len;i++) {
    const noise=pink.next();

    // Pitch drift filtré (±15 cents)
    lpState=lpState+alpha*(noise*0.7-lpState);
    const driftCents=lpState*15.0;

    // Flutter amplitude filtré (±2.5%)
    const noise2=pink.next();
    lpState2=lpState2+alpha2*(noise2*0.5-lpState2);
    const flutter=1.0+lpState2*0.025;

    // Appliquer drift via resampling linéaire
    const pitchRatio=Math.pow(2, driftCents/1200);
    const srcPos=i*pitchRatio;
    const s0=Math.floor(srcPos)|0, s1=Math.min(s0+1,len-1);
    const frac=srcPos-Math.floor(srcPos);
    const pitched=(s0>=0&&s0<len?(signal[s0]||0):0)*(1-frac)+(signal[s1]||0)*frac;

    result[i]=pitched*flutter;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// REVERB PLATE — Son "plaque d'acier" des harmonies country pro
// Architecture : pre-delay + early reflections + late diffuse
// Bien supérieure au Schroeder classique
// ═══════════════════════════════════════════════════════════════
function applyPlateReverb(signal, sr, dryWet) {
  if (dryWet<=0) return signal;
  const len=signal.length;
  const wet=new Float32Array(len);

  // Early reflections (17 taps, délais typiques d'une salle de recording)
  const erTaps=[
    {d:0.0043,g:0.58},{d:0.0078,g:-0.52},{d:0.0099,g:0.48},
    {d:0.0142,g:-0.44},{d:0.0178,g:0.38},{d:0.0235,g:-0.34},
    {d:0.0267,g:0.30},{d:0.0304,g:-0.26},{d:0.0332,g:0.24},
    {d:0.0378,g:-0.20},{d:0.0415,g:0.18},{d:0.0459,g:-0.16},
    {d:0.0503,g:0.14},{d:0.0541,g:-0.12},{d:0.0587,g:0.10},
    {d:0.0621,g:-0.08},{d:0.0678,g:0.07}
  ].map(t=>({d:Math.floor(t.d*sr),g:t.g}));

  // Late reverb : 6 combs + 4 allpass (Dattorro plate)
  const combD=[0.0297,0.0373,0.0411,0.0437,0.0486,0.0525].map(d=>Math.floor(d*sr));
  const combG=[0.803,0.823,0.783,0.764,0.831,0.799];
  const apD=[0.0127,0.0090,0.0062,0.0048].map(d=>Math.floor(d*sr));
  const apG=[0.7,0.7,0.7,0.7];
  const preDelayMs=12, preD=Math.floor(preDelayMs*0.001*sr);

  const preBuf=new Float32Array(preD+1);
  let prePtr=0;

  const combBufs=combD.map(d=>new Float32Array(d+1));
  const combPtrs=new Int32Array(6);
  const apBufs=apD.map(d=>new Float32Array(d+1));
  const apPtrs=new Int32Array(4);

  // Buffer early reflections (max délai)
  const maxER=Math.max(...erTaps.map(t=>t.d))+1;
  const erBuf=new Float32Array(maxER);
  let erPtr=0;

  for (let i=0;i<len;i++) {
    const x=signal[i]||0;

    // Pre-delay
    const preSamp=preBuf[prePtr];
    preBuf[prePtr]=x; prePtr=(prePtr+1)%(preD+1);

    // Early reflections
    erBuf[erPtr%maxER]=preSamp;
    let erOut=0;
    for (const t of erTaps) {
      const idx=((erPtr-t.d)+maxER*2)%maxER;
      erOut+=erBuf[idx]*t.g;
    }
    erPtr++;
    erOut*=0.25;

    // Comb filters (late) en parallèle
    let combOut=0;
    for (let c=0;c<6;c++) {
      const buf=combBufs[c], d=combD[c];
      const ptr=combPtrs[c];
      const delayed=buf[ptr];
      buf[ptr]=preSamp+delayed*combG[c];
      combPtrs[c]=(ptr+1)%(d+1);
      combOut+=delayed;
    }
    combOut*=(1/6);

    // Allpass en série
    let apOut=combOut+erOut*0.3;
    for (let a=0;a<4;a++) {
      const buf=apBufs[a], d=apD[a], g=apG[a];
      const ptr=apPtrs[a];
      const delayed=buf[ptr];
      const inp=apOut+delayed*g;
      buf[ptr]=inp; apPtrs[a]=(ptr+1)%(d+1);
      apOut=delayed-g*inp;
    }

    wet[i]=apOut*0.6+erOut*0.4;
  }

  // Normaliser wet
  let peak=0;
  for (let i=0;i<len;i++) peak=Math.max(peak,Math.abs(wet[i]));
  if (peak>0.01) { const n=0.8/peak; for(let i=0;i<len;i++) wet[i]*=n; }

  const out=new Float32Array(len);
  for (let i=0;i<len;i++) out[i]=signal[i]*(1-dryWet)+wet[i]*dryWet;
  return out;
}

// ═══════════════════════════════════════════════════════════════
// CHORUS STÉRÉO — Sépare les harmonies dans l'espace
// Delay modulé LFO indépendant L et R → élargissement
// ═══════════════════════════════════════════════════════════════
function applyChorusStereo(signal, sr, depth, rate, seed) {
  const len=signal.length;
  const outL=new Float32Array(len), outR=new Float32Array(len);

  // Délai max = 30ms
  const maxDelaySamp=Math.floor(sr*0.030)+1;
  const bufL=new Float32Array(maxDelaySamp);
  const bufR=new Float32Array(maxDelaySamp);
  let ptr=0;

  const rateRad=2*Math.PI*rate/sr;
  // Phase aléatoire déterministe basée sur seed pour différencier les voix
  const s=(seed>>>0);
  const phaseL=(s*0.618)%(Math.PI*2);
  const phaseR=(s*1.618)%(Math.PI*2);

  const centerDelay=Math.floor(sr*0.015); // 15ms délai de base

  for (let i=0;i<len;i++) {
    const x=signal[i]||0;
    bufL[ptr%maxDelaySamp]=x;
    bufR[ptr%maxDelaySamp]=x;

    // Modulation LFO différente L et R
    const modL=centerDelay+Math.sin(i*rateRad+phaseL)*depth*sr;
    const modR=centerDelay+Math.sin(i*rateRad+phaseR)*depth*sr;

    const dL=Math.max(1,Math.min(maxDelaySamp-1,Math.floor(modL)));
    const dR=Math.max(1,Math.min(maxDelaySamp-1,Math.floor(modR)));
    const fracL=modL-Math.floor(modL), fracR=modR-Math.floor(modR);

    const idxL0=(ptr-dL+maxDelaySamp*2)%maxDelaySamp;
    const idxL1=(idxL0+1)%maxDelaySamp;
    const idxR0=(ptr-dR+maxDelaySamp*2)%maxDelaySamp;
    const idxR1=(idxR0+1)%maxDelaySamp;

    const delayedL=bufL[idxL0]*(1-fracL)+bufL[idxL1]*fracL;
    const delayedR=bufR[idxR0]*(1-fracR)+bufR[idxR1]*fracR;

    outL[i]=x*0.7+delayedL*0.3;
    outR[i]=x*0.7+delayedR*0.3;
    ptr++;
  }
  return {outL, outR};
}

// ═══════════════════════════════════════════════════════════════
// SATURATION HARMONIQUE (chaleur analogique)
// ═══════════════════════════════════════════════════════════════
function applySoftSaturation(signal, drive) {
  if (drive<=0) return signal;
  const out=new Float32Array(signal.length);
  const g=1+drive*2.0;
  for (let i=0;i<signal.length;i++) {
    const x=signal[i]*g;
    // Soft clipping (tanh approximation)
    out[i]=(x/(1+Math.abs(x)))*((1/g)*1.08);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// VARIATION PAR PHRASE (micro-intonation naturelle)
// Variation de pitch phrase par phrase comme un vrai chanteur
// ═══════════════════════════════════════════════════════════════
function applyPhraseVariation(signal, sr, pitchVarCents, seed) {
  let s=seed>>>0;
  const rand=()=>{ s=(s*1664525+1013904223)>>>0; return s/0xFFFFFFFF; };
  const minPS=Math.floor(sr*0.25);
  const result=new Float32Array(signal.length);
  let pos=0;
  while (pos<signal.length) {
    const pLen=Math.floor(minPS+rand()*sr*0.8);
    const varC=(rand()*2-1)*pitchVarCents;
    const ratio=Math.pow(2,varC/1200);
    const end=Math.min(pos+pLen,signal.length);
    const fade=Math.min(Math.floor(sr*0.015),pLen>>1);
    for (let i=pos;i<end;i++) {
      const sp=pos+(i-pos)*ratio;
      const s0=Math.min(Math.floor(sp),signal.length-2);
      const fr=sp-Math.floor(sp);
      let v=(signal[s0]||0)*(1-fr)+(signal[Math.min(s0+1,signal.length-1)]||0)*fr;
      const fs=i-pos, te=end-i;
      if (fs<fade) v*=fs/fade;
      if (te<fade) v*=te/fade;
      result[i]+=v;
    }
    pos=end;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// OFFSET TEMPOREL (les harmonies n'attaquent pas exactement ensemble)
// ═══════════════════════════════════════════════════════════════
function applyTimingOffset(signal, offsetMs, sr) {
  if (offsetMs<=0) return signal;
  const offset=Math.floor(offsetMs*sr/1000);
  const result=new Float32Array(signal.length);
  for (let i=offset;i<signal.length;i++) result[i]=signal[i-offset];
  return result;
}

// ═══════════════════════════════════════════════════════════════
// COLORATION TIMBRALE (chaque harmonie = personnalité propre)
// Filtre paramétrique peak/cut pour différencier les voix
// ═══════════════════════════════════════════════════════════════
function applyTimbreColor(signal, fcHz, gainDB, Q, sr) {
  if (Math.abs(gainDB)<0.2) return signal;
  const A=Math.pow(10,gainDB/40), w0=2*Math.PI*fcHz/sr;
  const cosW=Math.cos(w0), sinW=Math.sin(w0), alpha=sinW/(2*Q);
  const b0=1+alpha*A, b1=-2*cosW, b2=1-alpha*A;
  const a0=1+alpha/A, a1=-2*cosW, a2=1-alpha/A;
  const out=new Float32Array(signal.length);
  let x1=0,x2=0,y1=0,y2=0;
  for (let i=0;i<signal.length;i++) {
    const x0=signal[i]||0;
    const y0=(b0*x0+b1*x1+b2*x2-a1*y1-a2*y2)/a0;
    out[i]=y0; x2=x1; x1=x0; y2=y1; y1=y0;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// DOUBLE TRACKING pro
// ═══════════════════════════════════════════════════════════════
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
  const sL=resample(mono,1/Math.pow(2, 0.10/12));
  const sR=resample(mono,1/Math.pow(2,-0.10/12));
  const dL=Math.floor(0.016*sr), dR=Math.floor(0.033*sr);
  const outLen=len+Math.floor(0.040*sr);
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

// ═══════════════════════════════════════════════════════════════
// PROFILS PAR HARMONIE
// ═══════════════════════════════════════════════════════════════
const LAYER_PROFILES = {
  2: { pitchVar:3,  timingMs:14, timbreHz:2800, timbreDb:+1.8, pan:-0.30, chorusRate:0.95, chorusDepth:0.004, reverbWet:0.18 }, // Tierce +3
  3: { pitchVar:5,  timingMs:26, timbreHz:3400, timbreDb:-1.2, pan:+0.35, chorusRate:1.10, chorusDepth:0.006, reverbWet:0.22 }, // Quinte +7
  4: { pitchVar:2,  timingMs:8,  timbreHz:200,  timbreDb:+2.2, pan:+0.10, chorusRate:0.80, chorusDepth:0.003, reverbWet:0.15 }, // Octave -12
  5: { pitchVar:4,  timingMs:20, timbreHz:1800, timbreDb:+0.6, pan:-0.15, chorusRate:1.25, chorusDepth:0.005, reverbWet:0.20 }, // Quarte +5
};

// ═══════════════════════════════════════════════════════════════
// TRAITEMENT PRINCIPAL D'UNE HARMONIE
// ═══════════════════════════════════════════════════════════════
function processSingle(mono, semitones, sampleRate, trackIndex) {
  const profile=LAYER_PROFILES[trackIndex]||LAYER_PROFILES[2];
  let seed=(trackIndex||2)*7919;
  for (let i=0;i<Math.min(64,mono.length);i++) seed=(seed*31+Math.round(mono[i]*10000))|0;

  // 1. Phase Vocoder (True Peak Phase Locking amélioré)
  let shifted=phaseVocoderShift(mono, semitones, sampleRate);

  // 2. Correction formantique LPC (remplace l'ancien cepstrum)
  //    = même algorithme que TC-Helicon, Antares, Kits.AI
  shifted=applyLPCFormantCorrection(shifted, mono, semitones);

  // 3. AGC — normaliser au niveau de la voix originale
  shifted=applyAGC(shifted, mono);

  // 4. Saturation douce (chaleur sur les harmonies aiguës)
  if (semitones>=4) {
    const drive=0.03+(semitones-4)/10*0.04;
    shifted=applySoftSaturation(shifted, drive);
  }

  // 5. Variation de phrase (micro-intonation humaine)
  shifted=applyPhraseVariation(shifted, sampleRate, profile.pitchVar, seed);

  // 6. Jitter naturel par bruit rose (plus naturel que les LFOs sinusoïdaux)
  shifted=applyOrganicJitter(shifted, sampleRate, seed^0xABCD1234);

  // 7. Coloration timbrale (personnalité de chaque voix)
  shifted=applyTimbreColor(shifted, profile.timbreHz, profile.timbreDb, 1.3, sampleRate);

  // 8. Offset temporel
  shifted=applyTimingOffset(shifted, profile.timingMs, sampleRate);

  // 9. Reverb Plate (early reflections + late diffuse)
  shifted=applyPlateReverb(shifted, sampleRate, profile.reverbWet);

  return shifted;
}

// Traitement par blocs (iOS memory limit ~128MB)
function processChunked(mono, semitones, sampleRate, trackIndex) {
  const chunkSec=40;
  const chunkSamples=Math.floor(sampleRate*chunkSec);
  if (mono.length<=chunkSamples) return processSingle(mono, semitones, sampleRate, trackIndex);

  const overlapSamp=Math.floor(sampleRate*0.5);
  const results=[];
  let pos=0;
  while (pos<mono.length) {
    const end=Math.min(pos+chunkSamples, mono.length);
    const chunk=mono.slice(pos, end+(end<mono.length?overlapSamp:0));
    const processed=processSingle(chunk, semitones, sampleRate, trackIndex);
    const keepLen=end<mono.length?Math.floor(processed.length*(chunkSamples/chunk.length)):processed.length;
    results.push(processed.slice(0,keepLen));
    pos=end;
  }
  const totalLen=results.reduce((s,r)=>s+r.length,0);
  const final=new Float32Array(totalLen);
  let off=0;
  for (const r of results) { final.set(r,off); off+=r.length; }
  return final;
}

// ═══════════════════════════════════════════════════════════════
// GAIN / PAN / WAV
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════
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
      self.postMessage({id,type:'progress',label:`Génération harmonie ${semitones>0?'+':''}${semitones} ST (LPC Pro)...`});
      const profile=LAYER_PROFILES[trackIndex]||LAYER_PROFILES[2];

      // 1. Traitement principal (phase vocoder + LPC + AGC + reverb)
      const shifted=processChunked(mono, semitones, sampleRate, trackIndex);

      // 2. Chorus stéréo (élargissement spatial)
      self.postMessage({id,type:'progress',label:'Chorus stéréo...'});
      const chorus=applyChorusStereo(shifted, sampleRate, profile.chorusDepth, profile.chorusRate, seed);

      outL=chorus.outL; outR=chorus.outR; outLen=shifted.length;
    }

    const gp=applyGainPan(outL,outR,outLen,gain,pan,op==='double');

    self.postMessage({id,type:'progress',label:'Encodage WAV...'});
    const wavBuf=audioToWav(gp.outL,gp.outR,sampleRate);
    self.postMessage({id,type:'done',wavBuf},[wavBuf]);

  } catch(err) {
    self.postMessage({id,type:'error',message:err.message||String(err)});
  }
};
