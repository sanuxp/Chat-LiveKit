import type { Track } from "livekit-client";
import { useEffect, useRef } from "react";

export function TrackVideo({ track, muted, className, label }: { track: Track; muted?: boolean; className?: string; label?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => { track.detach(el); };
  }, [track]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} aria-label={label} />;
}
