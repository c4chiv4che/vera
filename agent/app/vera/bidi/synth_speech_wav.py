#!/usr/bin/env python3
"""
Phase D / M1.2b spike — text → WAV PCM16 mono 8 kHz, via espeak-ng + audioop.

Throwaway. Generates the synthetic-voice inputs for M1.2b (banking) and
M1.2c (salud) tests. espeak-ng writes WAV PCM16 mono at 22050 Hz; we
resample to 8 kHz with audioop so pjsua --play-file feeds the SIP leg
at the negotiated PCMA/PCMU codec rate without an extra resample step.

Requires espeak-ng on PATH:
    sudo apt install -y espeak-ng

Usage:
    python3 agent/app/vera/bidi/synth_speech_wav.py "<text>" <out.wav> \\
        [--voice es-419] [--speed 145]

Example (M1.2b banking happy path):
    python3 agent/app/vera/bidi/synth_speech_wav.py \\
        "Hola, quiero pedir un préstamo. Mi D N I es tres uno dos tres cuatro cinco seis siete." \\
        tmp/spike-audio/dni-8k.wav
"""
from __future__ import annotations

import argparse
import audioop
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

TARGET_RATE = 8000  # PCMA / PCMU clock rate; matches the SIP leg


def synth(text: str, out_path: Path, voice: str = "es-419", speed: int = 145) -> None:
    if not shutil.which("espeak-ng"):
        raise SystemExit(
            "espeak-ng not found on PATH. Install with: sudo apt install -y espeak-ng"
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = Path(tmp.name)

    try:
        cmd = [
            "espeak-ng",
            "-v", voice,
            "-s", str(speed),
            "-p", "50",
            "-w", str(tmp_path),
            text,
        ]
        # Log the espeak invocation for reproducibility — anyone re-running
        # this spike from logs can replay the exact synth.
        print(f"espeak-ng: {' '.join(cmd[:-1])} <text>", file=sys.stderr)
        subprocess.run(cmd, check=True, capture_output=True)

        with wave.open(str(tmp_path), "rb") as r:
            sw = r.getsampwidth()
            ch = r.getnchannels()
            rate = r.getframerate()
            raw = r.readframes(r.getnframes())

        if sw != 2 or ch != 1:
            raise SystemExit(
                f"espeak-ng produced unexpected format: {sw*8}-bit {ch}-ch @ {rate}Hz "
                f"(expected 16-bit mono). Refusing to downmix silently."
            )

        out, _ = audioop.ratecv(raw, sw, ch, rate, TARGET_RATE, None)

        with wave.open(str(out_path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(TARGET_RATE)
            w.writeframes(out)

    finally:
        tmp_path.unlink(missing_ok=True)

    samples = len(out) // 2
    print(f"wrote {out_path}: {samples} samples @ {TARGET_RATE} Hz "
          f"({samples / TARGET_RATE:.2f}s)")


def main() -> None:
    p = argparse.ArgumentParser(
        description="Synthesize speech to PCM16 mono 8 kHz WAV (espeak-ng + audioop).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Usage:")[1] if "Usage:" in (__doc__ or "") else "",
    )
    p.add_argument("text", help="Text to synthesize.")
    p.add_argument("out", type=Path, help="Output WAV path.")
    p.add_argument("--voice", default="es-419",
                   help="espeak-ng voice (default: es-419, Spanish Latin America).")
    p.add_argument("--speed", type=int, default=145,
                   help="Speech rate in words per minute (default: 145; espeak default is 175).")
    args = p.parse_args()
    synth(args.text, args.out, args.voice, args.speed)


if __name__ == "__main__":
    main()
