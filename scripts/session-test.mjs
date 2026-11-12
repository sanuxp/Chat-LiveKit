// Session rules, API level (no browser, no LLM needed). Needs Docker; it restarts the backend with a 14 s session
// lifetime (docker-compose.session-test.yml) and puts the normal settings back at the end.
//   node scripts/session-test.mjs
import { execFileSync } from "node:child_process";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const TTL_MS = 0.004 * 3600 * 1000; // 14.4 s
const sh = (args, opts = {}) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const psql = (sql) => sh(["compose", "exec", "-T", "postgres", "psql", "-U", "support", "-d", "support", "-Atc", sql]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (label, v, detail = "") => { console.log(`${v ? "PASS" : "FAIL"}  ${label}${detail ? "  - " + detail : ""}`); if (!v) failed++; };

// ---- helpers ---------------------------------------------------------------------------------------------------
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwtFor(sub, extra = {}) {
  const head = b64({ alg: "RS256", typ: "JWT" }), body = b64({ sub, ...extra, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${head}.${body}.${createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey).toString("base64url")}`;
}
async function session({ jwt, headers = {}, visitorId } = {}) {
  const res = await fetch(`${BASE}/api/customer/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), ...headers },
    body: JSON.stringify({ visitorId }),
  });
  if (!res.ok) throw new Error(`session ${res.status}`);
  return res.json();
}
const api = (token, method, path, body) =>
  fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const send = (s, text) => api(s.backendToken, "POST", `/api/conversations/${s.conversationId}/messages`, { body: text });
const view = async (s) => { const r = await api(s.backendToken, "GET", `/api/conversations/${s.conversationId}`); return { status: r.status, body: r.ok ? await r.json() : null }; };
async function until(fn, ms = 40000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(1000); } return false; }
async function startBackend(mode) {
  sh(["compose", "-f", "docker-compose.yml", "-f", "docker-compose.session-test.yml", "up", "-d", "--force-recreate", "backend"],
    { env: { ...process.env, TEST_AUTH_MODE: mode, TEST_JWT_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }) } });
  if (!(await until(async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok, 60000))) throw new Error("backend did not start");
  await sleep(1500);
}

