import { pool } from "../db/db.js";
import { agentDisplayName, getHandoff, sendNotice } from "../conversations.js";
import { agentIdentity, removeParticipant } from "../realtime/livekit.js";
import { closeExpired, isExpired } from "../session/expiry.js";
import { updateHandoff } from "./handoff.js";

export async function setPresence(username: string, online: boolean): Promise<void> {
  await pool.query("UPDATE agents SET online=$2, last_seen=now() WHERE username=$1", [username, online]);
}

export async function agentCanTakeMore(username: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT a.max_concurrent,
            (SELECT count(*) FROM conversations c WHERE c.assigned_agent=a.username AND c.status='assigned' AND c.deleted_at IS NULL) AS active
       FROM agents a WHERE a.username=$1`,
    [username],
  );
  return !!r.rows[0] && Number(r.rows[0].active) < r.rows[0].max_concurrent;
}

// Accepting goes through one lock and re-checks that the conversation is still 'waiting',
// so two agents clicking Accept at once can't both get it (or post the summary twice). Single backend instance assumed; use a DB advisory lock to scale out.
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

/** Mark the conversation assigned and announce the agent. The AI summary stays on the conversation (shown as a banner). Caller holds the lock. */
async function assignLocked(conversationId: string, agent: string): Promise<boolean> {
  const before = await getHandoff(conversationId);
  if (before.status !== "waiting") return false; // someone else already handled it
  await updateHandoff(conversationId, { status: "assigned", agent_id: agent });
  const name = await agentDisplayName(agent);
  await sendNotice(conversationId, `${name} from our team joined the chat.`);
  return true;
}

/** An agent takes a specific waiting conversation (respects max_concurrent). */
export function assignToAgent(conversationId: string, agent: string): Promise<"assigned" | "full" | "unavailable"> {
  return exclusive(async () => {
    if (!(await agentCanTakeMore(agent))) return "full";
    return (await assignLocked(conversationId, agent)) ? "assigned" : "unavailable";
  });
}

export async function resolveConversation(conversationId: string, agent: string, returnToAi: boolean): Promise<void> {
  if (returnToAi && (await isExpired(conversationId))) {
    // the 24 h session window ended while the customer was with a person: finish here instead of going back to the AI
    await updateHandoff(conversationId, { status: "ai", agent_id: null, channel: null, reason: null, summary: null, ai_note: null });
    await closeExpired(conversationId);
  } else if (returnToAi) {
    await updateHandoff(conversationId, { status: "ai", agent_id: null, channel: null, reason: null, summary: null, ai_note: null });
    await sendNotice(conversationId, "You're chatting with our AI assistant again.");
  } else {
    await updateHandoff(conversationId, { status: "closed", agent_id: null });
    await sendNotice(conversationId, "This conversation has ended.");
  }
  await removeParticipant(conversationId, agentIdentity(agent)); // also ends any call the agent is in
}

