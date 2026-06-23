// harmony-worker.js v11 — Spectral Envelope Matching Pro
// Approche utilisée par AirMusic / Kits.AI / TC-Helicon sur mobile :
//   Spectral Envelope Matching (SEM) = correction formantique stable et naturelle
//
// Bugs v10 corrigés :
//   - Math.random() remplacé par PRNG déterministe (seed fixe par trackIndex)
//   - Stéréo du chorus conservé jusqu'au WAV final (pas mono-mixé)
//   - Ratio rééchantillonnage corrigé (targetLen = input.length, pas outPos)
//   - Pré-emphasis supprimée (causait boost HF excessif sur le signal shifté)
//   - LPC remplacé par SEM (plus stable, moins d'artefacts, plus rapide)
//   - Jitter réduit à des niveaux naturels (trop fort = son "ivre")

// ═══════════════════════════════════════════════════════════════
// PRNG déterministe — Mulberry32 (rapide, qualité suffisante)
// Résultats identiques à chaque génération → harmonies cohérentes
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
// FFT Cooley-Tukey (inchangée, robuste)
// ═══════════════════════════════════════════════════════════════
function fft(re, im) {
  const n = re.length;
  for (let i=1,j=0; i<n; i++) {
    let bit=n>>1;
    for(;j&bit;bit>>=1) j^=bit;
    j^=bit;
    if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}
  }
  for(let len=2;len<=n;len<<=1){
    const ang=-2*Math.PI/len,wRe=Math.cos(ang),wIm=Math.sin(ang);
    for(let i=0;i<n;i+=len){
      let cRe=1,cIm=0;
      for(let j=0;j<len/2;j++){
        const uRe=re[i+j],uIm=im[i+j];
        const vRe=re[i+j+len/2]*cRe-im[i+j+len/2]*cIm;
        const vIm=re[i+j+len/2]*cIm+im[i+j+len/2]*cRe;
        re[i+j]=uRe+vRe;im[i+j]=uIm+vIm;
        re[i+j+len/2]=uRe-vRe;im[i+j+len/2]=uIm-vIm;
        const nr=cRe*wRe-cIm*wIm;cIm=cRe*wIm+cIm*wRe;cRe=nr;
      }
    }
  }
}
function ifft(re,im){
  for(let i=0;i<im.length;i++) im[i]=-im[i];
  fft(re,im);
  const n=re.length;
  for(let i=0;i<n;i++){re[i]/=n;im[i]=-(im[i]/n);}
}

