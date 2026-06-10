#!/usr/bin/env python3
"""
Phase D / M1.2a spike — headless WAV comparator (pure stdlib).

Throwaway. Confirms the echo loop in sip_spike.py returns audio that
resembles what was played, without sox/ffmpeg/numpy. We cannot listen
in WSL2 (no audio device), so similarity has to be a number.

Usage:
  python3 agent/app/vera/bidi/compare_echo_wav.py <input.wav> <recv.wav>

What it does:
  1. Reads both WAVs (PCM16 mono; downmixes stereo if needed).
  2. Reports duration, sample count, RMS of each.
  3. Picks a high-energy 250 ms window from input as the correlation
     template (avoids leading silence).
  4. Brute-force scans recv for the offset where Pearson correlation
     with the template peaks. Search bounded to recv's first 2 s.
  5. Aligns at best offset and reports an SNR-like residual (in dB).
  6. Prints PASS / WEAK / FAIL with thresholds tuned for M1.2a.

This is a wiring sanity check, not a fidelity test. Correlation > ~0.7
means the RTP → SipMediaPort.onFrameReceived → asyncio.Queue →
_echo_loop → queue.Queue → SipMediaPort.onFrameRequested → RTP path
works end-to-end with no audio device involved.
"""
from __future__ import annotations

import array
import audioop
import math
import sys
import wave
from operator import mul
from pathlib import Path


# --- I/O ---------------------------------------------------------------

def read_pcm16_mono(path: Path) -> tuple[array.array, int]:
    with wave.open(str(path), "rb") as w:
        ch = w.getnchannels()
        sw = w.getsampwidth()
        rate = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
    if sw != 2:
        raise SystemExit(f"{path}: expected 16-bit PCM (sampwidth=2), got {sw}")
    samples = array.array("h")  # signed short, native byte order (LE on x86_64)
    samples.frombytes(raw)
    if ch == 2:
        mono = array.array("h", [(samples[i] + samples[i + 1]) // 2
                                  for i in range(0, len(samples), 2)])
        samples = mono
    elif ch != 1:
        raise SystemExit(f"{path}: unsupported channel count {ch}")
    return samples, rate


# --- metrics -----------------------------------------------------------

def resample_pcm16_mono(samples: array.array, in_rate: int, out_rate: int) -> array.array:
    """Resample PCM16 mono via audioop.ratecv. Used to align sample rates
    when input and recv come from different clock domains — e.g. the M1.2a
    Plan B run, where pjsua's recorder grabbed 16 kHz against an 8 kHz PCMA
    leg. Downsampling preserves information; upsampling adds none. The
    caller picks the direction."""
    if in_rate == out_rate:
        return samples
    raw = samples.tobytes()
    resampled, _ = audioop.ratecv(raw, 2, 1, in_rate, out_rate, None)
    out = array.array("h")
    out.frombytes(resampled)
    return out


def rms_normalized(samples) -> float:
    """RMS scaled to [0, 1] (full-scale = 32768)."""
    n = len(samples)
    if n == 0:
        return 0.0
    s = 0
    for v in samples:
        s += v * v
    return math.sqrt(s / n) / 32768.0


