// Browser E2E: customer widget + agent console over LiveKit.
// Needs: npm i (in this folder), Microsoft Edge, the stack running with scripts/mock-llm.mjs as the LLM,
// and an agent: docker compose exec backend node dist/cli/create-agent.js alice alice-pass-123 Alice
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
const mk = async () => { const p = await (await browser.newContext()).newPage(); p.on("pageerror", (e) => errors.push(e.message)); return p; };
const agent = await mk(), cust = await mk();
const ok = (label, v, detail = "") => { console.log(`${v ? "PASS" : "FAIL"}  ${label}${detail ? "  - " + detail : ""}`); if (!v) process.exitCode = 1; };

// agent signs in and goes online
await agent.goto(`${BASE}/agent/`);
await agent.fill("input[autocomplete=username]", "alice");
await agent.fill("input[type=password]", "alice-pass-123");
await agent.click("button[type=submit]");
await agent.getByText("Agent console").first().waitFor({ timeout: 30000 });
await agent.getByRole("button", { name: /Offline/ }).click();
await agent.getByRole("button", { name: /Online/ }).waitFor();
ok("agent signed in and online", true);

// customer chats with the AI (streamed answer)
await cust.goto(`${BASE}/?name=Priya%20Nair&email=priya%40example.com`);
await cust.locator("#support-chat-host >> .sc-trigger").click();
await cust.locator(".sc-form input").waitFor({ timeout: 30000 });
await cust.waitForFunction(() => document.querySelector("#support-chat-host").shadowRoot.querySelector(".sc-form input")?.disabled === false, null, { timeout: 30000 });
await cust.fill(".sc-form input", "hello there");
await cust.click(".sc-form button[type=submit]");
await cust.getByText("You said: hello there").waitFor({ timeout: 30000 });
ok("AI answer streamed to the customer", true);

// customer asks for a human -> goes to the waiting queue (NOT auto-assigned)
await cust.fill(".sc-form input", "I want to talk to a human, my invoice is wrong.");
await cust.click(".sc-form button[type=submit]");
await cust.getByText("Waiting for a team member to join").waitFor({ timeout: 30000 });
ok("customer is told they are waiting", true);

// agent reviews the waiting conversation: banner + whole history, but nothing is assigned yet
await agent.locator(".row").last().waitFor({ timeout: 30000 });
await agent.locator(".row").last().click();
await agent.locator(".summary-banner").waitFor({ timeout: 30000 });
ok("agent sees the AI summary banner", (await agent.locator(".summary-banner").innerText()).includes("invoice is wrong"));
const history = await agent.locator(".timeline").innerText();
ok("agent sees the whole conversation before accepting", history.includes("hello there") && history.includes("invoice is wrong"));
ok("agent sees customer profile", (await agent.locator(".customer-card").innerText()).includes("Priya Nair"));
ok("no reply box before accepting", (await agent.locator(".composer").count()) === 0);
await agent.waitForTimeout(1500);
ok("customer still waiting (not assigned by merely opening it)", !(await cust.locator(".sc-transcript").innerText()).includes("joined"));

// decline leaves it waiting (hidden for this agent); it can be shown again and reviewed
await agent.getByRole("button", { name: "Decline" }).click();
await agent.locator(".queue").waitFor();
ok("declined conversation is hidden from the agent's list", (await agent.locator(".row").count()) === 0);
ok("customer is still waiting after a decline", !(await cust.locator(".sc-transcript").innerText()).includes("joined"));
await agent.getByRole("button", { name: "Show" }).click();
await agent.locator(".row").last().click();
await agent.locator(".summary-banner").waitFor();

// accept from inside the conversation
await agent.getByRole("button", { name: "Accept conversation" }).click();
await cust.getByText(/Alice from our team joined/).waitFor({ timeout: 30000 });
ok("customer sees that the agent joined after Accept", true);
await agent.locator(".composer input:not([disabled])").waitFor({ timeout: 30000 });
ok("agent keeps the banner and history after accepting", (await agent.locator(".summary-banner").count()) === 1 && (await agent.locator(".timeline").innerText()).includes("hello there"));

await agent.fill(".composer input", "Hi, Alice here. Looking at it now.");
await agent.click(".composer button[type=submit]");
await cust.getByText("Hi, Alice here. Looking at it now.").waitFor({ timeout: 20000 });
ok("customer receives the agent reply (live)", true);
ok("customer does NOT see the internal summary", !(await cust.locator(".sc-transcript").innerText()).includes("Summary:"));

await cust.fill(".sc-form input", "thanks!");
await cust.click(".sc-form button[type=submit]");
await agent.locator(".msg.customer", { hasText: "thanks!" }).waitFor({ timeout: 20000 });
ok("agent receives the customer message (live)", true);
ok("AI stays silent while the agent is assigned", !(await cust.locator(".sc-transcript").innerText()).includes("You said: thanks!"));

// resolve back to AI
await agent.getByRole("button", { name: /back to AI/ }).click();
await agent.locator(".queue").waitFor({ timeout: 20000 });
await cust.getByText(/chatting with our AI assistant again/).waitFor({ timeout: 20000 });
ok("resolve returns to queue; customer told the AI is back", true);

// reload: history is restored
await cust.reload();
await cust.locator("#support-chat-host >> .sc-trigger").click();
await cust.getByText("Hi, Alice here. Looking at it now.").waitFor({ timeout: 30000 });
ok("history survives a page reload", true);

console.log("page errors:", errors);
await browser.close();
