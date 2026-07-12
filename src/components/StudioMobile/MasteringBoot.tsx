/**
 * MasteringBoot.tsx — Sas d'initialisation ultra-léger avant Mastering (v7.6.425)
 *
 * OBJECTIF DIAGNOSTIC : le crash "Script error." sur l'écran Mastering
 * survient AVANT même la première ligne de l'effet de montage de
 * MasteringEngine (aucun breadcrumb, même synchrone, n'apparaît). Deux
 * causes possibles restent en lice :
 *   A) Le RENDU LOURD de l'écran Mastering lui-même (nombreuses icônes
 *      lucide-react, dégradés Tailwind, sections empilées) fait planter
 *      le WebView iOS pendant la peinture initiale, avant que React
 *      n'ait la main pour exécuter le moindre useEffect.
 *   B) La logique de décodage/fermeture de contextes audio plante d'une
 *      façon qui empêche même le premier console.log/localStorage.
 *
 * Ce composant est volontairement SANS AUCUNE icône, SANS AUCUN dégradé,
 * juste du texte brut sur fond uni — le rendu le plus léger possible.
 * Il exécute EXACTEMENT les mêmes étapes que l'ancien effet de montage
 * de MasteringEngine, une par une, avec un log au tout début de CHAQUE
 * étape. Si le crash disparaît ici → c'était le poids du rendu (cause A).
 * Si le crash persiste ici, au même endroit → c'est la logique elle-même
 * (cause B), indépendamment de tout ce qui est affiché à l'écran.
 *
 * Une fois toutes les étapes réussies, on rend l'écran complet
 * MasteringEngine normalement — rien n'est retiré de son fonctionnement.
 */
import React, { useEffect, useState } from 'react';
import MasteringEngine, { MasteringProps } from './MasteringEngine';

const STEPS = [
  'Fermeture contexte micro',
  'Fermeture contexte preview',
  'Décodage de la voix',
  'Analyse du volume',
  'Prêt',
];

const bc = (msg: string) => {
  try {
    const t = new Date().toISOString().slice(11, 19);
    const existing = JSON.parse(localStorage.getItem('cc_breadcrumb_log') || '[]');
    existing.unshift(`[${t}] ${msg}`);
    localStorage.setItem('cc_breadcrumb_log', JSON.stringify(existing.slice(0, 150)));
    console.log('[boot]', msg);
  } catch {}
};

// Laisse le navigateur peindre l'étape courante avant de continuer.
const paint = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));

export default function MasteringBoot(props: MasteringProps) {
  const [step, setStep]         = useState(-1); // -1 = pas encore monté du tout
  const [error, setError]       = useState<string | null>(null);
  const [ready, setReady]       = useState(false);

  useEffect(() => {
    bc('🧪 MasteringBoot monté (rendu minimal, avant tout traitement)');
    (async () => {
      try {
        setStep(0); bc(`🧪 SAS étape 0/4: ${STEPS[0]}`);
        await paint();
        try { await (window as any).__warmContext?.close(); } catch {}
        (window as any).__warmContext = null;
        bc('🧪 SAS étape 0/4 : terminée');

        setStep(1); bc(`🧪 SAS étape 1/4: ${STEPS[1]}`);
        await paint();
        try { await (window as any).__previewCtx?.close(); } catch {}
        (window as any).__previewCtx = null;
        bc('🧪 SAS étape 1/4 : terminée');

        setStep(2); bc(`🧪 SAS étape 2/4: ${STEPS[2]} (blob=${props.vocalBlob?.size ?? 'NULL'}B)`);
        await paint();
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        bc(`🧪 SAS étape 2/4 : AudioContext créé, state=${ctx.state}`);
        const ab = await props.vocalBlob.arrayBuffer();
        bc(`🧪 SAS étape 2/4 : arrayBuffer lu (${ab.byteLength}B)`);
        const buf = await ctx.decodeAudioData(ab);
        bc(`🧪 SAS étape 2/4 : décodage réussi (${buf.duration.toFixed(1)}s)`);
        await ctx.close();
        bc('🧪 SAS étape 2/4 : terminée');

        setStep(3); bc(`🧪 SAS étape 3/4: ${STEPS[3]}`);
        await paint();
        // Analyse volume minimale, juste pour valider que ça ne plante pas ici
        let peak = 0;
        const ch = buf.getChannelData(0);
        for (let i = 0; i < ch.length; i += 1000) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
        bc(`🧪 SAS étape 3/4 : terminée (peak≈${peak.toFixed(3)})`);

        setStep(4); bc('🧪 SAS étape 4/4 : Prêt — passage à l\'écran Mastering complet');
        await paint();
        setReady(true);
      } catch (e: any) {
        bc(`💥 SAS crash à l'étape ${step} : ${e?.name || ''} ${e?.message || e}`);
        setError(`${e?.name || 'Erreur'} : ${e?.message || String(e)}`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (ready) {
    // Toutes les étapes ont réussi dans le rendu minimal → on passe la main
    // à l'écran complet, inchangé.
    return <MasteringEngine {...props} />;
  }

  // ── Rendu minimal volontaire : aucune icône, aucun dégradé ──────────────
  return (
    <div style={{ minHeight: '100vh', background: '#020202', color: '#fff', padding: '24px', fontFamily: 'monospace' }}>
      <p style={{ fontSize: 12, color: '#888', textTransform: 'uppercase', letterSpacing: 2 }}>
        Sas d'initialisation — {props.songTitle}
      </p>
      <div style={{ marginTop: 24 }}>
        {STEPS.map((label, i) => (
          <p key={i} style={{
            fontSize: 14,
            color: i < step ? '#4ade80' : i === step ? '#fb923c' : '#444',
            marginBottom: 8,
          }}>
            {i < step ? '[OK] ' : i === step ? '[EN COURS] ' : '[ ] '}{i + 1}/{STEPS.length} — {label}
          </p>
        ))}
      </div>
      {error && (
        <div style={{ marginTop: 24, padding: 16, border: '1px solid #dc2626', borderRadius: 8 }}>
          <p style={{ color: '#f87171', fontSize: 13, marginBottom: 8 }}>Erreur capturée à l'étape {step + 1} :</p>
          <p style={{ color: '#fca5a5', fontSize: 11, wordBreak: 'break-all' }}>{error}</p>
          <button
            onClick={props.onBack}
            style={{ marginTop: 16, padding: '10px 20px', background: '#dc2626', border: 'none', borderRadius: 8, color: '#fff', fontSize: 13 }}
          >
            ← Retour
          </button>
        </div>
      )}
      {step === -1 && !error && (
        <p style={{ marginTop: 24, fontSize: 12, color: '#666' }}>
          (Si tu vois ce texte figé sans qu'aucune étape ne passe au orange,
          le crash a eu lieu avant même ce premier rendu.)
        </p>
      )}
    </div>
  );
}
