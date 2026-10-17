"""Builds the voice pipeline components chosen in the console (Voice settings).

`sel` is the normalised selection from the backend (backend/src/voice/catalog.ts). Provider ids and env var names
here must match backend/config/voice.yaml. Provider wiring follows AXLAI voicekit (src/services/*_service.py).
"""
import asyncio
import json
import os
from pathlib import Path
from typing import Any

from livekit.plugins import azure, deepgram, elevenlabs, google, murf, neuphonic, openai, silero
from livekit.plugins.turn_detector import english, multilingual

from .cue_turn_detector import CueTurnDetector
from .log import setup_logger

try:  # optional: needs AIC_SDK_LICENSE at runtime
    from livekit.plugins import ai_coustics
except Exception:  # pragma: no cover
    ai_coustics = None
try:
    from livekit.plugins import dtln
except Exception:  # pragma: no cover
    dtln = None
try:  # cartesia comes with livekit-agents[cartesia]
    from livekit.plugins import cartesia
except Exception:  # pragma: no cover
    cartesia = None

logger = setup_logger("factories")


class PipelineError(Exception):
    """The chosen provider can't be built (missing key, unknown id). Reported once; the call falls back or ends."""


def _need(*names: str) -> None:
    missing = [n for n in names if not os.getenv(n)]
    if missing:
        raise PipelineError(f"missing environment variable(s): {', '.join(missing)}")


def _llm_base_url() -> str:
    """LiteLLM / any OpenAI-compatible endpoint, with or without /v1 (same rule as backend/src/ai/llm.ts)."""
    _need("LLM_BASE_URL")
    raw = os.environ["LLM_BASE_URL"].rstrip("/")
    return raw if raw.split("/")[-1].startswith("v") and raw.split("/")[-1][1:].isdigit() else f"{raw}/v1"


def _azure_speech() -> dict[str, Any]:
    _need("AZURE_SPEECH_API_KEY")
    if os.getenv("AZURE_SPEECH_ENDPOINT"):
        return {"speech_endpoint": os.environ["AZURE_SPEECH_ENDPOINT"], "speech_key": os.environ["AZURE_SPEECH_API_KEY"]}
    _need("AZURE_SPEECH_REGION")
    return {"speech_region": os.environ["AZURE_SPEECH_REGION"], "speech_key": os.environ["AZURE_SPEECH_API_KEY"]}


def _azure_openai(suffix: str = "") -> dict[str, Any]:
    """Azure OpenAI endpoint + key. For STT/TTS an optional *_TTS pair overrides the shared one (as in AXLAI)."""
    endpoint = (os.getenv(f"AZURE_OPENAI_ENDPOINT{suffix}") if suffix else None) or os.getenv("AZURE_OPENAI_ENDPOINT")
    key = (os.getenv(f"AZURE_OPENAI_API_KEY{suffix}") if suffix else None) or os.getenv("AZURE_OPENAI_API_KEY")
    if not endpoint or not key:
        raise PipelineError("missing AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY")
    return {"azure_endpoint": endpoint, "api_key": key}


def _google_credentials() -> dict[str, Any]:
    """GOOGLE_APPLICATION_CREDENTIALS may be the service-account JSON itself or a path to it."""
    _need("GOOGLE_APPLICATION_CREDENTIALS")
    value = os.environ["GOOGLE_APPLICATION_CREDENTIALS"].strip()
    return {"credentials_info": json.loads(value)} if value.startswith("{") else {"credentials_file": value}


# --- VAD / noise suppression ----------------------------------------------------------------------------------------

AIC_MODEL_DIR = os.getenv("AIC_MODEL_DIR") or str(Path(__file__).resolve().parents[1] / ".cache" / "ai-coustics")
_aic_models: dict[str, Any] = {}


def _aic_license() -> str | None:
    key = os.getenv("AIC_SDK_LICENSE")
    if not key:
        logger.warning("ai-coustics selected but AIC_SDK_LICENSE is not set; skipping it.")
    return key


async def _aic_model(model_id: str):
    if model_id in _aic_models:
        return _aic_models[model_id]

    def load():
        stem = model_id.replace("-", "_").replace(".", "_") + "_"
        try:
            local = next((n for n in sorted(os.listdir(AIC_MODEL_DIR)) if n.startswith(stem) and n.endswith(".aicmodel")), None)
        except OSError:
            local = None
        path = os.path.join(AIC_MODEL_DIR, local) if local else ai_coustics.Model.download(model_id, AIC_MODEL_DIR)
        return ai_coustics.Model.from_file(path)

    _aic_models[model_id] = await asyncio.to_thread(load)
    return _aic_models[model_id]