def first_energetic_window(samples, win_size: int) -> int:
    """Return the start index of the earliest window whose RMS is at least
    25% of the peak window RMS — i.e. the start of real signal, skipping
    any leading silence."""
    if len(samples) <= win_size:
        return 0
    step = max(1, win_size // 4)
    rms_by_idx: list[tuple[int, float]] = []
    peak = 0.0
    for i in range(0, len(samples) - win_size + 1, step):
        # Inline RMS for speed (avoids slicing).
        s = 0
        for k in range(win_size):
            v = samples[i + k]
            s += v * v
        r = math.sqrt(s / win_size)
        rms_by_idx.append((i, r))
        if r > peak:
            peak = r
    threshold = peak * 0.25
    for i, r in rms_by_idx:
        if r >= threshold:
            return i
    return 0


def best_offset(template, recv, max_offset: int) -> tuple[int, float]:
    """Pearson correlation scan: find the offset in [0, max_offset] where
    recv[off:off+W] best matches `template`. Uses cumulative sums of recv
    so window mean/variance are O(1); the cross-term remains the O(W) inner
    dot product. Total cost ~ max_offset * W floating-point ops."""
    W = len(template)
    n = len(recv)
    if W == 0 or n < W:
        return 0, 0.0

    # Centre the template once (mean-zero), pre-compute sum of squares.
    mx = sum(template) / W
    dx = array.array("d", (v - mx for v in template))
    sxx = sum(v * v for v in dx)
    if sxx == 0.0:
        return 0, 0.0  # template is silent; can't correlate

    # Cumulative sum & sum of squares of recv → O(1) window stats.
    cs = [0.0] * (n + 1)
    cs2 = [0.0] * (n + 1)
    for i, v in enumerate(recv):
        cs[i + 1] = cs[i] + v
        cs2[i + 1] = cs2[i] + v * v

    end = min(n - W + 1, max_offset + 1)
    best_off, best_corr = 0, -2.0
    for off in range(end):
        sum_y = cs[off + W] - cs[off]
        sum_y2 = cs2[off + W] - cs2[off]
        # syy = Σ (y - my)^2 = Σy^2 - (Σy)^2 / W
        syy = sum_y2 - (sum_y * sum_y) / W
        if syy <= 0.0:
            continue
        # Because dx has mean 0: Σ dx*(y-my) = Σ dx*y.
        sxy = sum(map(mul, dx, recv[off:off + W]))
        corr = sxy / math.sqrt(sxx * syy)
        if corr > best_corr:
            best_corr, best_off = corr, off
    return best_off, best_corr


def aligned_snr_db(input_samples, recv_samples, in_start: int, recv_start: int) -> tuple[int, float, float, float]:
    """Compute SNR-like residual over the region where input and recv align."""
    length = min(len(input_samples) - in_start, len(recv_samples) - recv_start)
    if length <= 0:
        return 0, 0.0, 0.0, float("-inf")
    a = input_samples[in_start:in_start + length]
    b = recv_samples[recv_start:recv_start + length]
    # Residual = input - recv, clipped to int16 range (only matters cosmetically).
    diff_sq = 0
    a_sq = 0
    for ai, bi in zip(a, b):
        d = ai - bi
        diff_sq += d * d
        a_sq += ai * ai
    a_rms = math.sqrt(a_sq / length) / 32768.0
    d_rms = math.sqrt(diff_sq / length) / 32768.0
    if d_rms == 0.0 or a_rms == 0.0:
        return length, a_rms, d_rms, float("inf") if d_rms == 0.0 else float("-inf")
    return length, a_rms, d_rms, 20 * math.log10(a_rms / d_rms)


# --- verdict -----------------------------------------------------------

def verdict_line(corr: float, recv_rms: float) -> tuple[str, int]:
    if recv_rms < 0.001:
        return ("FAIL: recv effectively silent (rms < 0.001) — echo path is not returning audio", 1)
    if corr >= 0.7:
        return (f"PASS: correlation {corr:.3f} >= 0.7 — echo returned the input audio", 0)
    if corr >= 0.3:
        return (f"WEAK: correlation {corr:.3f} (0.3–0.7) — audio came back but distorted/partial; inspect spike logs", 0)
    return (f"FAIL: correlation {corr:.3f} < 0.3 — recv does not resemble input", 1)


# --- main --------------------------------------------------------------

def main() -> None:
    if len(sys.argv) != 3:
        print("usage: compare_echo_wav.py <input.wav> <recv.wav>", file=sys.stderr)
        sys.exit(2)
    in_path = Path(sys.argv[1])
    recv_path = Path(sys.argv[2])

    in_samples, in_rate = read_pcm16_mono(in_path)
    recv_samples, recv_rate = read_pcm16_mono(recv_path)
    if in_rate != recv_rate:
        # Align rates before correlating. Comparing 16k vs 8k raw would give
        # a meaningless Pearson even if the audio is identical, so downsample
        # the higher-rate track to the lower-rate one (no fabricated samples).
        target_rate = min(in_rate, recv_rate)
        print(f"sample rate mismatch: input={in_rate}Hz recv={recv_rate}Hz "
              f"→ downsampling to {target_rate}Hz before correlation")
        if in_rate > target_rate:
            in_samples = resample_pcm16_mono(in_samples, in_rate, target_rate)
            in_rate = target_rate
        if recv_rate > target_rate:
            recv_samples = resample_pcm16_mono(recv_samples, recv_rate, target_rate)
            recv_rate = target_rate
    rate = in_rate

    in_rms = rms_normalized(in_samples)
    recv_rms = rms_normalized(recv_samples)
    print(f"input : {in_path}")
    print(f"  rate={rate}Hz  samples={len(in_samples)}  duration={len(in_samples)/rate:.3f}s  rms={in_rms:.4f}")
    print(f"recv  : {recv_path}")
    print(f"  rate={rate}Hz  samples={len(recv_samples)}  duration={len(recv_samples)/rate:.3f}s  rms={recv_rms:.4f}")

    if not recv_samples:
        print("FAIL: recv has zero samples")
        sys.exit(1)

    win_size = min(len(in_samples), int(rate * 0.25))  # 250 ms template
    template_start = first_energetic_window(in_samples, win_size)
    template = in_samples[template_start:template_start + win_size]
    print(f"template: input[{template_start}:{template_start + win_size}]"
          f" ({template_start * 1000 / rate:.0f} ms in, {win_size * 1000 / rate:.0f} ms long)")

    # Echo lag bound: real call-setup latency + bridge wiring is well under 2 s.
    max_offset = min(len(recv_samples) - win_size, rate * 2)
    if max_offset <= 0:
        print("FAIL: recv is shorter than the correlation window")
        sys.exit(1)

    print(f"scanning recv offsets 0..{max_offset} (~{max_offset * 1000 / rate:.0f} ms) ...", flush=True)
    off, corr = best_offset(template, recv_samples, max_offset)
    template_time_ms = template_start * 1000 / rate
    recv_time_ms = off * 1000 / rate
    print(f"best match : recv sample {off}  ({recv_time_ms:.1f} ms into recv)")
    print(f"  echo lag (recv_t - template_t): {recv_time_ms - template_time_ms:.1f} ms")
    print(f"  Pearson at peak              : {corr:.4f}")

    length, a_rms, d_rms, snr_db = aligned_snr_db(in_samples, recv_samples, template_start, off)
    if length > 0:
        snr_str = "inf" if snr_db == float("inf") else f"{snr_db:.1f} dB"
        print(f"  aligned region               : {length} samples ({length / rate:.3f}s)")
        print(f"  input_rms={a_rms:.4f}  diff_rms={d_rms:.4f}  ~SNR={snr_str}")

    line, code = verdict_line(corr, recv_rms)
    print()
    print(line)
    sys.exit(code)


if __name__ == "__main__":
    main()
