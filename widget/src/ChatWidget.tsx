import { useCallback, useEffect, useRef, useState } from "react";
import { createSession, deleteConversation, type CustomerInfo, type CustomerMetadata, type Session } from "./api";
import { identityKey } from "./identity";
import { CameraIcon, ChatIcon, CloseIcon, MicIcon, SendIcon, TrashIcon } from "./icons";
import { TrackVideo } from "./TrackVideo";
import { Typewriter } from "./Typewriter";
import { useConversation } from "./useConversation";

export interface WidgetOptions {
  backendUrl: string;
  authToken?: string | null; // host-app JWT (CUSTOMER_AUTH_MODE=external_jwt)
  title?: string;
  user?: CustomerInfo; // { name, email, phone } of the logged-in person; backend defaults apply to anything missing
  metadata?: CustomerMetadata; // free-form facts for the AI/agents, e.g. { plan: "pro", orderCount: 3 }
  customHeaders?: Record<string, string>; // extra headers sent with the session request
  /** Show the mic / camera buttons. Also needs ENABLE_VOICE / ENABLE_VIDEO on the backend. Default: both on. */
  calls?: { voice?: boolean; video?: boolean };
  /** "auto" follows the visitor's OS setting. Default: "auto". */
  theme?: "light" | "dark" | "auto";
}

function useDark(theme: WidgetOptions["theme"]): boolean {
  const query = "(prefers-color-scheme: dark)";
  const [auto, setAuto] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setAuto(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return theme === "dark" || ((theme ?? "auto") === "auto" && auto);
}

export function ChatWidget({ opts }: { opts: WidgetOptions }) {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const connecting = useRef(false);
  const generation = useRef(0); // bumped when the user changes, so a late response for the old user is ignored
  const dark = useDark(opts.theme);

  const start = useCallback(async () => {
    if (connecting.current) return;
    connecting.current = true;
    const mine = generation.current;
    setError(null);
    try {
      const next = await createSession(opts.backendUrl, opts.authToken ?? null, { user: opts.user, metadata: opts.metadata, customHeaders: opts.customHeaders });
      if (mine === generation.current) setSession(next);
    } catch {
      if (mine === generation.current) setError("Could not connect to support. Please try again.");
    } finally {
      if (mine === generation.current) connecting.current = false;
    }
  }, [opts]);

  // another user logged in (or the user logged out): forget the current chat completely, then connect for the new user
  const who = identityKey(opts);
  const previousWho = useRef(who);
  useEffect(() => {
    if (previousWho.current === who) return;
    previousWho.current = who;
    generation.current += 1;
    connecting.current = false;
    setSession(null);
    setError(null);
    setConfirmDelete(false);
  }, [who]);

  // connect lazily on first open
  useEffect(() => { if (open) setEverOpened(true); }, [open]);
  useEffect(() => { if (everOpened && !session && !error) void start(); }, [everOpened, session, error, start]);

  const restart = async () => { setSession(null); await start(); };

  const doDelete = async () => {
    if (!session) return;
    setConfirmDelete(false);
    try { await deleteConversation(opts.backendUrl, session); await restart(); }
    catch { setError("Could not delete the conversation."); }
  };

  return (
    <div className={`sc-root ${dark ? "sc-dark" : ""}`}>
      <button
        className="sc-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close support chat" : "Open support chat"}
        aria-expanded={open}
      >
        {open ? <CloseIcon key="x" /> : <ChatIcon key="chat" />}
      </button>

      {/* stays mounted once opened (just hidden), so the chat keeps receiving while minimised */}
      <div className={`sc-popup ${open ? "sc-open" : ""}`} inert={!open} role="dialog" aria-label="Support chat">
        <div className="sc-card">
          <div className="sc-header">
            <span className="sc-title">{opts.title ?? "Support"}</span>
            {session && (
              <button className="sc-bin" onClick={() => setConfirmDelete(true)} aria-label="Delete conversation" title="Delete conversation">
                <TrashIcon />
              </button>
            )}
          </div>
          {confirmDelete && (
            <div className="sc-confirm">
              Delete this conversation permanently?
              <div>
                <button className="sc-danger" onClick={doDelete}>Delete</button>
                <button className="sc-cancel" onClick={() => setConfirmDelete(false)}>Cancel</button>
              </div>
            </div>
          )}
          {!session && (
            <div className="sc-transcript">
              <div className="sc-list">
                {error ? <div className="sc-hint sc-error">{error}</div> : <div className="sc-hint">Connecting…</div>}
                {error && <button className="sc-primary sc-retry" style={{ width: "auto", padding: "0 16px" }} onClick={() => void start()}>Try again</button>}
              </div>
            </div>
          )}
          {session && <Conversation key={session.conversationId} session={session} opts={opts} visible={open} onRestart={restart} />}
        </div>
      </div>
    </div>
  );
}

