/**
 * WaveformBar.tsx — Visualisation waveform SVG
 *
 * Affiche la forme d'onde d'un enregistrement.
 * Si playbackPct est fourni, un overlay de lecture avance sur la waveform.
 * Charge la waveform depuis analyzeWaveform() au montage si dataUrl est fourni.
 */
import React, { useEffect, useState, useRef } from 'react';
import { studioService } from '../../services/StudioService';

interface Props {
  dataUrl?:     string;           // Pour calculer la waveform depuis l'audio
  waveform?:    number[];         // Ou fournir directement les données
  color?:       string;           // Couleur des barres
  height?:      number;           // Hauteur en px (défaut 36)
  points?:      number;           // Nombre de barres (défaut 60)
  playbackPct?: number;           // 0-100 : progression lecture
  isPlaying?:   boolean;
  dimmed?:      boolean;          // Piste muée
}

export default function WaveformBar({
  dataUrl, waveform: waveformProp, color = '#ef4444',
  height = 36, points = 60, playbackPct, isPlaying, dimmed,
}: Props) {
  const [waveform, setWaveform] = useState<number[]>(waveformProp || []);
  const [loading, setLoading]   = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (waveformProp) { setWaveform(waveformProp); return; }
    if (!dataUrl) return;
    cancelRef.current = false;
    setLoading(true);
    studioService.analyzeWaveform(dataUrl, points)
      .then(w => { if (!cancelRef.current) setWaveform(w); })
      .catch(() => {})
      .finally(() => { if (!cancelRef.current) setLoading(false); });
    return () => { cancelRef.current = true; };
  }, [dataUrl, points]);

  // Skeleton animé pendant le chargement
  if (loading || waveform.length === 0) {
    return (
      <div
        className="w-full rounded-lg overflow-hidden"
        style={{ height, background: '#18181b' }}>
        <div
          className="h-full rounded-lg animate-pulse"
          style={{ background: `${color}15` }}/>
      </div>
    );
  }

  const w = 100; // viewBox width
  const h = height;
  const barW = w / waveform.length;
  const gap  = Math.max(0.5, barW * 0.15);
  const playX = playbackPct != null ? (playbackPct / 100) * w : null;

  return (
    <div className="w-full relative" style={{ height }}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full h-full"
        style={{ opacity: dimmed ? 0.3 : 1 }}>

        {/* Barres de fond */}
        {waveform.map((v, i) => {
          const bh  = Math.max(2, v * (h * 0.85));
          const x   = i * barW + gap / 2;
          const y   = (h - bh) / 2;
          const isPlayed = playX != null && (x + barW / 2) < playX;

          return (
            <rect
              key={i}
              x={x} y={y}
              width={barW - gap} height={bh}
              rx={1}
              fill={isPlayed ? color : `${color}35`}
            />
          );
        })}

        {/* Curseur de lecture */}
        {playX != null && (
          <line
            x1={playX} y1={2} x2={playX} y2={h - 2}
            stroke={color} strokeWidth={1.5}
            strokeLinecap="round"
            opacity={isPlaying ? 1 : 0.6}
          />
        )}
      </svg>
    </div>
  );
}