async def build_vad(sel: dict[str, Any]):
    """Returns (vad | None, frame_processor | None). The ai-coustics VAD infers inside the audio input path."""
    provider = sel["vad_provider"]
    if provider == "none":
        return None, None

    if provider == "ai-coustics":
        if ai_coustics is None:
            logger.warning("ai-coustics plugin is not installed; falling back to Silero VAD.")
        elif _aic_license():
            model_id = os.getenv("AIC_VAD_MODEL", "vad-2.1-xxs-16khz")
            try:
                vad = ai_coustics.VAD(
                    model=await _aic_model(model_id),
                    license_key=os.environ["AIC_SDK_LICENSE"],
                    vad_parameters=ai_coustics.VADParameters(),
                    prefix_padding_duration=sel["vad_prefix_padding_duration"],
                )
                logger.info("VAD: ai-coustics (%s)", model_id)
                return vad, vad.processor
            except Exception:
                logger.exception("could not start the ai-coustics VAD; falling back to Silero VAD.")

    vad = await asyncio.to_thread(
        lambda: silero.VAD.load(
            activation_threshold=sel["vad_activation_threshold"],
            min_silence_duration=sel["vad_min_silence_duration"],
            min_speech_duration=sel["vad_min_speech_duration"],
            prefix_padding_duration=sel["vad_prefix_padding_duration"],
            force_cpu=True,
        )
    )
    logger.info("VAD: silero")
    return vad, None


async def build_noise(sel: dict[str, Any]):
    """The noise-suppression frame processor, or None (off or unavailable)."""
    provider = sel["noise_provider"]
    if provider == "dtln":
        if dtln is None:
            logger.warning("livekit-plugins-dtln is not installed; noise suppression is off.")
            return None
        logger.info("noise suppression: DTLN strength=%s", sel["noise_strength"])
        return dtln.noise_suppression(strength=sel["noise_strength"])
    if provider == "ai-coustics":
        if ai_coustics is None or not _aic_license():
            return None
        model_id = os.getenv("AIC_NOISE_MODEL", "quail-l-16khz")
        try:
            processor = ai_coustics.Processor(model=await _aic_model(model_id), license_key=os.environ["AIC_SDK_LICENSE"])
        except Exception:
            logger.exception("could not start ai-coustics enhancement; noise suppression is off.")
            return None
        logger.info("noise suppression: ai-coustics (%s)", model_id)
        return processor
    return None


def combine_frame_processors(processors: list[Any]):
    processors = [p for p in processors if p is not None]
    if not processors:
        return None
    if len(processors) == 1:
        return processors[0]
    return ai_coustics.FrameProcessorChain(*processors)


# --- turn detection --------------------------------------------------------------------------------------------------

def build_turn_detection(sel: dict[str, Any], has_vad: bool):
    mode = sel["turn_detection"]
    if mode in ("multilingual", "english", "cue", "vad") and not has_vad:
        logger.warning("turn detection '%s' needs a VAD; using STT end-of-turn if available, else silence-based.", mode)
        return "stt" if sel["stt_provider"] == "deepgram-flux" else "vad"
    if mode == "stt" and sel["stt_provider"] != "deepgram-flux":
        logger.warning("turn detection 'stt' needs Deepgram Flux; using the multilingual model.")
        mode = "multilingual"
    if mode == "multilingual":
        return multilingual.MultilingualModel()
    if mode == "english":
        return english.EnglishModel()
    if mode == "cue":
        return CueTurnDetector()
    return mode  # "stt" | "vad"


# --- STT -------------------------------------------------------------------------------------------------------------

def build_stt(sel: dict[str, Any]):
    p, model, lang = sel["stt_provider"], sel["stt_model"], sel["stt_language"]
    if p == "openai-compatible":
        _need("LLM_API_KEY")
        multi = lang == "multi"
        kwargs = {} if multi else {"language": lang}
        return openai.STT(model=model, base_url=_llm_base_url(), api_key=os.environ["LLM_API_KEY"], detect_language=multi, **kwargs)
    if p == "deepgram":
        _need("DEEPGRAM_API_KEY")
        cfg: dict[str, Any] = {
            "api_key": os.environ["DEEPGRAM_API_KEY"], "model": model, "language": lang, "sample_rate": 16000,
            "smart_format": True, "numerals": True, "endpointing_ms": sel["stt_endpointing_ms"],
        }
        if os.getenv("DEEPGRAM_API_BASE_URL"):
            cfg.update(base_url=f"{os.environ['DEEPGRAM_API_BASE_URL']}/v1/listen", mip_opt_out=True)
        return deepgram.STT(**cfg)
    if p == "deepgram-flux":
        _need("DEEPGRAM_API_KEY")
        cfg = {
            "api_key": os.environ["DEEPGRAM_API_KEY"], "model": model, "sample_rate": 16000,
            "eot_threshold": sel["stt_eot_threshold"], "eot_timeout_ms": sel["stt_eot_timeout_ms"],
        }
        if os.getenv("DEEPGRAM_API_BASE_URL"):
            cfg.update(base_url=f"{os.environ['DEEPGRAM_API_BASE_URL']}/v2/listen", mip_opt_out=True)
        return deepgram.STTv2(**cfg)
    if p == "azure":
        return azure.STT(language=lang, **_azure_speech())
    if p == "azure-openai":
        return openai.STT.with_azure(
            azure_deployment=model, language="en" if lang == "multi" else lang, detect_language=lang == "multi",
            api_version=os.getenv("AZURE_OPENAI_API_VERSION_STT", "2025-03-01-preview"), **_azure_openai("_TTS"),
        )
    raise PipelineError(f"unknown STT provider '{p}'")


