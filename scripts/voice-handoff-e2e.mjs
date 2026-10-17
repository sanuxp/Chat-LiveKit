// Voice -> human hand-off: the customer's (mock-transcribed) speech asks for a human; the AI calls the escalation tool,
// says the hand-over line and leaves the room; a human agent then reviews and accepts the conversation.
// Run the mock with:  MOCK_STT_TEXT="I want to talk to a human please" node scripts/mock-llm.mjs
import { chromium } from "playwright-core";
import { resolve } from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const browser = await chromium.launch({
  channel: "msedge", headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${resolve("voice-agent/tests/hello.wav")}`, "--autoplay-policy=no-user-gesture-required"],
});
const mk = async () => (await browser.newContext({ permissions: ["microphone"] })).newPage();
const agent = await mk(), cust = await mk();
const ok = (l, v) => { console.log(`${v ? "PASS" : "FAIL"}  ${l}`); if (!v) process.exitCode = 1; };

await agent.goto(`${BASE}/agent/`);
await agent.fill("input[autocomplete=username]", "alice");
await agent.fill("input[type=password]", "alice-pass-123");
await agent.click("button[type=submit]");
await agent.getByRole("button", { name: /Offline/ }).click();
await agent.getByRole("button", { name: /Online/ }).waitFor();

await cust.goto(BASE);
await cust.locator("#support-chat-host >> .sc-trigger").click();
await cust.waitForFunction(() => document.querySelector("#support-chat-host").shadowRoot.querySelector(".sc-form input")?.disabled === false, null, { timeout: 30000 });
await cust.getByRole("button", { name: "Talk to the AI assistant" }).click();
await cust.locator(".sc-assistant").waitFor({ timeout: 90000 });
ok("voice assistant joined", true);

await cust.getByText("Waiting for a team member to join").waitFor({ timeout: 90000 });
ok("the spoken request escalated the conversation to Waiting", true);
await cust.locator(".sc-assistant").waitFor({ state: "detached", timeout: 60000 });
ok("the voice assistant left the room after the hand-over", true);

await agent.locator(".row").last().waitFor({ timeout: 30000 });
await agent.locator(".row").last().click();
await agent.locator(".summary-banner").waitFor({ timeout: 30000 });
const tl = await agent.locator(".timeline").innerText();
ok("agent sees the voice transcript before accepting", tl.includes("talk to a human"));
await agent.getByRole("button", { name: "Accept conversation" }).click();
await cust.getByText(/Alice from our team joined/).waitFor({ timeout: 30000 });
ok("agent accepts; customer sees the agent joined", true);
await browser.close();
