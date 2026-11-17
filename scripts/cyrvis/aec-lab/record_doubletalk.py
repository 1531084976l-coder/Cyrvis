"""
Record a real double-talk sample: AI TTS on Realtek speakers + user speaking
into the Bluetooth headset mic at the same time.

Run:
  python record_doubletalk.py

It records 12s. After 1s the TTS starts. Speak over it, for example:
  "停一下，别说了，帮我打开记事本"
"""

from __future__ import annotations

import argparse
import subprocess
import time
import winsound
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf

ROOT = Path(__file__).resolve().parents[4]
DEFAULT_FAR = Path("D:/temp/tts-probe.wav")
OUT_DIR = ROOT / "models" / "voiceprint"
SR = 16000


def load16(path: Path) -> np.ndarray:
    audio, rate = sf.read(str(path), dtype="float32")
    if audio.ndim > 1:
        audio = audio[:, 0]
    if rate != SR:
        count = int(len(audio) * SR / rate)
        audio = np.interp(
            np.linspace(0, len(audio) - 1, count),
            np.arange(len(audio)),
            audio,
        ).astype(np.float32)
    return audio


def pick_device(pattern: str | None) -> int:
    devices = [
        (index, device)
        for index, device in enumerate(sd.query_devices())
        if device["max_input_channels"] > 0
    ]
    if pattern:
        for index, device in devices:
            if pattern.lower() in device["name"].lower():
                return index
        raise SystemExit(f"no input device matching {pattern!r}")
    for wanted in ("cc ultimate", "airpods", "headset", "耳机", "麦克风"):
        for index, device in devices:
            if wanted.lower() in device["name"].lower() and "todesk" not in device["name"].lower():
                return index
    for index, device in devices:
        if "todesk" not in device["name"].lower():
            return index
    raise SystemExit("no physical input device")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--far", default=str(DEFAULT_FAR))
    parser.add_argument("--device", help="input device name substring")
    parser.add_argument("--seconds", type=float, default=12.0)
    args = parser.parse_args()

    far_path = Path(args.far)
    if not far_path.exists():
        raise SystemExit(f"far WAV not found: {far_path}")

    # Make sure the external speaker is the default playback device.
    script = ROOT / "scripts" / "cyrvis" / "audio" / "set-default-output.ps1"
    if script.exists():
        subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(script),
                "-Kind",
                "speaker",
            ],
            check=False,
        )

    device = pick_device(args.device)
    info = sd.query_devices(device)
    rate = int(info["default_samplerate"] or 16000)
    if rate not in (16000, 44100, 48000):
        rate = 16000

    print("1 秒后开始录音并播放 AI 声音。", flush=True)
    print("请在播放过程中同时说：停一下，别说了，帮我打开记事本。", flush=True)
    time.sleep(1)

    recording = sd.rec(
        int(args.seconds * rate),
        samplerate=rate,
        channels=1,
        dtype="int16",
        device=device,
    )
    # Play the TTS after 1s of recording so the onset is easy to find.
    time.sleep(1.0)
    winsound.PlaySound(str(far_path), winsound.SND_FILENAME | winsound.SND_ASYNC)
    sd.wait()
    print("录音结束", flush=True)

    mic = recording[:, 0].astype(np.float32) / 32768.0
    if rate != SR:
        count = int(len(mic) * SR / rate)
        mic = np.interp(
            np.linspace(0, len(mic) - 1, count),
            np.arange(len(mic)),
            mic,
        ).astype(np.float32)

    far = load16(far_path)
    far_aligned = np.zeros(len(mic), dtype=np.float32)
    # The TTS starts ~1s after recording; pad the reference to the same offset.
    start = int(1.0 * SR)
    far_aligned[start : start + len(far)] = far[: max(0, len(far_aligned) - start)]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    sf.write(OUT_DIR / "doubletalk.wav", mic, SR, subtype="PCM_16")
    sf.write(OUT_DIR / "doubletalk-far.wav", far_aligned, SR, subtype="PCM_16")
    print("saved:", OUT_DIR / "doubletalk.wav")
    print("saved:", OUT_DIR / "doubletalk-far.wav")


if __name__ == "__main__":
    main()
