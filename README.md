# Support Chat on LiveKit

Same product as the Matrix-based `Chat` project (embeddable widget -> AI answers first -> escalates to a human agent in the *same* conversation, host page can pass the customer's name/email/phone/metadata, tools and prompts editable without code), but the realtime layer is **LiveKit** instead of Matrix/Synapse. That makes **voice and video** a switch away: a conversation is a LiveKit room, and mic/camera tracks are just more participants publishing into it.

```
Customer widget ─┐                         ┌─ OpenAI-compatible LLM (LiteLLM, ...)
 (Shadow DOM)    ├─ Caddy :8080 ─ LiveKit  │
Agent console ───┘        └──── Backend ───┼─ Postgres (customers, conversations, messages, agents)
                              (REST + AI + │
                               routing)    ├─ SMTP (Mailpit / Gmail / ...)
                                           └─ your webhooks
```

| Folder                                           | What                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `backend/`                                     | Node 22 service: REST API, AI agent + tool loop, hand-off routing, LiveKit token minting                           |
| `backend/config/`                              | **Edit these, no code changes:** `tools.yaml`, `prompts/*.md` (unchanged format from the Matrix project) |
| `widget/`                                      | Embeddable customer widget -> `widget.js` (chat now; mic/camera buttons when enabled)                            |
| `agent-ui/`                                    | React console for human agents (served at `/agent/`)                                                             |
| `livekit/`, `caddy/`, `docker-compose.yml` | Infrastructure                                                                                                     |
| `scripts/`                                     | `init.sh`, `mock-llm.mjs` (fake LLM for testing), browser e2e tests                                            |

## How it differs from the Matrix version

|                    | Matrix version          | LiveKit version                                                                                                             |
| ------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Conversation       | Matrix room             | LiveKit room `conv_<id>`                                                                                                  |
| Message history    | Synapse                 | Postgres `messages` table (LiveKit does not store messages)                                                               |
| Hand-off state     | Matrix room state event | Columns on `conversations`                                                                                                |
| Sending a message  | Matrix client SDK       | `POST /api/conversations/:id/messages`                                                                                    |
| Receiving          | Matrix `sync`         | Backend pushes events as LiveKit data packets (`chat` topic); clients ignore any packet that did not come from the server |
| AI streaming       | `m.replace` edits     | `stream` events, replaced by the final `message` with the same id                                                       |
| Agent login        | Matrix account          | `agents` table + password (scrypt) -> backend JWT                                                                         |
| Agent-only summary | message flag            | `internal` message, delivered only to the assigned agent and omitted from the customer's history API                      |

Escalation never auto-assigns: the conversation goes to *Waiting* and an agent must open it (read-only review) and press **Accept conversation**. If nobody accepts within `fallback_after_seconds`, it returns to the AI.

Everything else (AI prompt/tool loop, `tools.yaml`, escalation tools, queue + presence + max concurrent, fallback timer, customer profile headers/JWT, defaults) is carried over.

## Quick start

Prerequisites: Docker Desktop, Node 20+, Bash (Git Bash on Windows) with `openssl`.

```bash
bash scripts/init.sh                       # creates .env, generates secrets and the LiveKit API key pair
# edit .env: LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
(cd widget   && npm install && npm run build)
(cd agent-ui && npm install && npm run build)
docker compose up -d --build
docker compose exec backend node dist/cli/create-agent.js alice 'a-strong-password' 'Alice'
```

- Demo site with the widget: http://localhost:8080/
- Agent console: http://localhost:8080/agent/ (sign in, click *Offline* -> *Online*). Escalated chats appear under *Waiting*; open one to review the AI summary banner and the whole conversation, then press **Accept conversation** to take it and reply.
- Test emails (Mailpit): http://localhost:8025

No LLM at hand? Run `node scripts/mock-llm.mjs`, then `docker compose -f docker-compose.yml -f docker-compose.mock-llm.yml up -d backend` (a message containing "human" triggers an escalation). Switch back with `docker compose up -d backend`.

Dev servers: `cd widget && npm run dev` (5173) and `cd agent-ui && npm run dev` (5174), both talking to Caddy on :8080.

## Embedding

Identical to the Matrix version, plus an optional `calls` switch:

```html
<script src="https://your-host/widget.js"></script>
<script>
  SupportChat.init({
    backendUrl: "https://your-host",
    user: { name: "Priya Nair", email: "priya@example.com", phone: "+91 98123 45678" },  // all optional
    metadata: { plan: "pro", orders: 3 },        // optional free-form facts for the AI and agents
    customHeaders: { "X-Tenant-Id": "acme" },    // optional
    calls: { voice: true, video: true },         // optional; buttons appear only if the backend enables them
    theme: "auto"                                // optional: "light" | "dark" | "auto" (follows the visitor OS)
  });
</script>
```

The customer details headers (`X-Customer-Name/Email/Phone/Meta`), validation limits, defaults, and `CUSTOMER_AUTH_MODE=external_jwt` behave exactly as described in the Matrix project's README.

## Voice and video

**Works today (human <-> customer):** set `ENABLE_VOICE=true` and/or `ENABLE_VIDEO=true` in `.env` and restart the backend. Tokens then allow publishing microphone/camera; the widget shows 🎤/📷 buttons and the agent console shows 🎤/📷 buttons plus the customer's video. Tested with fake media devices (`scripts/call-e2e.mjs`).

**Next step (AI answers by voice):** add a LiveKit Agents worker (see `../AXLAI-Voicekit/axlai-voice-agent` for the pattern) that joins rooms named `conv_*` while the conversation status is `ai`. The seams are already there:

- the worker can reuse the same prompt/tool config by calling the backend, or by sharing `backend/src/ai` + `backend/src/tools` (tool handlers only need a conversation id);
- transcripts from the worker should be stored with `addMessage()` (role `customer` / `ai`) so they appear in the chat, the history API, emails and the agent console;
- on escalation, `escalate_to_human_chat` already moves the status to `waiting`/`assigned`; the worker should leave the room when the status is no longer `ai` and the human agent joins the same room;
- for production media, set `rtc.node_ip` in `livekit/livekit.yaml` to the server's public IP and open 7881/tcp and 7882/udp (or use LiveKit Cloud: point `LIVEKIT_URL`, `LIVEKIT_PUBLIC_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` at it and remove the `livekit` service).

## Notes and limits (v1)

- Single backend instance: the agent-assignment lock is in-process. To scale out, replace `exclusive()` in `backend/src/routing/agents.ts` with a Postgres advisory lock.
- The agent queue is polled every 4 s (the room events are live; the queue list is not).
- No typing indicator for humans, no file attachments, no end-to-end encryption.
- `widget/src/useConversation.ts` and `agent-ui/src/useConversation.ts` are identical copies; keep them in sync (or extract a shared package).
- Logging rule (same as the Matrix project): never log message bodies, prompts or tool arguments.

## Tests

```bash
npm install
node scripts/mock-llm.mjs &        # fake LLM
docker compose -f docker-compose.yml -f docker-compose.mock-llm.yml up -d backend
npm run e2e:ui                     # chat, AI streaming, escalation, hand-off, reload (needs Edge + agent alice)
node scripts/call-e2e.mjs          # voice/video tracks (needs ENABLE_VOICE/VIDEO=true)
```
