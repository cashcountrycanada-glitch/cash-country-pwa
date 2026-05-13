/**
 * RecordingCard.tsx — Carte d'un enregistrement (play, upload, delete)
 */
import React from 'react';
import { Play, Pause, Trash2, Send, Loader2, CheckCircle2, Mic } from 'lucide-react';
import { MobileRecording } from '../../services/StudioService';
import { TRACK_PRESETS, formatTime, formatDate } from './studio.types';

interface Props {
  rec:        MobileRecording;
  playingId:  string | null;
  uploading:  string | null;
  uploadDone: string | null;
  isOnline:   boolean;
  onPlay:     (rec: MobileRecording) => void;
  onUpload:   (rec: MobileRecording) => void;
  onDelete:   (id: string) => void;
}

export default function RecordingCard({
  rec, playingId, uploading, uploadDone, isOnline, onPlay, onUpload, onDelete,
}: Props) {
  const isPlaying    = playingId === rec.id;
  const isUploading  = uploading === rec.id;
  const isDone       = uploadDone === rec.id;
  const presetColor  = TRACK_PRESETS[rec.trackIndex ?? 0]?.color || '#888';

  return (
    <div className={`bg-zinc-900/60 border rounded-2xl overflow-hidden ${rec.transferred ? 'border-emerald-900/40' : 'border-zinc-800'}`}>

      {/* Infos */}
      <div className="flex items-center gap-3 p-4">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${rec.transferred ? 'bg-emerald-900/30' : 'bg-red-900/20'}`}>
          {rec.transferred
            ? <CheckCircle2 size={18} className="text-emerald-500"/>
            : <Mic          size={18} className="text-red-500"/>}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[14px] font-black text-white truncate">{rec.songTitle}</p>
          {rec.trackLabel && (
            <p className="text-[10px] font-black mt-0.5" style={{ color: presetColor }}>
              {rec.trackLabel}
            </p>
          )}
          <p className="text-[10px] text-zinc-500 mt-0.5">
            {formatDate(rec.recordedAt)} · {formatTime(rec.duration)}
          </p>
          {rec.transferred && (
            <p className="text-[10px] text-emerald-500 font-black uppercase mt-0.5">✓ Transféré</p>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex border-t border-zinc-800">
        {/* Écouter */}
        <button
          onClick={() => onPlay(rec)}
          className="flex-1 py-3 flex items-center justify-center gap-2 text-[11px] font-black uppercase text-zinc-400 hover:text-white active:bg-zinc-800">
          {isPlaying ? <><Pause size={13}/> Pause</> : <><Play size={13}/> Écouter</>}
        </button>

        {/* Upload */}
        {!rec.transferred && isOnline && (
          <button
            onClick={() => onUpload(rec)}
            disabled={isUploading}
            className="flex-1 py-3 flex items-center justify-center gap-2 text-[11px] font-black uppercase text-red-400 hover:text-red-300 active:bg-zinc-800 border-l border-zinc-800 disabled:opacity-50">
            {isUploading
              ? <><Loader2 size={13} className="animate-spin"/> Envoi</>
              : isDone
              ? <><CheckCircle2 size={13} className="text-emerald-400"/> Envoyé!</>
              : <><Send size={13}/> Envoyer au Mac</>}
          </button>
        )}

        {rec.transferred && (
          <div className="flex-1 py-3 flex items-center justify-center gap-2 text-[11px] font-black text-emerald-600 border-l border-zinc-800">
            <CheckCircle2 size={13}/> Transféré
          </div>
        )}

        {/* Supprimer */}
        <button
          onClick={() => onDelete(rec.id)}
          className="w-12 py-3 flex items-center justify-center text-zinc-700 hover:text-red-500 active:bg-zinc-800 border-l border-zinc-800">
          <Trash2 size={14}/>
        </button>
      </div>
    </div>
  );
}