function Conversation({ session, opts, visible, onRestart }: { session: Session; opts: WidgetOptions; visible: boolean; onRestart: () => void }) {
  const calls = {
    voice: session.features.voice && opts.calls?.voice !== false,
    video: session.features.video && opts.calls?.video !== false,
  };
  const c = useConversation({
    backendUrl: opts.backendUrl,
    backendToken: session.backendToken,
    conversationId: session.conversationId,
    livekitUrl: session.livekitUrl,
    livekitToken: session.livekitToken,
    calls,
  });
  const [text, setText] = useState("");
  const [sendError, setSendError] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // follow new content (and the typewriter growing the last message) but don't fight a user who scrolled up
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const stick = () => { el.scrollTop = el.scrollHeight; };
    stick();
    const ro = new ResizeObserver(stick);
    ro.observe(el.firstElementChild ?? el);
    return () => ro.disconnect();
  }, [visible]);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [c.lines, c.typing]);

  // minimising the widget ends the user's own call
  useEffect(() => {
    if (!visible) {
      if (c.micOn) void c.toggleMic();
      if (c.camOn) void c.toggleCam();
    } else {
      inputRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    setSendError(false);
    try { await c.send(body); } catch { setSendError(true); }
  };

  const ended = c.status === "closed";
  const hasStream = c.lines.some((l) => l.streaming);
  const showCalls = calls.voice || calls.video;

  return (
    <>
      {c.remoteVideo ? (
        <div className="sc-video">
          <TrackVideo track={c.remoteVideo} className="sc-remote" />
          {c.localVideo && <TrackVideo track={c.localVideo} muted className="sc-local" />}
        </div>
      ) : c.localVideo ? (
        <TrackVideo track={c.localVideo} muted className="sc-local sc-local-only" />
      ) : null}

      <div className="sc-transcript" ref={listRef}>
        <div className="sc-list">
          {!c.connected && !c.error && <div className="sc-hint">Connecting…</div>}
          {(c.error || sendError) && <div className="sc-hint sc-error">{c.error ?? "Message failed to send."}</div>}
          {c.lines.length === 0 && c.connected && <div className="sc-hint">Hi! Ask us anything.</div>}
          {c.lines.map((l) => {
            if (l.kind === "notice") return <div key={l.id} className="sc-notice">{l.body}</div>;
            const cls = l.role === "customer" ? "sc-own" : l.role === "agent" ? "sc-other sc-human" : "sc-other";
            return (
              <div key={l.id} className={`sc-line ${cls}`}>
                {l.role === "agent" && l.name && <span className="sc-name">{l.name}</span>}
                <div className="sc-text">
                  {l.role === "ai" ? <Typewriter text={l.body} live={!!l.streaming} /> : l.body}
                </div>
              </div>
            );
          })}
          {c.typing && !hasStream && <div className="sc-typing" aria-live="polite" aria-label="typing"><i /><i /><i /></div>}
          {c.status === "waiting" && <div className="sc-hint">Waiting for a team member to join…</div>}
          {ended && <div className="sc-hint">This conversation has ended.</div>}
        </div>
      </div>

      <div className="sc-bar">
        {ended ? (
          <button className="sc-primary" onClick={onRestart}>Start a new conversation</button>
        ) : (
          <>
            <form className="sc-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <input
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Type something..."
                disabled={!c.connected}
                aria-label="Message"
                autoComplete="off"
              />
              <button type="submit" className="sc-send" aria-label="Send" disabled={!c.connected || !text.trim()}><SendIcon /></button>
            </form>
            {showCalls && (
              <>
                <hr className="sc-hr" />
                <div className="sc-controls">
                  {calls.voice && (
                    <button type="button" className={`sc-toggle ${c.micOn ? "" : "sc-off"}`} onClick={() => void c.toggleMic()}
                      aria-label={c.micOn ? "Mute microphone" : "Turn on microphone"} aria-pressed={c.micOn} disabled={!c.connected}>
                      <MicIcon off={!c.micOn} />
                    </button>
                  )}
                  {calls.video && (
                    <button type="button" className={`sc-toggle ${c.camOn ? "" : "sc-off"}`} onClick={() => void c.toggleCam()}
                      aria-label={c.camOn ? "Turn off camera" : "Turn on camera"} aria-pressed={c.camOn} disabled={!c.connected}>
                      <CameraIcon off={!c.camOn} />
                    </button>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
