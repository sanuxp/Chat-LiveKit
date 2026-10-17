import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { pool } from "../db/db.js";

/**
 * Voice pipeline catalog (config/voice.yaml: the AXLAI voicekit stack of VAD / noise suppression / turn detection /
 * STT / LLM / TTS providers) plus the admin's stored selection (settings table, key "voice").
 * The worker in voice-agent/ gets the normalised selection and builds the matching providers.
 */

const Env = { env: z.array(z.string()).default([]), env_any: z.array(z.array(z.string())).optional() };
const Field = z.object({ label: z.string(), min: z.number(), max: z.number(), step: z.number(), default: z.number(), integer: z.boolean().optional(), help: z.string().optional() });
const Simple = z.object({ label: z.string(), description: z.string().optional(), tunables: z.array(z.string()).default([]), ...Env });
const Turn = z.object({ label: z.string(), description: z.string().optional(), requires_vad: z.boolean(), ...Env });
const Stt = z.object({
  label: z.string(), description: z.string().optional(), requires_vad: z.boolean().default(false), custom_model: z.boolean().default(false),
  tunables: z.array(z.string()).default([]), ...Env,
  models: z.record(z.object({ languages: z.array(z.string()).min(1) })),
});
const Llm = z.object({
  label: z.string(), description: z.string().optional(), custom_model: z.boolean().default(false),
  tunables: z.array(z.string()).default([]), ...Env, models: z.array(z.string()).min(1),
});
const Tts = z.object({
  label: z.string(), description: z.string().optional(), custom_model: z.boolean().default(false), custom_voice: z.boolean().default(false),
  tunables: z.array(z.string()).default([]), ...Env,
  models: z.record(z.object({ voices: z.array(z.string()).min(1), languages: z.array(z.string()).optional() })),
});

const CatalogSchema = z.object({
  defaults: z.object({
    enabled: z.boolean(), greeting: z.string(), vad_provider: z.string(), noise_provider: z.string(), turn_detection: z.string(),
    stt_provider: z.string(), stt_model: z.string(), stt_language: z.string(),
    llm_provider: z.string(), llm_model: z.string(),
    tts_provider: z.string(), tts_model: z.string(), tts_voice_id: z.string(), tts_language: z.string(),
  }),
  fields: z.record(Field),
  vad_presets: z.record(z.object({ label: z.string(), values: z.record(z.number()) })),
  vad: z.record(Simple),
  noise_cancellation: z.record(Simple),
  turn_detection: z.record(Turn),
  stt: z.record(Stt),
  llm: z.record(Llm),
  tts: z.record(Tts),
});
export type Catalog = z.infer<typeof CatalogSchema>;

export interface Selection {
  enabled: boolean;
  greeting: string;
  vad_provider: string;
  noise_provider: string;
  turn_detection: string;
  stt_provider: string; stt_model: string; stt_language: string;
  llm_provider: string; llm_model: string;
  tts_provider: string; tts_model: string; tts_voice_id: string; tts_language: string;
  // numeric tuning fields (see `fields` in voice.yaml): vad_*, min_interruption_words, noise_strength, *_endpointing_*,
  // stt_*, temperature, max_tokens, speech_speed
  [numeric: string]: string | number | boolean;
}
export interface Issue { field: string; level: "error" | "warn"; message: string }

const catalogPath = () => resolve(process.env.VOICE_CONFIG_PATH ?? "./config/voice.yaml");

