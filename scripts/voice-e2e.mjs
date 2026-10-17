// Browser E2E for the AI voice assistant. The customer's fake microphone plays voice-agent/tests/hello.wav
// ("Hello. What are your support hours? ..."). Needs: the stack running with ENABLE_VOICE=true, the voice worker
// (docker compose --profile voice up -d, or `python main.py dev` in voice-agent/) and working STT / LLM / TTS
// providers selected in Voice settings (the default OpenAI-compatible ones need a LiteLLM proxy with whisper + tts models).
import { chromium } from "playwright-core";
import { resolve } from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const WAV = resolve("voice-agent/tests/hello.wav");
const browser = await chromium.launch({
  channel: "msedge", headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`, "--autoplay-policy=no-user-gesture-required"],
});
const ctx = await browser.newContext({ permissions: ["microphone"] });
const cust = await ctx.newPage();
const ok = (label, v, detail = "") => { console.log(`${v ? "PASS" : "FAIL"}  ${label}${detail ? "  - " + detail : ""}`); if (!v) process.exitCode = 1; };
const text = () => cust.locator(".sc-transcript").innerText();

await cust.goto(BASE);
await cust.locator("#support-chat-host >> .sc-trigger").click();
await cust.waitForFunction(() => document.querySelector("#support-chat-host").shadowRoot.querySelector(".sc-form input")?.disabled === false, null, { timeout: 30000 });
await cust.getByRole("button", { name: "Talk to the AI assistant" }).click();

await cust.locator(".sc-assistant").waitFor({ timeout: 90000 });
ok("voice assistant joined the room", true);

// the greeting is spoken and stored as an AI message
await cust.getByText("How can I help you today?").first().waitFor({ timeout: 60000 });
ok("greeting appears in the chat", true);
ok("assistant audio reaches the browser", (await cust.evaluate(() => document.querySelectorAll("audio").length)) >= 1);

// the spoken question is transcribed (customer bubble) and answered (a second AI message)
await cust.locator("#support-chat-host >> .sc-own").first().waitFor({ timeout: 90000 });
ok("customer speech is transcribed into the chat", true, (await cust.locator("#support-chat-host >> .sc-own").first().innerText()).slice(0, 80));
await cust.waitForFunction(() => document.querySelector("#support-chat-host").shadowRoot.querySelectorAll(".sc-other").length >= 2, null, { timeout: 90000 });
ok("assistant answers the question", true);
console.log("---\n" + (await text()).slice(0, 600));
await browser.close();