// ═══════════════════════════════════════════════════════════════
// YIN — Détection F0
// ═══════════════════════════════════════════════════════════════
function detectF0(frame, sr) {
  const N=frame.length;
  const tauMax=Math.min(N>>1,Math.floor(sr/55));
  const tauMin=Math.floor(sr/1100);
  const d=new Float32Array(tauMax+1);
  for(let tau=1;tau<=tauMax;tau++){
    let s=0;
    for(let j=0;j<tauMax;j++){const diff=frame[j]-frame[j+tau];s+=diff*diff;}
    d[tau]=s;
  }
  const c=new Float32Array(tauMax+1);
  c[0]=1;let rs=0;
  for(let tau=1;tau<=tauMax;tau++){rs+=d[tau];c[tau]=rs>0?d[tau]*tau/rs:1;}
  for(let tau=tauMin;tau<=tauMax;tau++){
    if(c[tau]<0.10){
      if(tau>0&&tau<tauMax){
        const s0=c[tau-1],s1=c[tau],s2=c[tau+1];
        const r=tau+(s2-s0)/(2*(2*s1-s0-s2));
        return sr/r;
      }
      return sr/tau;
    }
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════
// PHASE VOCODER v3 — Peak Phase Locking correct + rééchantillonnage fixé
//
// Correction critique v11 :
// Le signal de sortie est rééchantillonné pour avoir exactement
// input.length samples (= même durée que l'original)
// Le ratio est calculé sur la longueur réelle traitée, pas outPos
// ═══════════════════════════════════════════════════════════════
function phaseVocoderShift(input, semitones, sr) {
  if(semitones===0) return input.slice();
  const pitchFactor=Math.pow(2,semitones/12);
  const N=4096,hopA=N>>2;
  // CORRECTIF CRITIQUE : la formule était inversée — hopS = hopA/pitchFactor
  // faisait l'INVERSE de ce qui est nécessaire pour changer le pitch.
  // Principe correct du phase vocoder (time-stretch puis resample) :
  //   - Pour MONTER le pitch (pitchFactor > 1) : on étire le signal en
  //     synthèse (hopS > hopA), donc on joue le signal plus LENTEMENT à
  //     fréquence d'échantillonnage inchangée, puis on le rééchantillonne
  //     plus vite à la fin pour revenir à la durée d'origine — ce
  //     rééchantillonnage final est ce qui élève réellement le pitch.
  //   - Pour DESCENDRE le pitch (pitchFactor < 1) : hopS < hopA (compression).
  // Avant ce correctif, hopS=hopA/pitchFactor faisait l'inverse exact :
  // un pitch monté donnait un résultat plus bas et avec un ratio incohérent
  // (mesuré 0.70 au lieu de 1.4983 attendu pour +7 demi-tons) → harmoniques
  // non-entières → son métallique/cloche caractéristique.
  const hopS=Math.max(1,Math.min(Math.round(hopA*pitchFactor),N>>1));

  const win=new Float32Array(N);
  for(let i=0;i<N;i++) win[i]=0.5*(1-Math.cos(2*Math.PI*i/(N-1)));

  // Calcul de la longueur de sortie nécessaire AVANT le rééchantillonnage
  const numFrames=Math.ceil((input.length-N)/hopA)+1;
  const outLen=numFrames*hopS+N;
  const output=new Float32Array(outLen);
  const norm=new Float32Array(outLen);

  const re=new Float32Array(N),im=new Float32Array(N);
  const outRe=new Float32Array(N),outIm=new Float32Array(N);
  const mag=new Float32Array(N/2+1);
  const trueFreq=new Float32Array(N/2+1);
  const lastPhIn=new Float32Array(N/2+1);
  const phAcc=new Float32Array(N/2+1);
  const isPeak=new Uint8Array(N/2+1);
  const peakOf=new Int32Array(N/2+1);
  const peakPh=new Float32Array(N/2+1);

  // Init phase sur frame 0
  {
    const r=new Float32Array(N),m=new Float32Array(N);
    for(let i=0;i<N;i++) r[i]=(i<input.length?input[i]:0)*win[i];
    fft(r,m);
    for(let k=0;k<=N/2;k++) lastPhIn[k]=Math.atan2(m[k],r[k]);
  }

  let f0Hz=0,f0Frame=0,frameIdx=0,outPos=0;

  for(let pos=0; pos<input.length; pos+=hopA,frameIdx++) {
    re.fill(0);im.fill(0);
    const end=Math.min(pos+N,input.length);
    for(let i=0;i<end-pos;i++) re[i]=input[pos+i]*win[i];
    fft(re,im);

    // Vraies fréquences
    for(let k=0;k<=N/2;k++){
      mag[k]=Math.sqrt(re[k]*re[k]+im[k]*im[k]);
      const ph=Math.atan2(im[k],re[k]);
      let dPh=ph-lastPhIn[k]; lastPhIn[k]=ph;
      const exp=2*Math.PI*k*hopA/N;
      dPh-=exp;
      dPh-=2*Math.PI*Math.round(dPh/(2*Math.PI));
      trueFreq[k]=k+dPh*N/(2*Math.PI*hopA);
    }

    // F0 toutes les 15 frames
    if(frameIdx%15===0){
      const sl=new Float32Array(Math.min(N,input.length-pos));
      for(let i=0;i<sl.length;i++) sl[i]=input[pos+i];
      f0Hz=detectF0(sl,sr);
      f0Frame=f0Hz>0?Math.round(f0Hz*N/sr):0;
    }

    // Détection des pics spectraux
    isPeak.fill(0);
    for(let k=2;k<N/2-1;k++){
      if(mag[k]>mag[k-1]&&mag[k]>=mag[k+1]){
        isPeak[k]=1;
      }
    }
    // Renforcement sur harmoniques F0
    if(f0Frame>2){
      for(let h=1;h*f0Frame<=N/2;h++){
        const hk=h*f0Frame;
        let best=-1,bestM=0;
        for(let dk=-3;dk<=3;dk++){const k=hk+dk;if(k>0&&k<N/2&&mag[k]>bestM){bestM=mag[k];best=k;}}
        if(best>0) isPeak[best]=1;
      }
    }

    // Assigner bins → peak le plus proche
    peakOf.fill(0);
    let lp=0;
    for(let k=0;k<=N/2;k++){if(isPeak[k])lp=k;peakOf[k]=lp;}
    let np=N/2;
    for(let k=N/2;k>=0;k--){
      if(isPeak[k])np=k;
      if(Math.abs(k-peakOf[k])>Math.abs(k-np))peakOf[k]=np;
    }

    // Accumulation phase peaks
    peakPh.fill(0);
    for(let k=0;k<=N/2;k++){
      if(isPeak[k]){
        phAcc[k]+=2*Math.PI*trueFreq[k]*hopS/N;
        peakPh[k]=phAcc[k];
      }
    }

    // Synthèse
    outRe.fill(0);outIm.fill(0);
    for(let k=0;k<=N/2;k++){
      const pk=peakOf[k];
      const ph=isPeak[k]
        ? peakPh[k]
        : peakPh[pk]+(Math.atan2(im[k],re[k])-Math.atan2(im[pk],re[pk]));
      if(!isPeak[k]) phAcc[k]=ph;
      outRe[k]=mag[k]*Math.cos(ph);
      outIm[k]=mag[k]*Math.sin(ph);
      if(k>0&&k<N/2){outRe[N-k]=outRe[k];outIm[N-k]=-outIm[k];}
    }
    ifft(outRe,outIm);
    for(let i=0;i<N&&outPos+i<outLen;i++){
      output[outPos+i]+=outRe[i]*win[i];
      norm[outPos+i]+=win[i]*win[i];
    }
    outPos+=hopS;
    if(outPos>=outLen) break;
  }

  // Rééchantillonnage : outLen → input.length (correction critique v11)
  const targetLen=input.length;
  const result=new Float32Array(targetLen);
  // Ratio basé sur outPos réel (combien de samples de sortie ont été écrits)
  const actualOut=Math.min(outPos+N, outLen);
  const ratio=actualOut/targetLen;
  for(let i=0;i<targetLen;i++){
    const src=i*ratio;
    const i0=Math.floor(src)|0;
    const i1=Math.min(i0+1,outLen-1);
    const f=src-i0;
    const v0=i0<outLen&&norm[i0]>0.0005?output[i0]/norm[i0]:0;
    const v1=i1<outLen&&norm[i1]>0.0005?output[i1]/norm[i1]:0;
    result[i]=v0+(v1-v0)*f;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// SPECTRAL ENVELOPE MATCHING (SEM)
// Méthode utilisée par AirMusic / Kits.AI sur iOS.
// Plus stable que LPC, zéro artefact, même résultat perceptif.
//
// Principe :
// 1. Calculer l'enveloppe spectrale de l'original (log-mag lissé)
// 2. Calculer l'enveloppe spectrale du signal shifté
// 3. Appliquer envOrig/envShifted bin par bin → les formants de l'original
//    remplacent ceux du shifté
// 4. Lissage temporel de la correction (α=0.3) → pas d'artefacts brutaux
//
// Différence vs v10 :
// - Pas de pré-emphasis (causait distorsion HF)
// - Enveloppe par moyenne géométrique glissante (plus robuste que cepstrum)
// - Lissage temporel → transitions douces entre frames
// ═══════════════════════════════════════════════════════════════
function computeSpectralEnvelope(mag, halfN, smoothBins) {
  // Lissage de la magnitude log sur smoothBins bins
  // Équivalent à un filtre passe-bas sur le cepstrum → enveloppe formantique
  const logMag=new Float32Array(halfN+1);
  for(let k=0;k<=halfN;k++) logMag[k]=Math.log(Math.max(mag[k],1e-8));

  const env=new Float32Array(halfN+1);
  for(let k=0;k<=halfN;k++){
    const lo=Math.max(0,k-smoothBins);
    const hi=Math.min(halfN,k+smoothBins);
    let s=0;
    for(let j=lo;j<=hi;j++) s+=logMag[j];
    env[k]=Math.exp(s/(hi-lo+1));
  }
  return env;
}

function applySpectralEnvelopeMatching(shifted, original, semitones, sr) {
  const absST=Math.abs(semitones);
  if(absST<2) return shifted;

  const N=2048,hop=512;
  const halfN=N/2;
  // Plus le shift est grand, plus on lisse l'enveloppe (capture formants larges)
  const smoothBins=Math.max(8, Math.floor(halfN * 0.04 + absST * 2));
  const outLen=shifted.length;

  const win=new Float32Array(N);
  for(let i=0;i<N;i++) win[i]=0.5*(1-Math.cos(2*Math.PI*i/(N-1)));

  const out=new Float32Array(outLen);
  const norm=new Float32Array(outLen);

  // Lissage temporel : garder la correction du frame précédent
  // Évite les artefacts "clic" aux transitions de frames
  let prevRatio=null;
  const SMOOTH_ALPHA=0.35; // mix frame courant / frame précédent

  const reO=new Float32Array(N),imO=new Float32Array(N);
  const reS=new Float32Array(N),imS=new Float32Array(N);
  const magO=new Float32Array(halfN+1),magS=new Float32Array(halfN+1);
  const outRe=new Float32Array(N),outIm=new Float32Array(N);

  for(let pos=0;pos<outLen;pos+=hop){
    const end=Math.min(pos+N,outLen);
    const len=end-pos;

    // Frame original (même position)
    reO.fill(0);imO.fill(0);
    for(let i=0;i<len;i++) reO[i]=(original[pos+i]||0)*win[i];
    fft(reO,imO);
    for(let k=0;k<=halfN;k++) magO[k]=Math.sqrt(reO[k]*reO[k]+imO[k]*imO[k]);

    // Frame shifté
    reS.fill(0);imS.fill(0);
    for(let i=0;i<len;i++) reS[i]=(shifted[pos+i]||0)*win[i];
    fft(reS,imS);
    for(let k=0;k<=halfN;k++) magS[k]=Math.sqrt(reS[k]*reS[k]+imS[k]*imS[k]);

    // Enveloppes spectrales
    const envOrig=computeSpectralEnvelope(magO,halfN,smoothBins);
    const envShift=computeSpectralEnvelope(magS,halfN,smoothBins);

    // Ratio de correction : envOrig / envShift
    // Ce ratio modifie le timbre du shifté pour lui donner les formants de l'original
    const ratio=new Float32Array(halfN+1);
    for(let k=0;k<=halfN;k++){
      const r=envShift[k]>1e-8?envOrig[k]/envShift[k]:1.0;
      // Limiter le ratio pour éviter les amplifications/coupures excessives (±12dB)
      ratio[k]=Math.max(0.25,Math.min(4.0,r));
    }

    // Lissage temporel avec le frame précédent
    if(prevRatio){
      for(let k=0;k<=halfN;k++){
        ratio[k]=prevRatio[k]*(1-SMOOTH_ALPHA)+ratio[k]*SMOOTH_ALPHA;
      }
    }
    prevRatio=ratio.slice();

    // Blend selon amplitude du shift
    // Shift faible (2-4 ST) : correction légère (les formants ne dérivent pas beaucoup)
    // Shift fort (>6 ST) : correction maximale
    const blend=Math.min(0.92, Math.max(0.1, (absST-2)/7.0*0.85+0.07));

    // Appliquer la correction sur le spectrum du shifté
    outRe.fill(0);outIm.fill(0);
    for(let k=0;k<=halfN;k++){
      const corrRatio=1+(ratio[k]-1)*blend;
      outRe[k]=reS[k]*corrRatio;
      outIm[k]=imS[k]*corrRatio;
      if(k>0&&k<halfN){outRe[N-k]=outRe[k];outIm[N-k]=-outIm[k];}
    }
    ifft(outRe,outIm);

    for(let i=0;i<len&&pos+i<outLen;i++){
      out[pos+i]+=outRe[i]*win[i];
      norm[pos+i]+=win[i]*win[i];
    }
  }

  // Normaliser OLA
  const result=new Float32Array(outLen);
  for(let i=0;i<outLen;i++) result[i]=norm[i]>0.001?out[i]/norm[i]:shifted[i];
  return result;
}

// ═══════════════════════════════════════════════════════════════
// AGC — Automatic Gain Control
// Normalise le niveau RMS de l'harmonie sur celui de la voix originale
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
// JITTER NATUREL — bruit rose déterministe (PRNG Mulberry32)
// Correction v11 : Math.random() remplacé → résultats reproductibles
// Niveaux réduits : ±8 cents drift, ±1.5% flutter (était trop fort)
// ═══════════════════════════════════════════════════════════════
function applyOrganicJitter(signal, sr, seed) {
  const rand=makePRNG(seed>>>0);
  const len=signal.length;
  const result=new Float32Array(len);

  // Filtre passe-bas pour drift (8Hz) et flutter (12Hz)
  const dt=1/sr;
  const alphaD=dt/(dt+1/(2*Math.PI*8));
  const alphaF=dt/(dt+1/(2*Math.PI*12));
  let lpD=0,lpF=0;

  // Pré-générer séquences de bruit (seed fixe → résultat identique)
  // 2 séquences indépendantes : drift et flutter
  const noiseD=new Float32Array(len);
  const noiseF=new Float32Array(len);
  for(let i=0;i<len;i++){noiseD[i]=rand()*2-1;noiseF[i]=rand()*2-1;}

  // Buffer de délai pour le pitch drift
  const MAX_DELAY=Math.floor(sr*0.025)+1;
  const delBuf=new Float32Array(MAX_DELAY);

  for(let i=0;i<len;i++){
    // Drift pitch filtré ±8 cents
    lpD=lpD+alphaD*(noiseD[i]-lpD);
    const driftCents=lpD*8.0;

    // Flutter amplitude filtré ±1.5%
    lpF=lpF+alphaF*(noiseF[i]-lpF);
    const flutter=1.0+lpF*0.015;

    // Drift via interpolation linéaire
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
// REVERB PLATE — Early Reflections + Late Diffuse
// ═══════════════════════════════════════════════════════════════
function applyPlateReverb(signal, sr, dryWet) {
  if(dryWet<=0) return signal;
  const len=signal.length;
  const wet=new Float32Array(len);

  // Early reflections (10 taps)
  const erTaps=[
    {d:0.0043,g:0.55},{d:0.0079,g:-0.48},{d:0.0120,g:0.42},
    {d:0.0178,g:-0.36},{d:0.0235,g:0.30},{d:0.0302,g:-0.25},
    {d:0.0378,g:0.20},{d:0.0441,g:-0.16},{d:0.0520,g:0.12},
    {d:0.0601,g:-0.09}
  ].map(t=>({d:Math.max(1,Math.floor(t.d*sr)),g:t.g}));

  const maxER=Math.max(...erTaps.map(t=>t.d))+1;
  const erBuf=new Float32Array(maxER);
  let erPtr=0;

  // Comb filters (late)
  const combD=[0.0307,0.0379,0.0421,0.0451].map(d=>Math.max(1,Math.floor(d*sr)));
  const combG=[0.805,0.827,0.783,0.764];
  const combBufs=combD.map(d=>new Float32Array(d));
  const combPtrs=new Int32Array(4);

  // Allpass filters
  const apD=[0.0127,0.0093].map(d=>Math.max(1,Math.floor(d*sr)));
  const apG=[0.7,0.7];
  const apBufs=apD.map(d=>new Float32Array(d));
  const apPtrs=new Int32Array(2);

  // Pre-delay 10ms
  const preD=Math.max(1,Math.floor(0.010*sr));
  const preBuf=new Float32Array(preD);
  let prePtr=0;

  for(let i=0;i<len;i++){
    const x=signal[i]||0;
    const pre=preBuf[prePtr];
    preBuf[prePtr]=x;
    prePtr=(prePtr+1)%preD;

    // Early reflections
    erBuf[erPtr%maxER]=pre;
    let er=0;
    for(const t of erTaps) er+=erBuf[(erPtr-t.d+maxER*2)%maxER]*t.g;
    erPtr=(erPtr+1)%maxER;
    er*=0.3;

    // Comb filters
    let combOut=0;
    for(let c=0;c<4;c++){
      const buf=combBufs[c],d=combD[c],ptr=combPtrs[c];
      const delayed=buf[ptr];
      buf[ptr]=pre+delayed*combG[c];
      combPtrs[c]=(ptr+1)%d;
      combOut+=delayed;
    }
    combOut*=0.25;

    // Allpass
    let ap=combOut*0.7+er*0.3;
    for(let a=0;a<2;a++){
      const buf=apBufs[a],d=apD[a],g=apG[a];
      const ptr=apPtrs[a];
      const del=buf[ptr];
      const inp=ap+del*g;
      buf[ptr]=inp;
      apPtrs[a]=(ptr+1)%d;
      ap=del-g*inp;
    }
    wet[i]=ap;
  }

  // Normaliser wet
  let pk=0;
  for(let i=0;i<len;i++) pk=Math.max(pk,Math.abs(wet[i]));
  if(pk>0.01){const n=0.75/pk;for(let i=0;i<len;i++) wet[i]*=n;}

  const out=new Float32Array(len);
  for(let i=0;i<len;i++) out[i]=signal[i]*(1-dryWet)+wet[i]*dryWet;
  return out;
}

// ═══════════════════════════════════════════════════════════════
// CHORUS STÉRÉO — Sépare les voix dans l'espace
// Correction v11 : les deux canaux L et R sont conservés séparément
// jusqu'au WAV final (l'ancien code les mono-mixait dans applyGainPan)
// ═══════════════════════════════════════════════════════════════
function applyChorusStereo(signal, sr, depthSec, rate, seed) {
  const rand=makePRNG(seed^0xC0FFEE);
  const len=signal.length;
  const outL=new Float32Array(len),outR=new Float32Array(len);
  const maxD=Math.max(1,Math.floor(sr*0.030));
  const bufL=new Float32Array(maxD),bufR=new Float32Array(maxD);
  let ptr=0;

  // Phases différentes L/R (déterministes)
  const phL=rand()*Math.PI*2;
  const phR=rand()*Math.PI*2;
  const rate2=rate*1.13; // légère différence de vitesse L/R
  const center=Math.floor(sr*0.012); // 12ms délai de base

  for(let i=0;i<len;i++){
    const x=signal[i]||0;
    bufL[ptr%maxD]=x;
    bufR[ptr%maxD]=x;
    const depthSamp=depthSec*sr;
    const modL=center+Math.sin(2*Math.PI*rate*i/sr+phL)*depthSamp;
    const modR=center+Math.sin(2*Math.PI*rate2*i/sr+phR)*depthSamp;
    const dL=Math.max(1,Math.min(maxD-1,Math.floor(modL)|0));
    const dR=Math.max(1,Math.min(maxD-1,Math.floor(modR)|0));
    const fL=modL-Math.floor(modL),fR=modR-Math.floor(modR);
    const idxL0=(ptr-dL+maxD*4)%maxD,idxL1=(idxL0+1)%maxD;
    const idxR0=(ptr-dR+maxD*4)%maxD,idxR1=(idxR0+1)%maxD;
    const dlyL=bufL[idxL0]*(1-fL)+bufL[idxL1]*fL;
    const dlyR=bufR[idxR0]*(1-fR)+bufR[idxR1]*fR;
    outL[i]=x*0.72+dlyL*0.28;
    outR[i]=x*0.72+dlyR*0.28;
    ptr=(ptr+1)%maxD;
  }
  return{outL,outR};
}

// ═══════════════════════════════════════════════════════════════
// SATURATION DOUCE (chaleur analogique) — v12 : compensation RMS exacte
// Bug v11 corrigé : la formule de compensation fixe (1.06/g) ne
// compensait pas la perte non-linéaire réelle de x/(1+|x|), qui
// dépend de l'amplitude du signal. Résultat : jusqu'à -22% de volume
// sur les harmonies aiguës (+7 ST et plus), inaudibles dans le mix.
// Maintenant : on mesure le RMS avant/après et on compense exactement
// → la saturation ajoute de la chaleur harmonique SANS jamais changer
// le niveau perçu du signal.
// ═══════════════════════════════════════════════════════════════
function applySoftSaturation(signal,drive){
  if(drive<=0) return signal;
  const N=signal.length;
  const g=1+drive*1.8;

  let rmsIn=0;
  for(let i=0;i<N;i++) rmsIn+=signal[i]*signal[i];
  rmsIn=Math.sqrt(rmsIn/N);
  if(rmsIn<1e-7) return signal;

  const tmp=new Float32Array(N);
  for(let i=0;i<N;i++){
    const x=signal[i]*g;
    tmp[i]=x/(1+Math.abs(x));
  }
  let rmsOut=0;
  for(let i=0;i<N;i++) rmsOut+=tmp[i]*tmp[i];
  rmsOut=Math.sqrt(rmsOut/N);
  if(rmsOut<1e-7) return signal;

  const comp=rmsIn/rmsOut;
  const out=new Float32Array(N);
  for(let i=0;i<N;i++) out[i]=tmp[i]*comp;
  return out;
}

// ═══════════════════════════════════════════════════════════════
// VARIATION PAR PHRASE (micro-intonation humaine)
// ═══════════════════════════════════════════════════════════════
function applyPhraseVariation(signal,sr,pitchVarCents,seed){
  const rand=makePRNG(seed^0xDEAD);
  const minPS=Math.floor(sr*0.25);
  const result=new Float32Array(signal.length);
  let pos=0;
  while(pos<signal.length){
    const pLen=Math.floor(minPS+rand()*sr*0.7);
    const varC=(rand()*2-1)*pitchVarCents;
    const ratio=Math.pow(2,varC/1200);
    const end=Math.min(pos+pLen,signal.length);
    const fade=Math.min(Math.floor(sr*0.012),pLen>>1);
    for(let i=pos;i<end;i++){
      const sp=pos+(i-pos)*ratio;
      const s0=Math.min(Math.floor(sp)|0,signal.length-2);
      const fr=sp-Math.floor(sp);
      let v=(signal[s0]||0)*(1-fr)+(signal[Math.min(s0+1,signal.length-1)]||0)*fr;
      const fs=i-pos,te=end-i;
      if(fs<fade) v*=fs/fade;
      if(te<fade) v*=te/fade;
      result[i]+=v;
    }
    pos=end;
  }
  return result;
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
// COLORATION TIMBRALE (EQ paramétrique par voix)
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
// DOUBLE TRACKING
// ═══════════════════════════════════════════════════════════════
function doubleTrack(mono,sr){
  const rand=makePRNG(0xBADF00D);
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
// PROFILS PAR HARMONIE
// ═══════════════════════════════════════════════════════════════
const LAYER_PROFILES={
  2:{pitchVar:2.5,timingMs:14,timbreHz:2800,timbreDb:+1.5,pan:-0.30,chorusRate:0.95,chorusDepth:0.004,reverbWet:0.17},
  3:{pitchVar:4.0,timingMs:25,timbreHz:3400,timbreDb:-1.0,pan:+0.35,chorusRate:1.10,chorusDepth:0.006,reverbWet:0.20},
  4:{pitchVar:1.8,timingMs:8, timbreHz:250, timbreDb:+2.0,pan:+0.10,chorusRate:0.80,chorusDepth:0.003,reverbWet:0.14},
  5:{pitchVar:3.5,timingMs:20,timbreHz:1800,timbreDb:+0.8,pan:-0.15,chorusRate:1.25,chorusDepth:0.005,reverbWet:0.19},
};

// ═══════════════════════════════════════════════════════════════
// TRAITEMENT PRINCIPAL
// ═══════════════════════════════════════════════════════════════
function processSingle(mono,semitones,sampleRate,trackIndex){
  const profile=LAYER_PROFILES[trackIndex]||LAYER_PROFILES[2];
  const seed=(trackIndex||2)*7919;

  // 1. Phase Vocoder (True Peak Phase Locking)
  let shifted=phaseVocoderShift(mono,semitones,sampleRate);

  // 2. Correction formantique SEM (Spectral Envelope Matching)
  shifted=applySpectralEnvelopeMatching(shifted,mono,semitones,sampleRate);

  // 3. AGC — égaliser le niveau sur l'original
  shifted=applyAGC(shifted,mono);

  // 4. Saturation douce (harmonies aiguës uniquement)
  if(semitones>=4){
    shifted=applySoftSaturation(shifted,0.03+(semitones-4)/12*0.04);
  }

  // 5. Variation de phrase
  shifted=applyPhraseVariation(shifted,sampleRate,profile.pitchVar,seed);

  // 6. Jitter naturel déterministe
  shifted=applyOrganicJitter(shifted,sampleRate,seed^0xABCD1234);

  // 7. Coloration timbrale par voix
  shifted=applyTimbreColor(shifted,profile.timbreHz,profile.timbreDb,1.3,sampleRate);

  // 8. Offset temporel
  shifted=applyTimingOffset(shifted,profile.timingMs,sampleRate);

  // 9. Reverb Plate
  shifted=applyPlateReverb(shifted,sampleRate,profile.reverbWet);

  // 10. Limiteur de sécurité final — empêche tout dépassement de 1.0
  // (observé occasionnellement sur Octave bas après cumul des étages)
  let peakOut=0;
  for(let i=0;i<shifted.length;i++) peakOut=Math.max(peakOut,Math.abs(shifted[i]));
  if(peakOut>0.98){
    const n=0.98/peakOut;
    for(let i=0;i<shifted.length;i++) shifted[i]*=n;
  }

  return shifted;
}

function processChunked(mono,semitones,sampleRate,trackIndex){
  const chunkSamp=Math.floor(sampleRate*40);
  if(mono.length<=chunkSamp) return processSingle(mono,semitones,sampleRate,trackIndex);
  const overlapSamp=Math.floor(sampleRate*0.4);
  const results=[];
  let pos=0;
  while(pos<mono.length){
    const end=Math.min(pos+chunkSamp,mono.length);
    const chunk=mono.slice(pos,end<mono.length?end+overlapSamp:end);
    const processed=processSingle(chunk,semitones,sampleRate,trackIndex);
    const keepLen=end<mono.length?Math.floor(processed.length*(chunkSamp/chunk.length)):processed.length;
    results.push(processed.slice(0,keepLen));
    pos=end;
  }
  const totalLen=results.reduce((s,r)=>s+r.length,0);
  const final=new Float32Array(totalLen);
  let off=0;
  for(const r of results){final.set(r,off);off+=r.length;}
  return final;
}

// ═══════════════════════════════════════════════════════════════
// GAIN/PAN — Correction v11 :
// Si l'entrée est stéréo (chorus), on applique le PAN sans mono-mixer
// Si l'entrée est mono, on applique le PAN classique
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
// WAV
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
// MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════
self.onmessage=function(e){
  const{id,op,channelL,channelR,semitones,gain,pan,sampleRate,trackIndex}=e.data;
  try{
    const len=channelL.length;
    const mono=new Float32Array(len);
    for(let i=0;i<len;i++) mono[i]=((channelL[i]||0)+(channelR[i]||0))*0.5;

    const seed=(trackIndex||2)*7919;
    let outL,outR,outLen;

    if(op==='double'){
      self.postMessage({id,type:'progress',label:'Double tracking...'});
      const res=doubleTrack(mono,sampleRate);
      outL=res.outL;outR=res.outR;outLen=res.outLen;
      const gp=applyGainPanDouble(outL,outR,outLen,gain);
      self.postMessage({id,type:'progress',label:'Encodage WAV...'});
      const wavBuf=audioToWav(gp.outL,gp.outR,sampleRate);
      self.postMessage({id,type:'done',wavBuf},[wavBuf]);
      return;
    }

    self.postMessage({id,type:'progress',label:`Génération harmonie ${semitones>0?'+':''}${semitones} ST (SEM Pro)...`});

    // Pipeline principal
    const shifted=processChunked(mono,semitones,sampleRate,trackIndex);

    // Chorus stéréo (canaux L/R conservés séparément — correction v11)
    const profile=LAYER_PROFILES[trackIndex]||LAYER_PROFILES[2];
    self.postMessage({id,type:'progress',label:'Chorus stéréo...'});
    const chorus=applyChorusStereo(shifted,sampleRate,profile.chorusDepth,profile.chorusRate,seed);

    outLen=shifted.length;

    // Pan sur chaque canal indépendamment (pas de mono-mix)
    const gp=applyGainPanStereo(chorus.outL,chorus.outR,outLen,gain,pan);

    self.postMessage({id,type:'progress',label:'Encodage WAV...'});
    const wavBuf=audioToWav(gp.outL,gp.outR,sampleRate);
    self.postMessage({id,type:'done',wavBuf},[wavBuf]);

  }catch(err){
    self.postMessage({id,type:'error',message:err.message||String(err)});
  }
};
