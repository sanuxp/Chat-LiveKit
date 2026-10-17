import { useState } from "react";

export interface CustomerInfo { name: string; email: string; phone: string; metadata: Record<string, string | number | boolean> }

export interface ConversationRow {
  id: string;
  status: "waiting" | "assigned" | string;
  assignedAgent: string | null;
  reason: string | null;
  summary: string | null;
  updatedAt: string;
  customer?: CustomerInfo;
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function Row({ c, onOpen, label }: { c: ConversationRow; onOpen: () => void; label: string }) {
  return (
    <li className="row" onClick={onOpen}>
      <div className="row-main">
        <strong>{c.customer?.name ?? "Customer"}</strong>
        <span className="muted"> · {c.reason || "Conversation"} · {ago(c.updatedAt)}</span>
        {c.summary && <p className="summary">{c.summary}</p>}
      </div>
      <button onClick={(e) => { e.stopPropagation(); onOpen(); }}>{label}</button>
    </li>
  );
}

export function Queue({ rows, onOpen, canTake, declined }: { rows: ConversationRow[]; onOpen: (id: string) => void; canTake: boolean; declined: Set<string> }) {
  const [showDeclined, setShowDeclined] = useState(false);
  const allWaiting = rows.filter((r) => r.status === "waiting");
  const hidden = allWaiting.filter((r) => declined.has(r.id)).length;
  const waiting = showDeclined ? allWaiting : allWaiting.filter((r) => !declined.has(r.id));
  const mine = rows.filter((r) => r.status === "assigned");
  return (
    <div className="queue">
      <section>
        <h2>My conversations <span className="count">{mine.length}</span></h2>
        {mine.length === 0 && <p className="muted">Nothing assigned to you.</p>}
        <ul>{mine.map((c) => <Row key={c.id} c={c} onOpen={() => onOpen(c.id)} label="Open" />)}</ul>
      </section>
      <section>
        <h2>Waiting <span className="count">{waiting.length}</span></h2>
        {waiting.length === 0 && <p className="muted">{hidden > 0 ? "Nothing new waiting." : "The queue is empty."}</p>}
        {!canTake && waiting.length > 0 && <p className="muted">Go online to accept conversations.</p>}
        <ul>{waiting.map((c) => <Row key={c.id} c={c} onOpen={() => onOpen(c.id)} label="Review" />)}</ul>
        {hidden > 0 && (
          <p className="muted">
            {hidden} declined by you.{" "}
            <button className="secondary" onClick={() => setShowDeclined((v) => !v)}>{showDeclined ? "Hide" : "Show"}</button>
          </p>
        )}
      </section>
    </div>
  );
}
