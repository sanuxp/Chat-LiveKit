import { randomUUID } from "node:crypto";
import { addMessage } from "../conversations.js";
import { publish } from "../realtime/livekit.js";

/**
 * Streams an AI answer to the room: partial text goes out as "stream" events (at most one per `intervalMs`,
 * keyed by a message id) and finish() stores the final text and publishes it as a normal "message" with the
 * same id, which replaces the partial one on the clients.
 */
export class StreamingMessage {
  private readonly id = randomUUID();
  private text = "";
  private lastSent = "";
  private lastAt = 0;
  private timer?: NodeJS.Timeout;
  private n = 0;
  private chain: Promise<void> = Promise.resolve(); // keeps partial updates in order

  constructor(private conversationId: string, private intervalMs: number) {}

  append(delta: string): void {
    this.text += delta;
    if (this.timer) return;
    const wait = Math.max(0, this.lastAt + this.intervalMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, wait);
  }

  private flush(): void {
    if (!this.text || this.text === this.lastSent) return;
    const body = this.text, n = ++this.n;
    this.lastSent = body;
    this.lastAt = Date.now();
    this.chain = this.chain.then(() => publish(this.conversationId, { t: "stream", id: this.id, body, n }));
  }

  async finish(): Promise<string> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.chain; // the final message must come after every partial one
    if (this.text) await addMessage(this.conversationId, { id: this.id, role: "ai", body: this.text });
    return this.text;
  }
}
