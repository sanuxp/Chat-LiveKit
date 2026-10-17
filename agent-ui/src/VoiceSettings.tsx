import { useEffect, useMemo, useState } from "react";
import { ApiError, api } from "./api";

type Sel = Record<string, string | number | boolean>;
interface Field { label: string; min: number; max: number; step: number; default: number; help?: string }
interface Provider {
  label: string; description?: string; configured: boolean; missing: string[]; tunables?: string[];
  requires_vad?: boolean; custom_model?: boolean; custom_voice?: boolean;
  models?: string[] | Record<string, { languages?: string[]; voices?: string[] }>;
}
interface Catalog {
  fields: Record<string, Field>;
  vad_presets: Record<string, { label: string; values: Record<string, number> }>;
  vad: Record<string, Provider>; noise_cancellation: Record<string, Provider>; turn_detection: Record<string, Provider>;
  stt: Record<string, Provider>; llm: Record<string, Provider>; tts: Record<string, Provider>;
}
interface Issue { field: string; level: "error" | "warn"; message: string }
interface Payload { catalog: Catalog; selection: Sel; issues: Issue[]; voiceEnabledInEnv: boolean }

const modelsOf = (p?: Provider): string[] => (!p?.models ? [] : Array.isArray(p.models) ? p.models : Object.keys(p.models));
const modelInfo = (p: Provider | undefined, m: string) => (p && p.models && !Array.isArray(p.models) ? p.models[m] : undefined);

function Select({ label, value, options, onChange, hint }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void; hint?: string }) {
  return (
    <label className="vs-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {hint && <small className="vs-hint">{hint}</small>}
    </label>
  );
}

/** A choice from the catalog that may also accept free text (deployment names, voice ids). */
function Combo({ label, value, options, custom, onChange }: { label: string; value: string; options: string[]; custom?: boolean; onChange: (v: string) => void }) {
  if (!custom) return <Select label={label} value={value} options={options.map((o) => [o, o])} onChange={onChange} />;
  const id = `dl-${label.replace(/\W/g, "")}`;
  return (
    <label className="vs-field">
      <span>{label}</span>
      <input list={id} value={value} onChange={(e) => onChange(e.target.value)} />
      <datalist id={id}>{options.map((o) => <option key={o} value={o} />)}</datalist>
      <small className="vs-hint">Pick one or type your own.</small>
    </label>
  );
}

