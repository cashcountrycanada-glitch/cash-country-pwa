/**
 * VUMeter.tsx — VU-mètre réel via AnalyserNode
 * Alimenté par MediaStreamSource → AnalyserNode (jamais connecté à destination).
 * Le basculement AVAudioSession est déjà absorbé au démarrage — pas de dégradation.
 */
import React, { useRef, useEffect } from 'react';

interface Props {
  analyser: AnalyserNode | null;
  active:   boolean;
  vuLevel?: number; // ignoré — conservé pour compatibilité
}

export default function VUMeter({ analyser, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef    = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    if (!active || !analyser) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Barres éteintes quand inactif
      const bars = 20;
      const w    = canvas.width / bars - 1;
      for (let i = 0; i < bars; i++) {
        ctx.fillStyle = '#1a1a1a';
        const h = canvas.height * (0.4 + 0.6 * (i / bars));
        ctx.fillRect(i * (w + 1), canvas.height - h, w, h);
      }
      return;
    }

    // FIX MÈTRE MAL CALIBRÉ : l'ancienne version mesurait une énergie
    // fréquentielle approximative (FFT bins 2-30 × facteur arbitraire 2.5),
    // sans rapport direct avec le vrai niveau dBFS. Ça pouvait afficher du
    // rouge/jaune bien avant que le signal ne soit réellement proche du
    // clipping (et pousser à baisser le gain d'entrée pour rien, donnant des
    // prises beaucoup trop faibles). On utilise maintenant le vrai signal
    // temporel (crête réelle) pour calculer un niveau en dBFS et des seuils
    // de couleur qui correspondent à la réalité :
    //   vert   : jusqu'à -18 dBFS (zone saine)
    //   jaune  : -18 à -6 dBFS (fort mais correct)
    //   rouge  : au-dessus de -6 dBFS (proche du clipping, à surveiller)
    const timeData = new Uint8Array(analyser.fftSize);

    const draw = () => {
      analyser.getByteTimeDomainData(timeData);

      // Crête réelle sur la fenêtre courante (valeurs centrées sur 128)
      let peak = 0;
      for (let i = 0; i < timeData.length; i++) {
        const v = Math.abs(timeData[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      const dbfs  = peak > 0.0001 ? 20 * Math.log10(peak) : -80;
      // Mappe -60dBFS→0 ... 0dBFS→1 pour la hauteur des barres
      const level = Math.max(0, Math.min(1, (dbfs + 60) / 60));

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const bars = 20;
      const w    = canvas.width / bars - 1;

      for (let i = 0; i < bars; i++) {
        const threshold = i / bars;
        const lit       = threshold < level;
        // Seuils en vrai dBFS : jaune à partir de -18dBFS, rouge à partir de -6dBFS
        const barDb  = (i / bars) * 60 - 60;
        const isHot  = barDb > -6;
        const isMid  = barDb > -18;
        ctx.fillStyle   = lit
          ? (isHot ? '#ef4444' : isMid ? '#eab308' : '#22c55e')
          : '#1a1a1a';
        const h = canvas.height * (0.4 + 0.6 * (i / bars));
        ctx.fillRect(i * (w + 1), canvas.height - h, w, h);
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(rafRef.current);
  }, [active, analyser]);

  return (
    <canvas
      ref={canvasRef}
      width={280}
      height={60}
      className="w-full rounded-xl"
      style={{ background: '#0a0a0a', maxWidth: 320 }}
    />
  );
}
