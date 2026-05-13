/**
 * RecordingsList.tsx — Écran liste des enregistrements (screen: 'recordings')
 */
import React from 'react';
import { ChevronLeft, Mic } from 'lucide-react';
import { MobileRecording } from '../../services/StudioService';
import RecordingCard from './RecordingCard';

interface Props {
  recordings:  MobileRecording[];
  pendingCount: number;
  playingId:   string | null;
  uploading:   string | null;
  uploadDone:  string | null;
  isOnline:    boolean;
  playRef:     React.RefObject<HTMLAudioElement>;
  onBack:      () => void;
  onPlay:      (rec: MobileRecording) => void;
  onUpload:    (rec: MobileRecording) => void;
  onDelete:    (id: string) => void;
}

export default function RecordingsList({
  recordings, pendingCount, playingId, uploading, uploadDone, isOnline,
  playRef, onBack, onPlay, onUpload, onDelete,
}: Props) {
  return (
    <div className="min-h-screen bg-[#020202] text-white flex flex-col">

      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-5 pt-6 pb-4 border-b border-zinc-900">
        <button onClick={onBack} className="w-10 h-10 rounded-xl bg-zinc-900 flex items-center justify-center active:scale-90">
          <ChevronLeft size={20}/>
        </button>
        <div>
          <p className="font-bebas text-2xl text-white tracking-widest leading-none">ENREGISTREMENTS</p>
          <p className="text-[9px] text-zinc-600 font-black uppercase">
            {recordings.length} fichier{recordings.length > 1 ? 's' : ''} · {pendingCount} à transférer
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pt-4 pb-8 space-y-3">
        {recordings.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4 opacity-30">
            <Mic size={48} className="text-zinc-700"/>
            <p className="text-[12px] text-zinc-600 font-black uppercase">Aucun enregistrement</p>
          </div>
        ) : (
          recordings.slice().reverse().map(rec => (
            <RecordingCard
              key={rec.id}
              rec={rec}
              playingId={playingId}
              uploading={uploading}
              uploadDone={uploadDone}
              isOnline={isOnline}
              onPlay={onPlay}
              onUpload={onUpload}
              onDelete={onDelete}
            />
          ))
        )}
      </div>

      <audio ref={playRef} className="hidden"/>
    </div>
  );
}
