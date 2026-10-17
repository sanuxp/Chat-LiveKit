import { useCallback, useEffect, useState } from "react";
import { ConversationView } from "./ConversationView";
import { Login } from "./Login";
import { Queue, type ConversationRow } from "./Queue";
import { ApiError, api, loadSession, login, saveSession, type Session } from "./api";

const HEARTBEAT_MS = 30_000;
const QUEUE_POLL_MS = 4_000;

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession());
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  // conversations this agent declined: hidden from their Waiting list (still waiting for everyone else)
  const [declined, setDeclined] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(sessionStorage.getItem("supportchat.declined") ?? "[]")); } catch { return new Set(); }
  });
  const decline = (id: string) => {
    setDeclined((d) => {
      const next = new Set(d).add(id);
      try { sessionStorage.setItem("supportchat.declined", JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
    setOpen(null);
    void refresh();
  };

  const token = session?.token ?? "";

  const signOut = useCallback(async (message?: string) => {
    if (token) await api(token, "POST", "/api/agent/presence", { online: false }).catch(() => {});
    saveSession(null);
    setOnline(false); setOpen(null); setRows([]); setSession(null);
    setError(message ?? null);
  }, [token]);

  const refresh = useCallback(async () => {
    if (!token) return;
    try { setRows((await api<{ conversations: ConversationRow[] }>(token, "GET", "/api/agent/conversations")).conversations); }
    catch (e) {
      if (e instanceof ApiError && e.status === 401) void signOut("Session expired, please sign in again.");
      else setError((e as Error).message);
    }
  }, [token, signOut]);

  // the queue is polled; assignments made by the AI show up within a few seconds
  useEffect(() => {
    if (!token) return;
    void refresh();
    const t = setInterval(refresh, QUEUE_POLL_MS);
    return () => clearInterval(t);
  }, [token, refresh]);

  // show how many conversations are waiting in the tab title
  const waitingCount = rows.filter((r) => r.status === "waiting" && !declined.has(r.id)).length;
  useEffect(() => {
    document.title = waitingCount > 0 ? `(${waitingCount}) Support - Agent console` : "Support - Agent console";
  }, [waitingCount]);

  // presence heartbeat (backend treats a stale heartbeat as offline)
  useEffect(() => {
    if (!token || !online) return;
    const beat = () => api(token, "POST", "/api/agent/presence", { online: true }).catch(() => {});
    void beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [token, online]);

  const toggleOnline = async () => {
    const next = !online;
    setOnline(next);
    if (!next) await api(token, "POST", "/api/agent/presence", { online: false }).catch(() => {});
  };

  if (!session) {
    return (
      <Login
        error={error}
        onLogin={async (u, p) => {
          setError(null);
          try { setSession(await login(u, p)); } catch { setError("Sign-in failed. Check your username and password."); }
        }}
      />
    );
  }

  return (
    <div className="app">
      <header className="top">
        <strong>Agent console</strong>
        <span className="muted">{session.displayName}</span>
        <div className="spacer" />
        <button className={online ? "online" : "secondary"} onClick={toggleOnline}>
          <span className={`dot ${online ? "on" : ""}`} /> {online ? "Online" : "Offline"}
        </button>
        <button className="secondary" onClick={() => void signOut()}>Sign out</button>
      </header>
      {error && <p className="error banner" onClick={() => setError(null)}>{error}</p>}
      <main>
        {open ? (
          <ConversationView token={token} conversationId={open} online={online} onDecline={() => decline(open)} onClose={() => { setOpen(null); void refresh(); }} />
        ) : (
          <Queue rows={rows} declined={declined} canTake={online} onOpen={(id) => setOpen(id)} />
        )}
      </main>
    </div>
  );
}
