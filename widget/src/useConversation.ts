import { ConnectionState, Room, RoomEvent, Track, type RemoteTrack, type Track as LKTrack } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";

// NOTE: widget/src/useConversation.ts and agent-ui/src/useConversation.ts are identical copies. Keep them in sync.

export interface Line {
  id: string;
  role: "customer" | "ai" | "agent" | "system";
  name: string | null;
  kind: "text" | "notice";
  internal: boolean;
  body: string;
  at: string;
  streaming?: boolean;
}

type ChatEvent =
  | { t: "message"; message: Omit<Line, "streaming"> }
  | { t: "stream"; id: string; body: string; n: number }
  | { t: "typing"; on: boolean }
  | { t: "state"; status: string; agent: string | null };

export interface ConversationOptions {
  backendUrl: string;
  backendToken: string;
  conversationId: string;
  livekitUrl: string;
  livekitToken: string;
  /** Open the LiveKit room for calls and allow mic/camera. Chat itself needs only the room's data channel. */
  calls?: { voice: boolean; video: boolean; aiVoice?: boolean };
}

export function useConversation(o: ConversationOptions) {
  const [messages, setMessages] = useState<Map<string, Line>>(new Map());
  const [streams, setStreams] = useState<Map<string, { body: string; n: number }>>(new Map());
  const [typing, setTyping] = useState(false);
  const [status, setStatus] = useState("ai");
  const [agent, setAgent] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [remoteVideo, setRemoteVideo] = useState<LKTrack | null>(null);
  const [localVideo, setLocalVideo] = useState<LKTrack | null>(null);
  const [assistantOn, setAssistantOn] = useState(false); // the AI voice worker is in the room
  const roomRef = useRef<Room | null>(null);
  const authHeaders = { Authorization: `Bearer ${o.backendToken}`, "Content-Type": "application/json" };

  const loadHistory = useCallback(async () => {
    const res = await fetch(`${o.backendUrl}/api/conversations/${o.conversationId}`, { headers: authHeaders });
    if (!res.ok) throw new Error(`history failed (${res.status})`);
    const d = (await res.json()) as { status: string; agent: string | null; messages: Line[] };
    setStatus(d.status);
    setAgent(d.agent);
    setMessages((prev) => {
      const next = new Map(prev);
      for (const m of d.messages) next.set(m.id, m);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.backendUrl, o.backendToken, o.conversationId]);

  useEffect(() => {
    let cancelled = false;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;
    const audioEls = new Set<HTMLElement>();

    const onData = (payload: Uint8Array, participant: unknown, _kind: unknown, topic?: string) => {
      if (topic !== "chat" || participant) return; // only the server (no participant) may publish chat events
      let ev: ChatEvent;
      try { ev = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
      if (ev.t === "message") {
        setMessages((p) => new Map(p).set(ev.message.id, ev.message as Line));
        setStreams((p) => { if (!p.has(ev.message.id)) return p; const n = new Map(p); n.delete(ev.message.id); return n; });
      } else if (ev.t === "stream") {
        setStreams((p) => ((p.get(ev.id)?.n ?? 0) >= ev.n ? p : new Map(p).set(ev.id, { body: ev.body, n: ev.n })));
      } else if (ev.t === "typing") {
        setTyping(ev.on);
      } else if (ev.t === "state") {
        setStatus(ev.status);
        setAgent(ev.agent);
      }
    };

    const onSubscribed = (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach();
        el.style.display = "none";
        document.body.appendChild(el);
        audioEls.add(el);
      } else if (track.kind === Track.Kind.Video) {
        setRemoteVideo(track);
      }
    };
    const onUnsubscribed = (track: RemoteTrack) => {
      track.detach().forEach((el) => { el.remove(); audioEls.delete(el); });
      if (track.kind === Track.Kind.Video) setRemoteVideo(null);
    };

    room
      .on(RoomEvent.DataReceived, onData)
      .on(RoomEvent.ParticipantConnected, (p) => { if (p.isAgent) setAssistantOn(true); })
      .on(RoomEvent.ParticipantDisconnected, (p) => { if (p.isAgent) setAssistantOn(false); })
      .on(RoomEvent.TrackSubscribed, onSubscribed)
      .on(RoomEvent.TrackUnsubscribed, onUnsubscribed)
      .on(RoomEvent.LocalTrackPublished, (pub) => {
        if (pub.source === Track.Source.Camera) setLocalVideo(pub.track ?? null);
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.source === Track.Source.Camera) setLocalVideo(null);
      })
      .on(RoomEvent.ConnectionStateChanged, (s) => {
        setConnected(s === ConnectionState.Connected);
        // events sent while we were disconnected are only in the stored history
        if (s === ConnectionState.Connected) void loadHistory().catch(() => {});
      })
      .on(RoomEvent.Disconnected, () => { setMicOn(false); setCamOn(false); });

    (async () => {
      try {
        // connect first so no event is missed, then load history and merge by id
        await room.connect(o.livekitUrl, o.livekitToken);
        if (cancelled) return;
        setAssistantOn([...room.remoteParticipants.values()].some((p) => p.isAgent));
        await loadHistory();
      } catch {
        if (!cancelled) setError("Could not connect. Please try again.");
      }
    })();

    return () => {
      cancelled = true;
      audioEls.forEach((el) => el.remove());
      void room.disconnect();
      roomRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.livekitUrl, o.livekitToken, o.conversationId]);

  const send = useCallback(async (body: string) => {
    const res = await fetch(`${o.backendUrl}/api/conversations/${o.conversationId}/messages`, {
      method: "POST", headers: authHeaders, body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`send failed (${res.status})`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.backendUrl, o.backendToken, o.conversationId]);

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room || !o.calls?.voice) return;
    try {
      // while the AI is handling the chat, turning the mic on asks the backend to bring the voice assistant into the room
      if (!micOn && o.calls.aiVoice && status === "ai") {
        await fetch(`${o.backendUrl}/api/conversations/${o.conversationId}/voice/start`, { method: "POST", headers: authHeaders }).catch(() => {});
      }
      await room.localParticipant.setMicrophoneEnabled(!micOn); setMicOn(!micOn);
    }
    catch { setError("Could not access the microphone."); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micOn, status, o.calls?.voice, o.calls?.aiVoice, o.backendUrl, o.backendToken, o.conversationId]);

  const toggleCam = useCallback(async () => {
    const room = roomRef.current;
    if (!room || !o.calls?.video) return;
    try { await room.localParticipant.setCameraEnabled(!camOn); setCamOn(!camOn); }
    catch { setError("Could not access the camera."); }
  }, [camOn, o.calls?.video]);

  // the voice worker can miss the first request while it warms a new process: ask again (the backend never starts two)
  useEffect(() => {
    if (!micOn || !o.calls?.aiVoice || status !== "ai" || assistantOn) return;
    let tries = 0;
    const t = setInterval(() => {
      if (++tries > 4) return clearInterval(t);
      void fetch(`${o.backendUrl}/api/conversations/${o.conversationId}/voice/start`, { method: "POST", headers: { Authorization: `Bearer ${o.backendToken}` } }).catch(() => {});
    }, 22_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micOn, status, assistantOn, o.calls?.aiVoice, o.backendUrl, o.backendToken, o.conversationId]);

  // history + live partial answers, oldest first
  const lines: Line[] = [...messages.values()];
  for (const [id, { body }] of streams) {
    if (!messages.has(id)) lines.push({ id, role: "ai", name: null, kind: "text", internal: false, body, at: new Date().toISOString(), streaming: true });
  }
  lines.sort((a, b) => (a.streaming ? 1 : 0) - (b.streaming ? 1 : 0) || a.at.localeCompare(b.at));

  return { lines, typing, status, agent, connected, error, setError, send, micOn, camOn, toggleMic, toggleCam, remoteVideo, localVideo, assistantOn };
}
