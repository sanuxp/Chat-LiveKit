// Browser E2E for session persistence in the widget (anonymous mode, default 24 h lifetime):
// reload resumes the chat; another user on the same browser never sees it; SupportChat.identify() switches users in a SPA.
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await (await browser.newContext()).newPage();
const ok = (l, v, d = "") => { console.log(`${v ? "PASS" : "FAIL"}  ${l}${d ? "  - " + d : ""}`); if (!v) process.exitCode = 1; };
const user = (name) => `${BASE}/?name=${encodeURIComponent(name)}&email=${encodeURIComponent(name.toLowerCase() + "@example.com")}`;
const transcript = () => page.locator(".sc-transcript").innerText();
const ready = () => page.waitForFunction(() => document.querySelector("#support-chat-host").shadowRoot.querySelector(".sc-form input")?.disabled === false, null, { timeout: 30000 });
async function open(url) {
  await page.goto(url);
  await page.locator("#support-chat-host >> .sc-trigger").click();
  await ready();
  await page.waitForTimeout(1200); // history is loaded right after the room connects
}
const unique = `m${Date.now()}`;

await open(user("Asha"));
await page.fill(".sc-form input", `remember me ${unique}`);
await page.click(".sc-form button[type=submit]");
await page.locator(".sc-own", { hasText: unique }).waitFor({ timeout: 15000 });
ok("Asha sends a message", true);

await open(user("Asha"));
ok("after a reload Asha is back in the same conversation", (await transcript()).includes(unique));

await open(user("Bala"));
ok("another user on the same browser does not see Asha's chat", !(await transcript()).includes(unique));
await page.fill(".sc-form input", "I am Bala");
await page.click(".sc-form button[type=submit]");
await page.locator(".sc-own", { hasText: "I am Bala" }).waitFor({ timeout: 15000 });

await page.evaluate(() => window.SupportChat.identify({ user: { name: "Chitra", email: "chitra@example.com" } }));
await page.locator(".sc-own", { hasText: "I am Bala" }).waitFor({ state: "detached", timeout: 15000 });
await ready();
await page.waitForTimeout(1200);
ok("identify(): a new user in a single-page app gets a clean chat, Bala's disappears", !(await transcript()).includes("I am Bala"));

await open(user("Asha"));
ok("Asha's old chat is not offered to whoever used the browser last (anonymous mode never restores it)", !(await transcript()).includes(unique));
await browser.close();
