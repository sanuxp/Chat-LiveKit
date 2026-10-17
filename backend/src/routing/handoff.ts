import { getHandoff, sendNotice, setHandoff, type HandoffState } from "../conversations.js";

/** The ONE place hand-off state changes: persists it and notifies the room. */
export async function updateHandoff(conversationId: string, update: Partial<HandoffState>): Promise<HandoffState> {
  const next = await setHandoff(conversationId, update);
  if (next.status !== "waiting") clearFallback(conversationId);
  return next;
}

// --- waiting -> fallback timeout -------------------------------------------------------------

const timers = new Map<string, NodeJS.Timeout>();

export function clearFallback(conversationId: string): void {
  const t = timers.get(conversationId);
  if (t) clearTimeout(t);
  timers.delete(conversationId);
}

/** If still `waiting` after `seconds`, tell the customer, return to the AI and leave it a note. */
export function armFallback(conversationId: string, seconds: number, fallbackTool: string | undefined): void {
  clearFallback(conversationId);
  const t = setTimeout(() => {
    timers.delete(conversationId);
    void (async () => {
      try {
        const h = await getHandoff(conversationId);
        if (h.status !== "waiting") return;
        await updateHandoff(conversationId, {
          status: "ai",
          channel: null,
          ai_note: fallbackTool
            ? `No human agent became available for this customer. Apologise briefly and offer the "${fallbackTool}" tool as an alternative. Ask for any details it needs (for example their email address) before calling it; do not call it without them.`
            : "No human agent became available for this customer. Apologise briefly and keep helping as best you can.",
        });
        await sendNotice(conversationId, "Sorry, nobody on our team is available right now.");
        console.log(JSON.stringify({ msg: "fallback fired", conversationId }));
      } catch (e: any) {
        console.log(JSON.stringify({ msg: "fallback error", conversationId, error: e?.message }));
      }
    })();
  }, Math.max(0, seconds) * 1000);
  t.unref?.();
  timers.set(conversationId, t);
}

