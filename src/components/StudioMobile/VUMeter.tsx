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

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const draw = () => {
      analyser.getByteFrequencyData(dataArray);

      // RMS sur les fréquences vocales (bins 2-30 environ sur 44kHz/fftSize 256)
      let sum = 0;
      const end = Math.min(30, dataArray.length);
      for (let i = 2; i < end; i++) sum += dataArray[i] * dataArray[i];
      const rms   = Math.sqrt(sum / (end - 2)) / 255;
      const level = Math.min(1, rms * 2.5);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const bars = 20;
      const w    = canvas.width / bars - 1;

      for (let i = 0; i < bars; i++) {
        const threshold = i / bars;
        const lit       = threshold < level;
        const isHot     = i > bars * 0.8;
        const isMid     = i > bars * 0.6;
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