# --- LLM -------------------------------------------------------------------------------------------------------------

def build_llm(sel: dict[str, Any]):
    p, model = sel["llm_provider"], sel["llm_model"]
    common = {"temperature": sel["temperature"], "max_completion_tokens": int(sel["max_tokens"])}
    if p == "openai-compatible":
        _need("LLM_API_KEY")
        return openai.LLM(model=model, base_url=_llm_base_url(), api_key=os.environ["LLM_API_KEY"], **common)
    if p == "openai":
        _need("OPENAI_API_KEY")
        return openai.LLM(model=model, api_key=os.environ["OPENAI_API_KEY"], **common)
    if p == "azure-openai":
        return openai.LLM.with_azure(
            azure_deployment=model, api_version=os.getenv("AZURE_OPENAI_API_VERSION", "2025-01-01-preview"), **_azure_openai(), **common,
        )
    raise PipelineError(f"unknown LLM provider '{p}'")


# --- TTS -------------------------------------------------------------------------------------------------------------

def _openai_tts_format() -> dict[str, Any]:
    """OpenAI-style TTS audio format. mp3 is the plugin default; "pcm" skips decoding (lower latency) where the endpoint supports it."""
    fmt = os.getenv("OPENAI_TTS_RESPONSE_FORMAT")
    return {"response_format": fmt} if fmt else {}


def build_tts(sel: dict[str, Any]):
    p, model, voice, lang, speed = sel["tts_provider"], sel["tts_model"], sel["tts_voice_id"], sel["tts_language"], sel["speech_speed"]
    if p == "openai-compatible":
        _need("LLM_API_KEY")
        return openai.TTS(model=model, voice=voice, speed=speed, base_url=_llm_base_url(), api_key=os.environ["LLM_API_KEY"], **_openai_tts_format())
    if p == "openai":
        _need("OPENAI_API_KEY")
        return openai.TTS(model=model, voice=voice, speed=speed, api_key=os.environ["OPENAI_API_KEY"], **_openai_tts_format())
    if p == "azure-openai":
        return openai.TTS.with_azure(
            azure_deployment=model, voice=voice, speed=speed,
            api_version=os.getenv("AZURE_OPENAI_API_VERSION_TTS", "2025-03-01-preview"), **_azure_openai("_TTS"), **_openai_tts_format(),
        )
    if p == "11labs":
        _need("ELEVENLABS_API_KEY")
        cfg: dict[str, Any] = {
            "api_key": os.environ["ELEVENLABS_API_KEY"], "model": model, "voice_id": voice,
            "voice_settings": elevenlabs.VoiceSettings(stability=0.5, similarity_boost=0.5, speed=speed),
        }
        if os.getenv("ELEVENLABS_API_BASE_URL"):
            cfg["base_url"] = os.environ["ELEVENLABS_API_BASE_URL"]
        return elevenlabs.TTS(**cfg)
    if p == "azure":
        return azure.TTS(voice=voice, language=lang or None, **_azure_speech())
    if p == "cartesia":
        _need("CARTESIA_API_KEY")
        if cartesia is None:
            raise PipelineError("the cartesia plugin is not installed")
        cfg = {"api_key": os.environ["CARTESIA_API_KEY"], "model": model, "voice": voice, "language": lang or "en"}
        if os.getenv("CARTESIA_API_BASE_URL"):
            cfg["base_url"] = os.environ["CARTESIA_API_BASE_URL"]
        return cartesia.TTS(**cfg)
    if p == "neuphonic":
        _need("NEUPHONIC_API_KEY")
        return neuphonic.TTS(api_key=os.environ["NEUPHONIC_API_KEY"], voice_id=voice, speed=speed)
    if p == "murf":
        _need("MURF_API_KEY")
        cfg = {"api_key": os.environ["MURF_API_KEY"], "model": model, "voice": voice, "locale": lang or None}
        if os.getenv("MURF_API_BASE_URL"):
            cfg["base_url"] = os.environ["MURF_API_BASE_URL"]
        return murf.TTS(**cfg)
    if p == "gemini":
        _need("GOOGLE_API_KEY")
        return google.beta.GeminiTTS(api_key=os.environ["GOOGLE_API_KEY"], model=model, voice_name=voice)
    if p == "google":
        return google.TTS(language=lang or "en-US", voice_name=voice, speaking_rate=speed, use_streaming=True, **_google_credentials())
    raise PipelineError(f"unknown TTS provider '{p}'")
