#!/usr/bin/env python3
"""
text → WAV PCM16 mono 8 kHz.

Generates synthetic-voice inputs for testing the gateway's audio path.
Two backends:

    piper   (default)  — neural TTS, much more intelligible than espeak.
                         Requires the `piper` CLI on PATH and an ONNX voice
                         model. Default model:
                             <repo>/tmp/spike-audio/piper-voices/es_MX-ald-medium.onnx
                         Override with env var VERA_PIPER_MODEL=/path/to/voice.onnx
    espeak             — formant synth via espeak-ng on PATH. Keeps working
                         for parity / fallback.

Both backends write their native-rate WAV to a tempfile and the same
audioop resample step downsamples to 8 kHz so pjsua --play-file feeds the
SIP leg at the negotiated PCMA/PCMU rate without an extra resample.

Install hints:
    piper:    pip install piper-tts
    espeak:   sudo apt install -y espeak-ng

Usage:
    python3 agent/app/vera/bidi/synth_speech_wav.py "<text>" <out.wav> \\
        [--backend {piper,espeak}] [--voice es-419] [--speed 145]

Example (banking happy path, piper):
    python3 agent/app/vera/bidi/synth_speech_wav.py \\
        "Hola, quiero pedir un préstamo. Mi D N I es tres uno dos tres cuatro cinco seis siete." \\
        tmp/spike-audio/dni-8k.wav
"""
from __future__ import annotations

import argparse
import audioop
import os
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

TARGET_RATE = 8000  # PCMA / PCMU clock rate; matches the SIP leg

# Repo root derived from this file's location, not CWD — the script is
# invoked from varying working directories.
_REPO_ROOT = Path(__file__).resolve().parents[4]
_DEFAULT_PIPER_MODEL = _REPO_ROOT / "tmp/spike-audio/piper-voices/es_MX-ald-medium.onnx"


def _resolve_piper_model() -> Path:
    env = os.environ.get("VERA_PIPER_MODEL")
    if env:
        p = Path(env)
        if not p.is_file():
            raise SystemExit(
                f"VERA_PIPER_MODEL points to {p}, which is not a file."
            )
        return p
    if not _DEFAULT_PIPER_MODEL.is_file():
        raise SystemExit(
            f"piper model not found at {_DEFAULT_PIPER_MODEL}. "
            f"Set VERA_PIPER_MODEL=/path/to/voice.onnx to override."
        )
    return _DEFAULT_PIPER_MODEL


def _synth_espeak(text: str, tmp_wav: Path, voice: str, speed: int) -> None:
    if not shutil.which("espeak-ng"):
        raise SystemExit(
            "espeak-ng not found on PATH. Install with: sudo apt install -y espeak-ng"
        )
    cmd = [
        "espeak-ng",
        "-v", voice,
        "-s", str(speed),
        "-p", "50",
        "-w", str(tmp_wav),
        text,
    ]
    print(f"espeak-ng: {' '.join(cmd[:-1])} <text>", file=sys.stderr)
    subprocess.run(cmd, check=True, capture_output=True)


def _synth_piper(text: str, tmp_wav: Path) -> None:
    if not shutil.which("piper"):
        raise SystemExit(
            "piper not found on PATH. Install with `pip install piper-tts` "
            "and set VERA_PIPER_MODEL to a valid .onnx voice model path."
        )
    model = _resolve_piper_model()
    cmd = ["piper", "-m", str(model), "-f", str(tmp_wav)]
    print(f"piper: {' '.join(cmd)} <text>", file=sys.stderr)
    try:
        subprocess.run(
            cmd,
            input=text,
            text=True,
            capture_output=True,
            check=True,
        )
    except subprocess.CalledProcessError as e:
        # Surface piper's stderr; do not swallow.
        sys.stderr.write(e.stderr or "")
        raise SystemExit(f"piper failed with exit code {e.returncode}") from e


def _resample_to_8k(tmp_wav: Path, out_path: Path) -> int:
    with wave.open(str(tmp_wav), "rb") as r:
        sw = r.getsampwidth()
        ch = r.getnchannels()
        rate = r.getframerate()
        raw = r.readframes(r.getnframes())

    if sw != 2 or ch != 1:
        raise SystemExit(
            f"backend produced unexpected format: {sw*8}-bit {ch}-ch @ {rate}Hz "
            f"(expected 16-bit mono). Refusing to downmix silently."
        )

    out, _ = audioop.ratecv(raw, sw, ch, rate, TARGET_RATE, None)

    with wave.open(str(out_path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TARGET_RATE)
        w.writeframes(out)

    return len(out) // 2


def synth(
    text: str,
    out_path: Path,
    voice: str = "es-419",
    speed: int = 145,
    backend: str = "piper",
) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = Path(tmp.name)

    try:
        if backend == "piper":
            _synth_piper(text, tmp_path)
        elif backend == "espeak":
            _synth_espeak(text, tmp_path, voice, speed)
        else:
            raise SystemExit(f"unknown backend: {backend}")

        samples = _resample_to_8k(tmp_path, out_path)
    finally:
        tmp_path.unlink(missing_ok=True)

    print(f"wrote {out_path}: {samples} samples @ {TARGET_RATE} Hz "
          f"({samples / TARGET_RATE:.2f}s)")


def main() -> None:
    p = argparse.ArgumentParser(
        description="Synthesize speech to PCM16 mono 8 kHz WAV (piper or espeak-ng).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Usage:")[1] if "Usage:" in (__doc__ or "") else "",
    )
    p.add_argument("text", help="Text to synthesize.")
    p.add_argument("out", type=Path, help="Output WAV path.")
    p.add_argument("--backend", choices=["piper", "espeak"], default="piper",
                   help="TTS backend (default: piper).")
    p.add_argument("--voice", default="es-419",
                   help="espeak-ng voice (espeak backend only; default: es-419).")
    p.add_argument("--speed", type=int, default=145,
                   help="espeak-ng speech rate WPM (espeak backend only; default: 145).")
    args = p.parse_args()
    synth(args.text, args.out, args.voice, args.speed, args.backend)


if __name__ == "__main__":
    main()