export async function loadCatalog(): Promise<Catalog> {
  const parsed = CatalogSchema.safeParse(parseYaml(await readFile(catalogPath(), "utf8")));
  if (!parsed.success) {
    throw new Error(`Invalid voice catalog ${catalogPath()}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const c = parsed.data, d = c.defaults;
  const must = (ok: boolean, msg: string) => { if (!ok) throw new Error(`voice catalog: ${msg}`); };
  must(d.vad_provider in c.vad, `default vad "${d.vad_provider}" unknown`);
  must(d.noise_provider in c.noise_cancellation, `default noise "${d.noise_provider}" unknown`);
  must(d.turn_detection in c.turn_detection, `default turn_detection "${d.turn_detection}" unknown`);
  must(d.stt_provider in c.stt && d.stt_model in c.stt[d.stt_provider].models, "default stt provider/model unknown");
  must(d.llm_provider in c.llm && c.llm[d.llm_provider].models.includes(d.llm_model), "default llm provider/model unknown");
  must(d.tts_provider in c.tts && d.tts_model in c.tts[d.tts_provider].models, "default tts provider/model unknown");
  for (const t of [...Object.values(c.vad), ...Object.values(c.noise_cancellation), ...Object.values(c.stt), ...Object.values(c.llm), ...Object.values(c.tts)]) {
    for (const f of t.tunables) must(f in c.fields, `tunable "${f}" is not defined in fields`);
  }
  return c;
}

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "");
const first = <T>(o: Record<string, T>) => Object.keys(o)[0];

/** Keep only valid values. Invalid or missing ones fall back to defaults (providers) or the first valid choice (models). */
export function normaliseSelection(cat: Catalog, raw: any): Selection {
  const d = cat.defaults;
  const r = raw && typeof raw === "object" ? raw : {};
  const pick = <T>(table: Record<string, T>, v: unknown, def: string) => (typeof v === "string" && v in table ? v : def);

  const stt_provider = pick(cat.stt, r.stt_provider, d.stt_provider);
  const sttp = cat.stt[stt_provider];
  const sttModel = clean(r.stt_model, 100);
  const stt_model = sttModel in sttp.models || (sttp.custom_model && sttModel) ? sttModel : stt_provider === d.stt_provider ? d.stt_model : first(sttp.models);
  const sttLangs = (sttp.models[stt_model] ?? sttp.models[first(sttp.models)]).languages;
  const stt_language = sttLangs.includes(r.stt_language) ? r.stt_language : sttLangs.includes(d.stt_language) ? d.stt_language : sttLangs[0];

  const llm_provider = pick(cat.llm, r.llm_provider, d.llm_provider);
  const llmp = cat.llm[llm_provider];
  const llmModel = clean(r.llm_model, 100);
  const llm_model = llmp.models.includes(llmModel) || (llmp.custom_model && llmModel) ? llmModel : llm_provider === d.llm_provider ? d.llm_model : llmp.models[0];

  const tts_provider = pick(cat.tts, r.tts_provider, d.tts_provider);
  const ttsp = cat.tts[tts_provider];
  const ttsModel = clean(r.tts_model, 100);
  const tts_model = ttsModel in ttsp.models || (ttsp.custom_model && ttsModel) ? ttsModel : tts_provider === d.tts_provider ? d.tts_model : first(ttsp.models);
  const ttsm = ttsp.models[tts_model] ?? ttsp.models[first(ttsp.models)];
  const voice = clean(r.tts_voice_id, 200);
  const tts_voice_id = ttsm.voices.includes(voice) || (ttsp.custom_voice && voice) ? voice : tts_provider === d.tts_provider && ttsm.voices.includes(d.tts_voice_id) ? d.tts_voice_id : ttsm.voices[0];
  const tts_language = !ttsm.languages ? "" : ttsm.languages.includes(r.tts_language) ? r.tts_language : ttsm.languages[0];

  const sel: Selection = {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    greeting: clean(r.greeting, 300) || d.greeting,
    vad_provider: pick(cat.vad, r.vad_provider, d.vad_provider),
    noise_provider: pick(cat.noise_cancellation, r.noise_provider, d.noise_provider),
    turn_detection: pick(cat.turn_detection, r.turn_detection, d.turn_detection),
    stt_provider, stt_model, stt_language,
    llm_provider, llm_model,
    tts_provider, tts_model, tts_voice_id, tts_language,
  };
  for (const [name, f] of Object.entries(cat.fields)) {
    const v = typeof r[name] === "number" && Number.isFinite(r[name]) ? r[name] : f.default;
    const clamped = Math.min(f.max, Math.max(f.min, v));
    sel[name] = f.integer ? Math.round(clamped) : clamped;
  }
  if ((sel.max_endpointing_delay as number) < (sel.min_endpointing_delay as number)) sel.max_endpointing_delay = sel.min_endpointing_delay;
  return sel;
}

type WithEnv = { env: string[]; env_any?: string[][] };
function missingEnv(p: WithEnv): string[] {
  const missing = p.env.filter((e) => !process.env[e]);
  if (p.env_any?.length && !p.env_any.some((group) => group.every((e) => !!process.env[e]))) {
    missing.push(p.env_any.map((g) => g.join("+")).join(" or "));
  }
  return missing;
}

/** errors block saving; warnings (missing API keys, odd pairings) are only shown. */
export function validateSelection(cat: Catalog, s: Selection): Issue[] {
  const issues: Issue[] = [];
  const hasVad = s.vad_provider !== "none";
  const turn = cat.turn_detection[s.turn_detection];
  const stt = cat.stt[s.stt_provider];
  if (turn.requires_vad && !hasVad) {
    issues.push({ field: "turn_detection", level: "error", message: `"${turn.label}" needs a VAD. Pick Silero or ai-coustics, or choose "STT end-of-turn".` });
  }
  if (stt.requires_vad && !hasVad) {
    issues.push({ field: "stt_provider", level: "error", message: `${stt.label} is not a streaming STT here and needs a VAD. Pick a VAD or a streaming STT (Deepgram, Azure Speech).` });
  }
  if (s.turn_detection === "stt" && s.stt_provider !== "deepgram-flux") {
    issues.push({ field: "turn_detection", level: "error", message: '"STT end-of-turn" only works with Deepgram Flux. Choose Flux as the STT or another turn detector.' });
  }
  if (s.stt_provider === "deepgram-flux" && s.turn_detection !== "stt") {
    issues.push({ field: "turn_detection", level: "warn", message: 'Deepgram Flux has its own turn detection; "STT end-of-turn" is the recommended pairing.' });
  }
  if (s.turn_detection === "english" && s.stt_language !== "multi" && !String(s.stt_language).toLowerCase().startsWith("en")) {
    issues.push({ field: "turn_detection", level: "warn", message: "The English turn detector is meant for English speech; use the multilingual one for other languages." });
  }
  if (s.vad_provider === "ai-coustics") {
    issues.push({ field: "vad_provider", level: "warn", message: "If the ai-coustics VAD can't start (license or model), the worker falls back to Silero." });
  }
  const check = (field: string, label: string, p: WithEnv) => {
    const missing = missingEnv(p);
    if (missing.length) issues.push({ field, level: "warn", message: `${label}: ${missing.join(", ")} not set in .env, so the voice worker can't use it yet.` });
  };
  check("vad_provider", cat.vad[s.vad_provider].label, cat.vad[s.vad_provider]);
  check("noise_provider", cat.noise_cancellation[s.noise_provider].label, cat.noise_cancellation[s.noise_provider]);
  check("turn_detection", turn.label, turn);
  check("stt_provider", stt.label, stt);
  check("llm_provider", cat.llm[s.llm_provider].label, cat.llm[s.llm_provider]);
  check("tts_provider", cat.tts[s.tts_provider].label, cat.tts[s.tts_provider]);
  return issues;
}

export async function getSelection(): Promise<{ catalog: Catalog; selection: Selection }> {
  const catalog = await loadCatalog();
  const r = await pool.query("SELECT value FROM settings WHERE key='voice'");
  return { catalog, selection: normaliseSelection(catalog, r.rows[0]?.value) };
}

export async function saveSelection(raw: unknown): Promise<{ selection: Selection; issues: Issue[]; saved: boolean }> {
  const catalog = await loadCatalog();
  const selection = normaliseSelection(catalog, raw);
  const issues = validateSelection(catalog, selection);
  if (issues.some((i) => i.level === "error")) return { selection, issues, saved: false };
  await pool.query(
    "INSERT INTO settings (key, value) VALUES ('voice', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()",
    [JSON.stringify(selection)],
  );
  return { selection, issues, saved: true };
}

/** The catalog as the console needs it, with `configured` and `missing` on every provider. */
export function describeCatalog(cat: Catalog) {
  const flag = <T extends WithEnv>(table: Record<string, T>) =>
    Object.fromEntries(Object.entries(table).map(([id, p]) => {
      const missing = missingEnv(p);
      return [id, { ...p, configured: missing.length === 0, missing }];
    }));
  return {
    defaults: cat.defaults, fields: cat.fields, vad_presets: cat.vad_presets,
    vad: flag(cat.vad), noise_cancellation: flag(cat.noise_cancellation), turn_detection: flag(cat.turn_detection),
    stt: flag(cat.stt), llm: flag(cat.llm), tts: flag(cat.tts),
  };
}