function Num({ name, f, value, onChange }: { name: string; f: Field; value: number; onChange: (v: number) => void }) {
  return (
    <label className="vs-field" key={name}>
      <span>{f.label}</span>
      <div className="vs-num">
        <input type="range" min={f.min} max={f.max} step={f.step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <input type="number" min={f.min} max={f.max} step={f.step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      </div>
      {f.help && <small className="vs-hint">{f.help}</small>}
    </label>
  );
}

export function VoiceSettings({ token, onClose }: { token: string; onClose: () => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [sel, setSel] = useState<Sel>({});
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api<Payload>(token, "GET", "/api/voice/settings")
      .then((d) => { setData(d); setSel(d.selection); setIssues(d.issues); })
      .catch((e) => setError(e.message));
  }, [token]);

  const set = (patch: Sel) => { setSel((s) => ({ ...s, ...patch })); setSaved(false); };
  const cat = data?.catalog;

  // cascading choices, as in the AXLAI console: changing a provider resets what depends on it
  const onStt = (p: string) => {
    const prov = cat!.stt[p]; const m = modelsOf(prov)[0]; set({ stt_provider: p, stt_model: m, stt_language: modelInfo(prov, m)?.languages?.[0] ?? "en" });
  };
  const onSttModel = (m: string) => {
    const langs = modelInfo(cat!.stt[sel.stt_provider as string], m)?.languages;
    set({ stt_model: m, stt_language: langs && !langs.includes(sel.stt_language as string) ? langs[0] : sel.stt_language });
  };
  const onLlm = (p: string) => set({ llm_provider: p, llm_model: modelsOf(cat!.llm[p])[0] });
  const onTts = (p: string) => {
    const prov = cat!.tts[p]; const m = modelsOf(prov)[0]; const info = modelInfo(prov, m);
    set({ tts_provider: p, tts_model: m, tts_voice_id: info?.voices?.[0] ?? "", tts_language: info?.languages?.[0] ?? "" });
  };
  const onTtsModel = (m: string) => {
    const info = modelInfo(cat!.tts[sel.tts_provider as string], m);
    set({ tts_model: m, tts_voice_id: info?.voices?.includes(sel.tts_voice_id as string) ? sel.tts_voice_id : info?.voices?.[0] ?? sel.tts_voice_id, tts_language: info?.languages?.[0] ?? "" });
  };

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const r = await api<{ selection: Sel; issues: Issue[]; saved: boolean }>(token, "PUT", "/api/voice/settings", sel);
      setSel(r.selection); setIssues(r.issues); setSaved(r.saved);
    } catch (e) {
      // 422: invalid combination, nothing stored. The body carries the corrected selection and the issues.
      if (e instanceof ApiError && e.status === 422 && e.body?.issues) { setSel(e.body.selection); setIssues(e.body.issues); }
      else setError((e as Error).message);
    } finally { setSaving(false); }
  };

  const issuesFor = (...fields: string[]) => issues.filter((i) => fields.includes(i.field));
  const Issues = ({ fields }: { fields: string[] }) => (
    <>{issuesFor(...fields).map((i, k) => <p key={k} className={i.level === "error" ? "error vs-issue" : "vs-warn vs-issue"}>{i.level === "error" ? "✕ " : "⚠ "}{i.message}</p>)}</>
  );
  const providerOptions = (t: Record<string, Provider>): [string, string][] => Object.entries(t).map(([id, p]) => [id, `${p.label}${p.configured ? "" : "  (needs setup)"}`]);
  const tunables = (p?: Provider) => (p?.tunables ?? []).filter((n) => cat?.fields[n]);
  const Tunables = ({ p }: { p?: Provider }) => <>{tunables(p).map((n) => <Num key={n} name={n} f={cat!.fields[n]} value={sel[n] as number} onChange={(v) => set({ [n]: v })} />)}</>;
  const preset = useMemo(() => {
    if (!cat) return "";
    const hit = Object.entries(cat.vad_presets).find(([, p]) => Object.entries(p.values).every(([k, v]) => sel[k] === v));
    return hit?.[0] ?? "custom";
  }, [cat, sel]);

  if (error && !data) return <p className="error">{error}</p>;
  if (!cat) return <p className="muted">Loading…</p>;

  const vad = cat.vad[sel.vad_provider as string], noise = cat.noise_cancellation[sel.noise_provider as string];
  const turn = cat.turn_detection[sel.turn_detection as string];
  const stt = cat.stt[sel.stt_provider as string], llm = cat.llm[sel.llm_provider as string], tts = cat.tts[sel.tts_provider as string];
  const sttInfo = modelInfo(stt, sel.stt_model as string), ttsInfo = modelInfo(tts, sel.tts_model as string);
  const hasErrors = issues.some((i) => i.level === "error");

  return (
    <div className="vs">
      <header className="vs-head">
        <button className="secondary" onClick={onClose}>← Back</button>
        <h2>Voice settings</h2>
        <div className="spacer" />
        <button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
      </header>
      {saved && <p className="vs-saved">Saved. New calls use this pipeline; calls already running keep theirs.</p>}
      {error && <p className="error">{error}</p>}
      {hasErrors && <p className="error">Fix the problems marked ✕ to save.</p>}
      {!data!.voiceEnabledInEnv && <p className="vs-warn">Voice is off on the server: set ENABLE_VOICE=true in .env (and start the voice worker: docker compose --profile voice up -d).</p>}

      <section className="vs-card">
        <h3>General</h3>
        <label className="vs-check"><input type="checkbox" checked={!!sel.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> AI voice assistant enabled</label>
        <label className="vs-field"><span>Greeting (spoken when the call starts)</span><input value={sel.greeting as string} onChange={(e) => set({ greeting: e.target.value })} maxLength={300} /></label>
      </section>

      <section className="vs-card">
        <h3>Voice activity detection (VAD)</h3>
        <div className="vs-grid">
          <Select label="Provider" value={sel.vad_provider as string} options={providerOptions(cat.vad)} onChange={(v) => set({ vad_provider: v })} hint={vad?.description} />
          {sel.vad_provider === "silero" && (
            <Select label="Preset" value={preset} options={[...Object.entries(cat.vad_presets).map(([k, p]) => [k, p.label] as [string, string]), ["custom", "Custom"]]}
              onChange={(k) => cat.vad_presets[k] && set(cat.vad_presets[k].values)} />
          )}
        </div>
        {vad && !vad.configured && <p className="vs-warn vs-issue">⚠ needs {vad.missing.join(", ")} in .env</p>}
        <div className="vs-grid"><Tunables p={vad} /></div>
        <Issues fields={["vad_provider"]} />
      </section>

      <section className="vs-card">
        <h3>Noise suppression</h3>
        <div className="vs-grid">
          <Select label="Provider" value={sel.noise_provider as string} options={providerOptions(cat.noise_cancellation)} onChange={(v) => set({ noise_provider: v })} hint={noise?.description} />
          <Tunables p={noise} />
        </div>
        <Issues fields={["noise_provider"]} />
      </section>

      <section className="vs-card">
        <h3>Turn detection</h3>
        <div className="vs-grid">
          <Select label="Model" value={sel.turn_detection as string} options={providerOptions(cat.turn_detection)} onChange={(v) => set({ turn_detection: v })} hint={turn?.description} />
          <Num name="min_endpointing_delay" f={cat.fields.min_endpointing_delay} value={sel.min_endpointing_delay as number} onChange={(v) => set({ min_endpointing_delay: v })} />
          <Num name="max_endpointing_delay" f={cat.fields.max_endpointing_delay} value={sel.max_endpointing_delay as number} onChange={(v) => set({ max_endpointing_delay: v })} />
        </div>
        <Issues fields={["turn_detection"]} />
      </section>

      <section className="vs-card">
        <h3>Speech-to-text (STT)</h3>
        <div className="vs-grid">
          <Select label="Provider" value={sel.stt_provider as string} options={providerOptions(cat.stt)} onChange={onStt} hint={stt?.description} />
          <Combo label="Model" value={sel.stt_model as string} options={modelsOf(stt)} custom={stt?.custom_model} onChange={onSttModel} />
          <Select label="Language" value={sel.stt_language as string} options={(sttInfo?.languages ?? [sel.stt_language as string]).map((l) => [l, l])} onChange={(v) => set({ stt_language: v })} />
          <Tunables p={stt} />
        </div>
        <Issues fields={["stt_provider"]} />
      </section>

      <section className="vs-card">
        <h3>Language model (LLM)</h3>
        <div className="vs-grid">
          <Select label="Provider" value={sel.llm_provider as string} options={providerOptions(cat.llm)} onChange={onLlm} hint={llm?.description} />
          <Combo label="Model" value={sel.llm_model as string} options={modelsOf(llm)} custom={llm?.custom_model} onChange={(v) => set({ llm_model: v })} />
          <Tunables p={llm} />
        </div>
        <Issues fields={["llm_provider"]} />
      </section>

      <section className="vs-card">
        <h3>Text-to-speech (TTS)</h3>
        <div className="vs-grid">
          <Select label="Provider" value={sel.tts_provider as string} options={providerOptions(cat.tts)} onChange={onTts} hint={tts?.description} />
          <Combo label="Model" value={sel.tts_model as string} options={modelsOf(tts)} custom={tts?.custom_model} onChange={onTtsModel} />
          <Combo label="Voice" value={sel.tts_voice_id as string} options={ttsInfo?.voices ?? []} custom={tts?.custom_voice} onChange={(v) => set({ tts_voice_id: v })} />
          {ttsInfo?.languages && <Select label="Language" value={sel.tts_language as string} options={ttsInfo.languages.map((l) => [l, l])} onChange={(v) => set({ tts_language: v })} />}
          <Tunables p={tts} />
        </div>
        <Issues fields={["tts_provider"]} />
      </section>
    </div>
  );
}