try {
  // ============================ verified host login (external_jwt) ==================================================
  console.log("--- external_jwt, session lifetime 14 s");
  await startBackend("external_jwt");
  const u1 = `u1-${randomUUID()}`, u2 = `u2-${randomUUID()}`, u3 = `u3-${randomUUID()}`, u4 = `u4-${randomUUID()}`;

  const a = await session({ jwt: jwtFor(u1, { name: "Asha", email: "asha@example.com" }) });
  ok("a new visitor gets a conversation with no expiry yet", !!a.conversationId && a.expiresAt === null);
  const t0 = Date.now();
  ok("sending the first message works", (await send(a, "first message from Asha")).ok);
  const a2 = await session({ jwt: jwtFor(u1) });
  ok("returning (another device / reload) resumes the same conversation", a2.conversationId === a.conversationId);
  const exp1 = new Date(a2.expiresAt).getTime();
  ok("the clock started at the first message (fixed window)", Math.abs(exp1 - (t0 + TTL_MS)) < 4000, `${Math.round((exp1 - t0) / 1000)}s`);
  const hist = await view(a2);
  ok("the transcript is there on return", hist.body?.messages.some((m) => m.body === "first message from Asha"));
  await sleep(2500);
  await send(a2, "second message");
  const a3 = await session({ jwt: jwtFor(u1) });
  ok("later messages do not extend the expiry", new Date(a3.expiresAt).getTime() === exp1);

  const b = await session({ jwt: jwtFor(u2, { name: "Bala", email: "bala@example.com" }) });
  ok("another user gets a different, empty conversation", b.conversationId !== a.conversationId && (await view(b)).body.messages.length === 0);
  const peek = await api(b.backendToken, "GET", `/api/conversations/${a.conversationId}`);
  ok("another user's token cannot read the conversation", peek.status === 404);
  const peekSend = await api(b.backendToken, "POST", `/api/conversations/${a.conversationId}/messages`, { body: "intruder" });
  ok("...nor write to it", peekSend.status === 404);
  ok("a forged JWT is refused", await fetch(`${BASE}/api/customer/session`, { method: "POST", headers: { Authorization: "Bearer not.a.jwt", "Content-Type": "application/json" }, body: "{}" }).then((r) => r.status === 401));

  console.log("    ... waiting for the 14 s window to end");
  const closed = await until(async () => (await view(a)).body?.status === "closed", 45000);
  ok("after the window the conversation is closed", closed);
  ok("the transcript is kept", Number(psql(`select count(*) from messages where conversation_id='${a.conversationId}' and role='customer'`)) >= 2);
  ok("closed reason is recorded", psql(`select closed_reason from conversations where id='${a.conversationId}'`) === "expired");
  ok("the customer cannot keep writing to it", (await send(a, "too late")).status === 409);
  const a4 = await session({ jwt: jwtFor(u1) });
  ok("the next visit starts a fresh conversation", a4.conversationId !== a.conversationId && a4.expiresAt === null);
  ok("the expired chat is not shown in the new one", (await view(a4)).body.messages.every((m) => m.role !== "customer"));

  // live hand-off is never cut off: it closes once the person is done
  const c = await session({ jwt: jwtFor(u3, { name: "Chitra" }) });
  await send(c, "I need a person");
  psql(`update conversations set status='waiting', reason='test', summary='test' where id='${c.conversationId}'`);
  console.log("    ... waiting past expiry while the conversation is with a human");
  await sleep(TTL_MS + 7000);
  ok("a conversation waiting for / with an agent is not closed at expiry", psql(`select status from conversations where id='${c.conversationId}'`) === "waiting");
  sh(["compose", "exec", "-T", "backend", "node", "dist/cli/create-agent.js", "alice", "alice-pass-123", "Alice"]);
  const login = await fetch(`${BASE}/api/agent/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "alice", password: "alice-pass-123" }) }).then((r) => r.json());
  ok("the agent can accept it after expiry", (await api(login.token, "POST", `/api/agent/conversations/${c.conversationId}/accept`)).ok);
  ok("agent resolves 'back to AI' after the window", (await api(login.token, "POST", `/api/agent/conversations/${c.conversationId}/resolve`, { returnToAi: true })).ok);
  ok("...and it closes instead of going back to the AI", psql(`select status || '/' || coalesce(closed_reason,'') from conversations where id='${c.conversationId}'`) === "closed/expired");

  // returning after expiry before the sweeper ran
  const d = await session({ jwt: jwtFor(u4) });
  await send(d, "hello");
  psql(`update conversations set expires_at = now() - interval '1 minute' where id='${d.conversationId}'`);
  const d2 = await session({ jwt: jwtFor(u4) });
  ok("an expired conversation is never resumed, even before the sweeper runs", d2.conversationId !== d.conversationId);

  // ============================ anonymous (browser based) ==============================================================
  console.log("--- anonymous mode");
  await startBackend("anonymous");
  const H = (email, name) => ({ headers: { ...(email ? { "X-Customer-Email": email } : {}), ...(name ? { "X-Customer-Name": name } : {}) } });
  const p1 = await session(H("pat@example.com"));
  await send(p1, "hi from Pat");
  const p2 = await session({ ...H("pat@example.com"), visitorId: p1.visitorId });
  ok("same browser, same user: the chat is resumed", p2.conversationId === p1.conversationId && p2.visitorId === p1.visitorId);
  const q = await session({ ...H("quinn@example.com"), visitorId: p1.visitorId });
  ok("same browser, a different user: a new chat and a new visitor id", q.conversationId !== p1.conversationId && q.visitorId !== p1.visitorId);
  ok("...and the new user cannot read Pat's chat", (await api(q.backendToken, "GET", `/api/conversations/${p1.conversationId}`)).status === 404);
  const out = await session({ visitorId: p1.visitorId });
  ok("the host page stops sending a user (logged out): a new chat, Pat's stays hidden", out.conversationId !== p1.conversationId && out.visitorId !== p1.visitorId);
  const anon = await session();
  await send(anon, "hello as a guest");
  const login2 = await session({ ...H("rita@example.com"), visitorId: anon.visitorId });
  ok("a guest who then logs in keeps their conversation", login2.conversationId === anon.conversationId);
} catch (e) {
  failed++; console.log("FAIL  test run aborted:", e.message);
} finally {
  sh(["compose", "up", "-d", "--force-recreate", "backend"]);
  console.log(`\nbackend restored to its normal settings. ${failed ? failed + " FAILED" : "all passed"}`);
  process.exit(failed ? 1 : 0);
}
