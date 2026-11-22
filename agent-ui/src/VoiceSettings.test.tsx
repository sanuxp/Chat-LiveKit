import { render, screen, within } from "@testing-library/react";
import { VoiceSettings } from "./VoiceSettings";
import { axe } from "./test/axe";

const mockApi = jest.fn();
jest.mock("./api", () => ({
  api: (...a: unknown[]) => mockApi(...a),
  ApiError: class extends Error {},
}));

const prov = (label: string, extra: object = {}) => ({ label, configured: true, missing: [], ...extra });
const payload = {
  voiceEnabledInEnv: true,
  catalog: {
    fields: {
      min_endpointing_delay: { label: "Minimum endpointing delay", min: 0, max: 5, step: 0.1, default: 0.5, help: "Seconds" },
      max_endpointing_delay: { label: "Maximum endpointing delay", min: 0, max: 10, step: 0.1, default: 3 },
    },
    vad_presets: {},
    vad: { silero: prov("Silero") },
    noise_cancellation: { none: prov("None") },
    turn_detection: { basic: prov("Basic") },
    stt: { dg: prov("Deepgram", { models: ["m1"] }) },
    llm: { oa: prov("OpenAI", { models: ["g1"] }) },
    tts: { el: prov("ElevenLabs", { models: ["t1"] }) },
  },
  selection: {
    enabled: true, greeting: "Hello", vad_provider: "silero", noise_provider: "none", turn_detection: "basic",
    min_endpointing_delay: 0.5, max_endpointing_delay: 3, stt_provider: "dg", stt_model: "m1", stt_language: "en",
    llm_provider: "oa", llm_model: "g1", tts_provider: "el", tts_model: "t1", tts_voice_id: "v", tts_language: "",
  },
  issues: [
    { field: "vad_provider", level: "error", message: "Bad VAD" },
    { field: "stt_provider", level: "warn", message: "Slow STT" },
  ],
};

beforeEach(() => mockApi.mockResolvedValue(payload));

async function ready() {
  const utils = render(<VoiceSettings token="t" onClose={() => {}} />);
  await screen.findByRole("heading", { name: "Voice settings" });
  return utils;
}

describe("VoiceSettings accessibility", () => {
  it("has no axe violations", async () => {
    const { container } = await ready();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("gives the paired slider and number input distinct accessible names inside a labelled group", async () => {
    await ready();
    const group = screen.getByRole("group", { name: "Minimum endpointing delay" });
    expect(within(group).getByRole("slider", { name: /slider/i })).toBeInTheDocument();
    expect(within(group).getByRole("spinbutton", { name: /value/i })).toBeInTheDocument();
  });

  it("announces validation errors and spells out severity in words, not only symbols", async () => {
    await ready();
    const alerts = screen.getAllByRole("alert").map((a) => a.textContent);
    expect(alerts.some((t) => /Error: .*Bad VAD/.test(t ?? ""))).toBe(true);
    expect(screen.getByText(/Slow STT/).closest("p")).toHaveTextContent("Warning: Slow STT");
  });

  it("every form control has an accessible name", async () => {
    await ready();
    for (const el of screen.getAllByRole("combobox")) expect(el).toHaveAccessibleName();
    for (const el of screen.getAllByRole("textbox")) expect(el).toHaveAccessibleName();
    expect(screen.getByRole("checkbox", { name: /voice assistant enabled/i })).toBeInTheDocument();
  });

  it("shows load failures as an alert", async () => {
    mockApi.mockRejectedValueOnce(new Error("Nope"));
    render(<VoiceSettings token="t" onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Nope");
  });
});
