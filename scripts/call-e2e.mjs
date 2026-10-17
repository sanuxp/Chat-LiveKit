// Browser E2E for voice/video: the customer turns on mic + camera (fake devices) and the agent receives the tracks.
// Needs ENABLE_VOICE=true and ENABLE_VIDEO=true, mock LLM running, agent alice (see ui-e2e.mjs).
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const browser = await chromium.launch({
  channel: "msedge", headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const ctx = () => browser.newContext({ permissions: ["microphone", "camera"] });
const agent = await (await ctx()).newPage(), cust = await (await ctx()).newPage();
const ok = (label, v) => { console.log(`${v ? "PASS" : "FAIL"}  ${label}`); if (!v) process.exitCode = 1; };

await agent.goto(`${BASE}/agent/`);
await agent.fill("input[autocomplete=username]", "alice");
await agent.fill("input[type=password]", "alice-pass-123");
await agent.click("button[type=submit]");
await agent.getByRole("button", { name: /Offline/ }).click();
await agent.getByRole("button", { name: /Online/ }).waitFor();

await cust.goto(BASE);
await cust.locator("#support-chat-host >> .sc-trigger").click();
await cust.waitForFunction(() => document.querySelector("#support-chat-host").shadowRoot.querySelector(".sc-form input")?.disabled === false, null, { timeout: 30000 });
await cust.fill(".sc-form input", "human please");
await cust.click(".sc-form button[type=submit]");
await agent.locator(".row").last().waitFor({ timeout: 30000 });
await agent.locator(".row").last().click();
await agent.getByRole("button", { name: "Accept conversation" }).click();
await cust.getByText(/from our team joined/).waitFor({ timeout: 30000 });
await agent.locator(".composer input:not([disabled])").waitFor({ timeout: 30000 });

await cust.getByRole("button", { name: "Turn on microphone" }).click();
await cust.getByRole("button", { name: "Turn on camera" }).click();
await agent.locator(".call video").first().waitFor({ timeout: 30000 });
ok("agent receives the customer's video", true);
ok("agent has an audio element for the customer's mic", (await agent.locator("audio").count()) >= 1);
ok("customer shows the camera preview", (await cust.locator(".sc-local").count()) === 1);

await agent.getByRole("button", { name: /Resolve & close/ }).click();
await cust.getByText("This conversation has ended.").first().waitFor({ timeout: 20000 });
ok("closing the conversation ends it for the customer", true);
await browser.close();
