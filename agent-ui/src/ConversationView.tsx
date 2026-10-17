import { useEffect, useRef, useState } from "react";
import type { CustomerInfo } from "./Queue";
import { TrackVideo } from "./TrackVideo";
import { BACKEND_URL, api } from "./api";
import { useConversation, type Line } from "./useConversation";

interface Preview {
  status: string;
  mine: boolean;
  reason: string | null;
  summary: string | null;
  customer: CustomerInfo;
  messages: Line[];
}

interface Join {
  customer: CustomerInfo;
  reason: string | null;
  summary: string | null;
  livekitUrl: string;
  livekitToken: string;
  features: { voice: boolean; video: boolean };
}

const PREVIEW_POLL_MS = 3000;

/**
 * Opening a waiting conversation only *previews* it (AI summary + the whole transcript, read-only).
 * It is assigned to the agent, and the agent joins its LiveKit room, only when they press Accept.
 */
export function ConversationView({ token, conversationId, online, onClose, onDecline }: { token: string; conversationId: string; online: boolean; onClose: () => void; onDecline: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [join, setJoin] = useState<Join | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const acceptingRef = useRef(false);

  const accept = async () => {
    if (acceptingRef.current) return;
    acceptingRef.current = true;
    setAccepting(true);
    setError(null);
    try { setJoin(await api<Join>(token, "POST", `/api/agent/conversations/${conversationId}/accept`)); }
    catch (e: any) { setError(e.message ?? "Could not accept the conversation"); }
    finally { acceptingRef.current = false; setAccepting(false); }
  };

  // load the preview and keep it fresh while it is still waiting (new customer messages, taken by someone else, ...)
  useEffect(() => {
    if (join) return;
    let cancelled = false;
    const load = async () => {
      try {
        const p = await api<Preview>(token, "GET", `/api/agent/conversations/${conversationId}`);
        if (cancelled) return;
        setPreview(p);
        if (p.mine) void accept(); // already assigned to me (e.g. reopened from "My conversations")
      } catch (e: any) {
        if (!cancelled) setGone(e.message ?? "This conversation is no longer available.");
      }
    };
    void load();
    const t = setInterval(load, PREVIEW_POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, conversationId, join]);

  if (join) return <Room token={token} conversationId={conversationId} join={join} onClose={onClose} />;

  if (gone) {
    return (
      <div className="conv">
        <header><button className="secondary" onClick={onClose}>← Back</button></header>
        <p className="error" style={{ padding: 14 }}>{gone}</p>
      </div>
    );
  }
  if (!preview) return <p className="muted">Loading…</p>;

  return (
    <div className="conv">
      <header>
        <button className="secondary" onClick={onClose}>← Back</button>
        <div className="spacer" />
        <button className="secondary" onClick={onDecline} disabled={accepting} title="Leave it in the queue for another agent">
          Decline
        </button>
        <button onClick={accept} disabled={accepting || !online} title={online ? undefined : "Go online to accept conversations"}>
          {accepting ? "Accepting…" : "Accept conversation"}
        </button>
      </header>
      <CustomerCard customer={preview.customer} />
      <SummaryBanner summary={preview.summary} reason={preview.reason} />
      {error && <p className="error" style={{ padding: "0 14px" }}>{error}</p>}
      <div className="conv-body">
        <div className="conv-chat">
          <Timeline lines={preview.messages} />
          <div className="preview-note">
            {online ? "Read-only preview. Press Accept to take this conversation and reply, or Decline to leave it for another agent." : "Go online (top right) to accept this conversation."}
          </div>
        </div>
      </div>
    </div>
  );
}

function CustomerCard({ customer }: { customer: CustomerInfo }) {
  return (
    <div className="customer-card">
      <strong>{customer.name}</strong>
      <a href={`mailto:${customer.email}`}>{customer.email}</a>
      <a href={`tel:${customer.phone}`}>{customer.phone}</a>
      {Object.entries(customer.metadata).map(([k, v]) => (
        <span key={k} className="chip">{k}: {String(v)}</span>
      ))}
    </div>
  );
}

function SummaryBanner({ summary, reason }: { summary: string | null; reason: string | null }) {
  if (!summary && !reason) return null;
  return (
    <div className="summary-banner" role="note">
      <div className="summary-title">AI summary</div>
      {summary && <div>{summary}</div>}
      {reason && <div className="summary-reason">Reason for escalation: {reason}</div>}
    </div>
  );
}

function Timeline({ lines, typing, ended, listRef }: { lines: Line[]; typing?: boolean; ended?: string | null; listRef?: React.RefObject<HTMLDivElement | null> }) {
  const own = useRef<HTMLDivElement>(null);
  const ref = listRef ?? own;
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [lines, typing, ref]);
  return (
    <div className="timeline" ref={ref}>
      {lines.map((l) => {
        const who = l.internal ? "summary" : l.kind === "notice" ? "notice" : l.role === "agent" ? "me" : l.role === "customer" ? "customer" : "ai";
        const name = l.internal ? "AI summary" : l.role === "agent" ? "You" : l.role === "customer" ? "Customer" : l.role === "ai" ? "AI assistant" : "System";
        return (
          <div key={l.id} className={`msg ${who}`}>
            <div className="who">{name}</div>
            <div className="body">{l.body}</div>
          </div>
        );
      })}
      {typing && <p className="muted">AI is typing…</p>}
      {ended && <p className="muted center">{ended}</p>}
    </div>
  );
}

function Room({ token, conversationId, join, onClose }: { token: string; conversationId: string; join: Join; onClose: () => void }) {
  const c = useConversation({
    backendUrl: BACKEND_URL,
    backendToken: token,
    conversationId,
    livekitUrl: join.livekitUrl,
    livekitToken: join.livekitToken,
    calls: join.features,
  });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    try { await c.send(body); } catch { setActionError("Message failed to send"); }
  };

  const resolve = async (returnToAi: boolean) => {
    setBusy(true);
    try {
      await api(token, "POST", `/api/agent/conversations/${conversationId}/resolve`, { returnToAi });
      onClose();
    } catch (e: any) { setActionError(e.message); } finally { setBusy(false); }
  };

  // after resolving (or if the customer ended it) the state is no longer "assigned"
  const ended = c.status !== "assigned";
  const showCall = join.features.voice || join.features.video;
  const endedText = c.status === "deleted" ? "The customer ended and deleted this conversation."
    : c.status === "closed" ? "This conversation has ended."
    : ended && !c.connected ? "The conversation is no longer available."
    : ended ? "You are no longer assigned to this conversation." : null;

  return (
    <div className="conv">
      <header>
        <button className="secondary" onClick={onClose}>← Back</button>
        <div className="spacer" />
        {join.features.voice && (
          <button className={c.micOn ? "online" : "secondary"} onClick={() => void c.toggleMic()} disabled={!c.connected || ended}>
            🎤 {c.micOn ? "Mute" : "Voice"}
          </button>
        )}
        {join.features.video && (
          <button className={c.camOn ? "online" : "secondary"} onClick={() => void c.toggleCam()} disabled={!c.connected || ended}>
            📷 {c.camOn ? "Stop video" : "Video"}
          </button>
        )}
        <button disabled={busy || ended} onClick={() => resolve(true)}>Resolve → back to AI</button>
        <button className="secondary" disabled={busy || ended} onClick={() => resolve(false)}>Resolve &amp; close</button>
      </header>
      <CustomerCard customer={join.customer} />
      <SummaryBanner summary={join.summary} reason={join.reason} />
      {ended && c.status === "deleted" && (
        <div className="ended-banner">The customer ended this conversation. <button onClick={onClose}>Back to queue</button></div>
      )}
      {(c.error || actionError) && <p className="error">{c.error ?? actionError}</p>}
      <div className="conv-body">
        <div className="conv-chat">
          <Timeline lines={c.lines} typing={c.typing} ended={endedText} />
          <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply to the customer…" disabled={!c.connected || ended} />
            <button type="submit" disabled={!c.connected || ended || !text.trim()}>Send</button>
          </form>
        </div>
        {showCall && (c.remoteVideo || c.localVideo) && (
          <aside className="call">
            {c.remoteVideo && <TrackVideo track={c.remoteVideo} />}
            {c.localVideo && <TrackVideo track={c.localVideo} muted className="self" />}
          </aside>
        )}
      </div>
    </div>
  );
}
