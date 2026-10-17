"""Smoke test: build every STT / LLM / TTS / VAD / noise / turn-detection option from backend/config/voice.yaml with dummy
credentials. Catches wrong constructor arguments and catalog/factory id mismatches without network access or real keys.

    .venv/Scripts/python tests/build_all.py        (from voice-agent/)
"""
import asyncio
import json
import os
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# dummy credentials for every env var named in the catalog
CAT = yaml.safe_load((Path(__file__).resolve().parents[2] / "backend" / "config" / "voice.yaml").read_text(encoding="utf8"))
for table in ("vad", "noise_cancellation", "turn_detection", "stt", "llm", "tts"):
    for p in CAT[table].values():
        for name in p.get("env", []) + [e for g in p.get("env_any", []) for e in g]:
            os.environ.setdefault(name, "dummy")
os.environ["LLM_BASE_URL"] = "http://localhost:4000"
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = json.dumps({
    "type": "service_account", "project_id": "x", "private_key_id": "x", "client_email": "x@x.iam.gserviceaccount.com", "client_id": "1",
    "private_key": "-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAu0\n-----END PRIVATE KEY-----\n",
})

from livekit.agents import utils  # noqa: E402

from src import factories  # noqa: E402

D = CAT["defaults"]
base = dict(D)
base.update({k: v["default"] for k, v in CAT["fields"].items()})

failures: list[str] = []


def attempt(label: str, fn):
    try:
        fn()
        print(f"PASS  {label}")
    except Exception as e:  # noqa: BLE001
        failures.append(label)
        print(f"FAIL  {label}: {type(e).__name__}: {str(e)[:200]}")


async def main() -> None:
    # the plugins need a running event loop / http context for some constructors
    for pid, p in CAT["stt"].items():
        for model, m in p["models"].items():
            sel = {**base, "stt_provider": pid, "stt_model": model, "stt_language": m["languages"][0]}
            attempt(f"stt {pid}/{model}", lambda sel=sel: factories.build_stt(sel))
    for pid, p in CAT["llm"].items():
        for model in p["models"]:
            sel = {**base, "llm_provider": pid, "llm_model": model}
            attempt(f"llm {pid}/{model}", lambda sel=sel: factories.build_llm(sel))
    for pid, p in CAT["tts"].items():
        for model, m in p["models"].items():
            sel = {**base, "tts_provider": pid, "tts_model": model, "tts_voice_id": m["voices"][0], "tts_language": (m.get("languages") or [""])[0]}
            attempt(f"tts {pid}/{model}", lambda sel=sel: factories.build_tts(sel))

    for pid in CAT["vad"]:
        sel = {**base, "vad_provider": pid}
        try:
            vad, proc = await factories.build_vad(sel)
            print(f"PASS  vad {pid} -> {type(vad).__name__ if vad else None}")
        except Exception as e:  # noqa: BLE001
            failures.append(f"vad {pid}")
            print(f"FAIL  vad {pid}: {type(e).__name__}: {str(e)[:200]}")
    for pid in CAT["noise_cancellation"]:
        sel = {**base, "noise_provider": pid}
        try:
            proc = await factories.build_noise(sel)
            print(f"PASS  noise {pid} -> {type(proc).__name__ if proc else None}")
        except Exception as e:  # noqa: BLE001
            failures.append(f"noise {pid}")
            print(f"FAIL  noise {pid}: {type(e).__name__}: {str(e)[:200]}")
    for pid in CAT["turn_detection"]:
        sel = {**base, "turn_detection": pid, "stt_provider": "deepgram-flux" if pid == "stt" else base["stt_provider"]}
        try:
            print(f"PASS  turn {pid} -> {type(factories.build_turn_detection(sel, has_vad=True)).__name__}")
        except RuntimeError as e:
            if "no job context" in str(e):  # the LiveKit turn-detector models only load inside a running job
                print(f"SKIP  turn {pid}: needs a job context (checked when the worker runs)")
            else:
                failures.append(f"turn {pid}"); print(f"FAIL  turn {pid}: {e}")


if __name__ == "__main__":
    utils.http_context._new_session_ctx  # noqa: B018  (import check only)
    asyncio.run(main())
    print(f"\n{len(failures)} failure(s)")
    sys.exit(1 if failures else 0)
