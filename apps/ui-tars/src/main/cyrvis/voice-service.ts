/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow, globalShortcut, ipcMain } from 'electron';

import * as env from '@main/env';
import { logger } from '@main/logger';

import { startCaptureService, type CaptureService } from './capture-service';
import { CyrvisController } from './controller';
import { ElectronGUIAdapter } from './gui-adapter';
import { QwenOmniProvider } from './voice/qwen-omni';
import { VoiceBrain, type VoiceBrainState } from './voice-brain';
import type { ControllerEvent } from './types';

interface VoiceService {
  brain: VoiceBrain;
  provider: QwenOmniProvider;
  controller: CyrvisController;
}

let service: VoiceService | null = null;
let captureService: CaptureService | null = null;
let captureReady = false;
let captureGeneration = 0;
let captureRetryTimer: ReturnType<typeof setTimeout> | null = null;
let captureRetryAttempts = 0;
let assistantPlaybackActive = false;
let captureBargeMs = 0;
let capturePreroll: Int16Array[] = [];
let lastCaptureLogAt = 0;
// Two selectable audio modes:
// - headset: capture without AEC + voice barge-in (verified)
// - speaker: external output + voice barge-in with a higher energy threshold.
//   The capture renderer has no AEC reference, so raw mic + threshold is used;
//   a short post-playback guard only absorbs reverb.
let audioMode: 'headset' | 'speaker' = 'headset';
let speakerOutputMode = false;
let speakerGuardUntil = 0;
let speakerBargeSuppressed = false;
let speakerProbePending = false;
let speakerProbeUntil = 0;
let speakerProbeSum = 0;
let speakerProbeCount = 0;
let speakerProbeMax = 0;
// Rolling mic energy during speaker playback. The median approximates the
// current speaker leakage floor: high while TTS is loud, low in pauses. Barge
// is allowed when the user is clearly louder than that floor.
let speakerLeakWindow: number[] = [];
// Once leakage/self-echo is observed, raise the barge threshold for a cooldown
// instead of disabling voice interruption entirely.
let speakerEchoUntil = 0;
let ipcRegistered = false;
let testAudioActive = false;
let pttActive = false;
// Hands-free by default. PTT remains available as a fallback mode.
let pttMode = false;

const CAPTURE_BARGE_THRESHOLD = 1000;
const CAPTURE_BARGE_SUSTAIN_MS = 150;
// External speakers + an in-ear mic: keep listening during playback so voice
// barge-in works. The threshold is higher because speaker leakage is possible.
const SPEAKER_BARGE_THRESHOLD = Number(
  process.env.CYRVIS_SPEAKER_BARGE_THRESHOLD || 2000,
);
const SPEAKER_BARGE_SUSTAIN_MS = 180;
// Measure the mic during the first 1200ms of *actual playback* (not from
// response.created, which can arrive before any audio). If the speaker leaks
// into the mic, voice barge is unreliable and would make the model answer its
// own audio; suppress barge and let the reply finish.
const SPEAKER_ECHO_GUARD = Number(
  process.env.CYRVIS_SPEAKER_ECHO_GUARD || 1500,
);
const SPEAKER_ECHO_PROBE_MS = 1200;
const SPEAKER_ECHO_COOLDOWN_MS = 60_000;
const SPEAKER_LEAK_WINDOW_CHUNKS = 25; // ~500ms of 20ms chunks
const SPEAKER_LEAK_FACTOR = 4;
const SPEAKER_GATED_BARGE_THRESHOLD = 2500;

const AUDIO_SCRIPT_CANDIDATES = () => [
  path.resolve(
    app.getAppPath(),
    '../../scripts/cyrvis/audio/set-default-output.ps1',
  ),
  path.resolve(process.cwd(), 'scripts/cyrvis/audio/set-default-output.ps1'),
  path.resolve(
    process.cwd(),
    '../../scripts/cyrvis/audio/set-default-output.ps1',
  ),
];

const findAudioScript = (): string | null =>
  AUDIO_SCRIPT_CANDIDATES().find((candidate) => fs.existsSync(candidate)) ??
  null;

/**
 * Windows sometimes keeps the Electron audio session on the Bluetooth headset
 * even when <audio>.setSinkId() names the Realtek endpoint. Switching the
 * Windows default endpoint per voice mode makes both paths agree.
 */
const switchWindowsDefaultOutput = async (
  kind: 'headset' | 'speaker',
): Promise<void> => {
  const script = findAudioScript();
  if (!script) {
    logger.warn('[cyrvis voice] audio endpoint script not found');
    return;
  }
  await new Promise<void>((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-Kind',
        kind,
      ],
      { timeout: 15_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          logger.error('[cyrvis voice] switch default output failed', {
            kind,
            error: error.message,
            stderr: stderr?.trim(),
          });
        } else {
          logger.info('[cyrvis voice] default output switched', {
            kind,
            result: stdout.trim(),
          });
        }
        resolve();
      },
    );
  });
};

/**
 * Microphone audio comes from a hidden renderer that never plays audio.
 * Playback lives in the main window; separating the two audio sessions is
 * what keeps the mic alive while the assistant speaks.
 */
const handleCapturePcm = (pcm16: Int16Array): void => {
  if (!service || !captureReady || !pcm16.length) {
    return;
  }

  let sum = 0;
  let peak = 0;
  for (let i = 0; i < pcm16.length; i += 1) {
    const value = Math.abs(pcm16[i]);
    sum += value;
    if (value > peak) {
      peak = value;
    }
  }
  const average = sum / pcm16.length;

  const now = Date.now();
  if (now - lastCaptureLogAt >= 1000) {
    lastCaptureLogAt = now;
    logger.info('[cyrvis capture] level', {
      avg: Math.round(average),
      peak,
      playing: assistantPlaybackActive,
      mode: audioMode,
    });
  }

  // Keep a 600ms pre-roll in both modes so the beginning of "停" is not lost.
  capturePreroll.push(pcm16.slice());
  if (capturePreroll.length > 30) {
    capturePreroll.shift();
  }

  if (assistantPlaybackActive) {
    if (speakerOutputMode) {
      speakerLeakWindow.push(average);
      if (speakerLeakWindow.length > SPEAKER_LEAK_WINDOW_CHUNKS) {
        speakerLeakWindow.shift();
      }
    }
    if (speakerOutputMode && speakerProbeUntil > 0) {
      if (now < speakerProbeUntil) {
        speakerProbeSum += average;
        speakerProbeCount += 1;
        if (average > speakerProbeMax) {
          speakerProbeMax = average;
        }
        captureBargeMs = 0;
        return;
      }
      const probeAvg = speakerProbeSum / Math.max(1, speakerProbeCount);
      speakerProbeUntil = 0;
      if (
        probeAvg > SPEAKER_ECHO_GUARD ||
        speakerProbeMax > SPEAKER_ECHO_GUARD * 2
      ) {
        speakerBargeSuppressed = true;
        speakerEchoUntil = now + SPEAKER_ECHO_COOLDOWN_MS;
        logger.warn('[cyrvis voice] high speaker leakage; barge gated', {
          avg: Math.round(probeAvg),
          max: Math.round(speakerProbeMax),
          guard: SPEAKER_ECHO_GUARD,
          cooldownMs: SPEAKER_ECHO_COOLDOWN_MS,
        });
      } else {
        logger.info('[cyrvis voice] speaker leakage acceptable', {
          avg: Math.round(probeAvg),
          max: Math.round(speakerProbeMax),
        });
      }
    }
    const chunkMs = (pcm16.length / 16000) * 1000;
    let threshold = speakerOutputMode
      ? SPEAKER_BARGE_THRESHOLD
      : CAPTURE_BARGE_THRESHOLD;
    let leakFloor = 0;
    if (speakerOutputMode) {
      // While TTS is loud the mic is dominated by speaker leakage; while it is
      // between words the floor drops. Requiring the user to be clearly above
      // the local floor lets "停" work in pauses without false triggers.
      const sorted = [...speakerLeakWindow].sort((a, b) => a - b);
      leakFloor = sorted[Math.floor(sorted.length / 2)] ?? 0;
      threshold = Math.max(
        threshold,
        leakFloor * SPEAKER_LEAK_FACTOR,
        speakerBargeSuppressed ? SPEAKER_GATED_BARGE_THRESHOLD : 0,
      );
    }
    const sustainMs = speakerOutputMode
      ? SPEAKER_BARGE_SUSTAIN_MS
      : CAPTURE_BARGE_SUSTAIN_MS;
    if (average > threshold) {
      captureBargeMs += chunkMs;
    } else {
      captureBargeMs = Math.max(0, captureBargeMs - chunkMs);
    }
    if (captureBargeMs >= sustainMs) {
      logger.info('[cyrvis capture] barge-in', {
        avg: Math.round(average),
        mode: audioMode,
        threshold: Math.round(threshold),
        leakFloor: Math.round(leakFloor),
      });
      assistantPlaybackActive = false;
      speakerGuardUntil = 0;
      captureBargeMs = 0;
      const buffered = capturePreroll.splice(0);
      service.provider.bargeIn();
      service.brain.forceAwake();
      broadcast('cyrvis:voice:response-stopped');
      for (const chunk of buffered) {
        service.provider.sendAudio(chunk);
      }
    }
    return;
  }

  // A very short reverb guard only; do not drop the mic for 800ms after TTS.
  if (speakerOutputMode && now < speakerGuardUntil) {
    return;
  }
  captureBargeMs = 0;
  service.provider.sendAudio(pcm16);
};

const clearCaptureRetry = () => {
  if (captureRetryTimer) {
    clearTimeout(captureRetryTimer);
    captureRetryTimer = null;
  }
};

const scheduleCaptureRetry = (message: string) => {
  if (captureRetryTimer || captureRetryAttempts >= 3) {
    return;
  }
  if (!/No physical microphone|Microphone disconnected/i.test(message)) {
    return;
  }
  captureRetryAttempts += 1;
  const delay = 1200;
  logger.warn('[cyrvis capture] retrying', {
    attempt: captureRetryAttempts,
    delay,
    message,
  });
  captureRetryTimer = setTimeout(() => {
    captureRetryTimer = null;
    void startCapture().catch((error) => {
      logger.error('[cyrvis capture] retry failed', error);
    });
  }, delay);
};

const startCapture = async (resetRetries = false): Promise<void> => {
  if (resetRetries) {
    captureRetryAttempts = 0;
    clearCaptureRetry();
  }
  const generation = ++captureGeneration;
  captureService?.close();
  captureService = null;
  captureReady = false;
  try {
    captureService = await startCaptureService(
      {
        onPcm: (pcm16) => {
          if (generation === captureGeneration) {
            handleCapturePcm(pcm16);
          }
        },
        onReady: (label) => {
          if (generation !== captureGeneration) {
            return;
          }
          captureReady = true;
          captureRetryAttempts = 0;
          clearCaptureRetry();
          logger.info('[cyrvis capture] ready', {
            label,
            mode: audioMode,
          });
          broadcast('cyrvis:voice:capture-ready', { label });
        },
        onError: (message) => {
          if (generation !== captureGeneration) {
            return;
          }
          captureReady = false;
          logger.error('[cyrvis capture] error', { message });
          broadcast('cyrvis:voice:capture-error', { message });
          scheduleCaptureRetry(message);
        },
      },
      // The hidden capture renderer has no reference to the main window's
      // playback, so AEC cannot cancel external speakers. Keep the mic raw and
      // use the energy threshold above for barge-in instead.
      { echoCancellation: false },
    );
  } catch (error) {
    if (generation === captureGeneration) {
      captureReady = false;
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[cyrvis capture] start failed', { message });
      broadcast('cyrvis:voice:capture-error', { message });
      scheduleCaptureRetry(message);
    }
    throw error;
  }
};

const broadcast = (channel: string, payload?: unknown) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
};

const broadcastPtt = () => {
  broadcast('cyrvis:voice:ptt', { active: pttActive, mode: pttMode });
};

const triggerBargeIn = () => {
  if (!service) {
    return;
  }
  logger.info('[cyrvis voice] barge-in');
  assistantPlaybackActive = false;
  captureBargeMs = 0;
  speakerBargeSuppressed = false;
  speakerProbeUntil = 0;
  speakerLeakWindow = [];
  service.provider.bargeIn();
  service.brain.forceAwake();
  broadcast('cyrvis:voice:response-stopped');
};

const setPttActive = (active: boolean) => {
  if (!service) {
    return;
  }
  pttActive = active;
  if (pttActive) {
    service.brain.forceAwake();
    service.provider.clearAudioBuffer();
  } else {
    service.provider.endPtt();
  }
  logger.info('[cyrvis voice] PTT', { active: pttActive });
  broadcastPtt();
};

const registerVoiceIpc = () => {
  if (ipcRegistered) {
    return;
  }
  ipcRegistered = true;

  ipcMain.handle('cyrvis:voice:toggle-ptt', () => {
    setPttActive(!pttActive);
    return { active: pttActive, mode: pttMode };
  });

  ipcMain.handle('cyrvis:voice:get-ptt', () => ({
    active: pttActive,
    mode: pttMode,
  }));

  ipcMain.handle('cyrvis:voice:start', async () => {
    if (!service) {
      return { ok: false, error: 'voice service is not configured' };
    }
    try {
      await service.brain.start();
      return { ok: true, state: service.brain.getState() };
    } catch (error) {
      logger.error('[cyrvis voice] start failed', error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle('cyrvis:voice:get-state', () => {
    return service?.brain.getState() ?? null;
  });

  ipcMain.handle('cyrvis:voice:cancel-task', async () => {
    if (!service) {
      return null;
    }
    return service.controller.cancelTask();
  });

  ipcMain.on('cyrvis:voice:audio', (_event, buffer: ArrayBuffer) => {
    if (!service || testAudioActive || !(buffer instanceof ArrayBuffer)) {
      return;
    }
    if (pttMode && !pttActive) {
      return;
    }
    service.provider.sendAudio(new Int16Array(buffer));
  });

  ipcMain.handle('cyrvis:voice:test-audio', async () => {
    if (!env.isDev || !service) {
      return { ok: false, error: 'test audio is only available in dev' };
    }

    const wavPath = process.env.CYRVIS_TEST_WAV;
    if (!wavPath) {
      return {
        ok: false,
        error: 'CYRVIS_TEST_WAV is not set',
      };
    }
    let wav: Buffer;
    try {
      wav = fs.readFileSync(wavPath);
    } catch (error) {
      return {
        ok: false,
        error: `Cannot read CYRVIS_TEST_WAV: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    let offset = 12;
    let data: Buffer | null = null;
    while (offset + 8 <= wav.length) {
      const id = wav.toString('ascii', offset, offset + 4);
      const size = wav.readUInt32LE(offset + 4);
      if (id === 'data') {
        data = wav.subarray(offset + 8, offset + 8 + size);
        break;
      }
      offset += 8 + size + (size % 2);
    }

    if (!data) {
      return { ok: false, error: 'WAV data chunk not found' };
    }

    logger.info('[cyrvis voice] test audio start', { bytes: data.length });
    testAudioActive = true;
    service.provider.clearAudioBuffer();
    try {
      const chunkSize = 640; // 20 ms at 16 kHz PCM16 mono
      for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.subarray(i, i + chunkSize);
        const pcm = new Int16Array(
          chunk.buffer,
          chunk.byteOffset,
          Math.floor(chunk.byteLength / 2),
        );
        service.provider.sendAudio(pcm);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Local VAD needs to observe trailing silence before committing.
      const silence = new Int16Array(16000); // 1 second at 16 kHz
      for (let i = 0; i < silence.length; i += 320) {
        service.provider.sendAudio(silence.subarray(i, i + 320));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      testAudioActive = false;
    }

    logger.info('[cyrvis voice] test audio sent');
    return { ok: true, bytes: data.length };
  });

  ipcMain.handle('cyrvis:voice:set-mode', async (_event, mode: unknown) => {
    if (mode !== 'headset' && mode !== 'speaker') {
      return { ok: false, error: 'mode must be headset or speaker' };
    }
    const nextMode = mode as 'headset' | 'speaker';
    await switchWindowsDefaultOutput(nextMode);
    const changed = audioMode !== nextMode;
    audioMode = nextMode;
    speakerOutputMode = nextMode === 'speaker';
    speakerGuardUntil = 0;
    speakerBargeSuppressed = false;
    speakerProbePending = false;
    speakerProbeUntil = 0;
    speakerEchoUntil = 0;
    speakerLeakWindow = [];
    captureBargeMs = 0;
    capturePreroll = [];
    logger.info('[cyrvis voice] audio mode', {
      mode: audioMode,
      echoCancellation: false,
      bargeThreshold: speakerOutputMode
        ? SPEAKER_BARGE_THRESHOLD
        : CAPTURE_BARGE_THRESHOLD,
    });
    broadcast('cyrvis:voice:audio-mode', { mode: audioMode });
    if (changed) {
      // Bluetooth profile/A2DP switches briefly drop the HFP microphone.
      // Give Windows time to settle before opening the hidden capture window.
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        await startCapture(true);
      } catch (error) {
        logger.error('[cyrvis capture] mode switch failed', error);
      }
    }
    return { ok: true, mode: audioMode };
  });

  ipcMain.handle('cyrvis:voice:get-mode', () => ({ mode: audioMode }));

  ipcMain.handle('cyrvis:voice:set-output', (_event, label: unknown) => {
    if (typeof label !== 'string' || !label.trim()) {
      return { ok: false, error: 'output label is required' };
    }
    // Output device and voice mode are independent on purpose: the user can
    // route audio to external speakers while keeping headset/full-duplex mode
    // and voice barge-in (e.g. an in-ear mic + external speakers).
    logger.info('[cyrvis voice] output label', { label, mode: audioMode });
    broadcast('cyrvis:voice:set-output', label);
    return { ok: true, mode: audioMode, speaker: speakerOutputMode };
  });

  ipcMain.handle('cyrvis:voice:restart-capture', async () => {
    try {
      await startCapture(true);
      return { ok: true };
    } catch (error) {
      logger.error('[cyrvis capture] restart failed', error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.on('cyrvis:voice:playback-idle', () => {
    assistantPlaybackActive = false;
    captureBargeMs = 0;
    speakerBargeSuppressed = false;
    speakerProbePending = false;
    speakerProbeUntil = 0;
    speakerLeakWindow = [];
    speakerGuardUntil = speakerOutputMode ? Date.now() + 100 : 0;
    service?.provider.notifyPlaybackIdle();
  });

  ipcMain.on('cyrvis:voice:barge-in', () => {
    triggerBargeIn();
  });

  ipcMain.on('cyrvis:voice:force-awake', () => {
    service?.brain.forceAwake();
  });

  ipcMain.on('cyrvis:voice:sleep', () => {
    service?.brain.sleep();
  });
};

/**
 * Starts the voice layer once per Electron main process.
 * No-op when QWEN_API_KEY is absent.
 */
export const startVoiceService = (): VoiceService | null => {
  if (service) {
    return service;
  }

  const apiKey = process.env.QWEN_API_KEY;
  if (!apiKey) {
    logger.warn(
      '[cyrvis voice] QWEN_API_KEY is not set; voice service is disabled',
    );
    return null;
  }

  const controller = new CyrvisController(new ElectronGUIAdapter());
  let provider!: QwenOmniProvider;

  const brain = new VoiceBrain(
    controller,
    {
      onAudio: (pcm16) => {
        const copy = pcm16.slice();
        broadcast('cyrvis:voice:audio', copy.buffer);
      },
      onSpeechStarted: () => {
        logger.info('[cyrvis voice] speech started');
        broadcast('cyrvis:voice:speech-started');
      },
      onSpeechStopped: () => {
        logger.info('[cyrvis voice] speech stopped');
        broadcast('cyrvis:voice:speech-stopped');
      },
      onTranscript: (text, final) =>
        broadcast('cyrvis:voice:transcript', { text, final }),
      onAssistantText: (text, final) => {
        logger.info('[cyrvis voice] assistant text', { text, final });
        broadcast('cyrvis:voice:assistant', { text, final });
      },
      onState: (state: VoiceBrainState) =>
        broadcast('cyrvis:voice:state', state),
      onWake: () => {
        logger.info('[cyrvis voice] wake');
        broadcast('cyrvis:voice:wake');
      },
      onSleep: () => {
        logger.info('[cyrvis voice] sleep');
        broadcast('cyrvis:voice:sleep');
      },
      onTaskEvent: (event: ControllerEvent) =>
        broadcast('cyrvis:voice:task-event', event),
      onSelfEcho: () => {
        if (speakerOutputMode) {
          speakerBargeSuppressed = true;
          speakerProbePending = false;
          speakerProbeUntil = 0;
          speakerEchoUntil = Date.now() + SPEAKER_ECHO_COOLDOWN_MS;
          logger.warn(
            '[cyrvis voice] self-echo; speaker barge gated',
            { cooldownMs: SPEAKER_ECHO_COOLDOWN_MS },
          );
        }
      },
      onError: (error) => logger.error('[cyrvis voice] error', error),
    },
    (callbacks) => {
      const wrapped = {
        ...callbacks,
        onReady: () => {
          logger.info('[cyrvis voice] qwen session ready');
          callbacks.onReady?.();
        },
        onTranscript: (text: string, final: boolean) => {
          logger.info('[cyrvis voice] transcript', { text, final });
          callbacks.onTranscript?.(text, final);
        },
        onResponseStarted: () => {
          assistantPlaybackActive = true;
          captureBargeMs = 0;
          capturePreroll = [];
          speakerGuardUntil = 0;
          speakerBargeSuppressed =
            speakerOutputMode && Date.now() < speakerEchoUntil;
          speakerProbePending =
            speakerOutputMode && !speakerBargeSuppressed;
          speakerProbeUntil = 0;
          speakerProbeSum = 0;
          speakerProbeCount = 0;
          speakerProbeMax = 0;
          speakerLeakWindow = [];
          if (speakerOutputMode) {
            // Drop any residual speaker/TTS audio still in the ASR buffer.
            service?.provider.clearAudioBuffer();
          }
          broadcast('cyrvis:voice:response-started');
          callbacks.onResponseStarted?.();
        },
        onAudio: (pcm16: Int16Array) => {
          // Probe starts with the first *audible* chunk, not response.created:
          // generation can take hundreds of ms, so an earlier probe only sees
          // silence and misses the speaker leakage entirely.
          if (speakerOutputMode && speakerProbePending) {
            speakerProbePending = false;
            speakerProbeUntil = Date.now() + SPEAKER_ECHO_PROBE_MS;
            speakerProbeSum = 0;
            speakerProbeCount = 0;
            speakerProbeMax = 0;
            service?.provider.clearAudioBuffer();
          }
          callbacks.onAudio?.(pcm16);
        },
        onResponseDone: () => {
          // Tool-call-only responses produce no audio. Tell the renderer so
          // its half-duplex gate does not stay closed for the watchdog period
          // and swallow the user's next words (e.g. "stop").
          broadcast('cyrvis:voice:response-done');
          callbacks.onResponseDone?.();
        },
        onUtteranceCommitted: () => {
          if (pttMode && pttActive) {
            setPttActive(false);
          }
          // The renderer shows "Thinking…" during the gap between end of
          // speech and the first response token, so the user does not repeat
          // themselves thinking they were not heard.
          broadcast('cyrvis:voice:thinking');
          callbacks.onUtteranceCommitted?.();
        },
        onToolCall: (
          call: Parameters<NonNullable<typeof callbacks.onToolCall>>[0],
        ) => {
          logger.info('[cyrvis voice] tool call', call.name, call.args);
          callbacks.onToolCall?.(call);
        },
        onError: (error: Error) => {
          logger.error('[cyrvis voice] provider error', error);
          callbacks.onError?.(error);
        },
      };

      provider = new QwenOmniProvider({
        apiKey,
        model: process.env.QWEN_MODEL || 'qwen3.8-omni-flash-realtime',
        endpoint: process.env.QWEN_REALTIME_URL || undefined,
        voice: process.env.QWEN_VOICE || undefined,
        callbacks: wrapped,
        vadType: 'semantic_vad_ec',
        // 1.2s felt like the assistant was deaf: users repeat "Hello" before
        // the endpoint fires, which extends the utterance and delays it more.
        // 800ms keeps natural pauses while making the first reply snappier.
        silenceDurationMs: 800,
      });
      return provider;
    },
    {
      // Hands-free: the app listens continuously while it is running. The
      // provider's half-duplex gate mutes the mic while the assistant speaks.
      requireWakeWord: false,
      awakeTimeoutMs: 0,
      proactivity: {
        minGapMs: 5000,
        progressCooldownMs: 30000,
      },
    },
  );

  service = { brain, provider, controller };
  registerVoiceIpc();

  if (pttMode) {
    const shortcutRegistered = globalShortcut.register(
      'Control+Alt+Space',
      () => setPttActive(!pttActive),
    );
    logger.info('[cyrvis voice] PTT shortcut', {
      accelerator: 'Control+Alt+Space',
      registered: shortcutRegistered,
    });
  }

  // Keyboard fallback for barge-in. Voice barge-in works by speaking, but this
  // is deterministic even when the mic/echo gate is misbehaving.
  const stopShortcut = globalShortcut.register('Control+Alt+X', triggerBargeIn);
  logger.info('[cyrvis voice] stop-speaking shortcut', {
    accelerator: 'Control+Alt+X',
    registered: stopShortcut,
  });

  app.on('before-quit', () => {
    globalShortcut.unregisterAll();
    clearCaptureRetry();
    captureService?.close();
    captureService = null;
    brain.dispose();
    service = null;
  });

  // Capture is independent of the voice-model session: a Qwen quota/network
  // failure must not make the microphone look missing. Retry transient
  // Bluetooth HFP drops inside startCapture().
  void startCapture(true).catch((error) => {
    logger.error('[cyrvis capture] startup failed', error);
  });

  // Connect eagerly so the app is listening after launch.
  brain
    .start()
    .then(() => {
      logger.info('[cyrvis voice] qwen connected');
    })
    .catch((error) => {
      logger.error('[cyrvis voice] qwen connect failed', error);
    });

  logger.info('[cyrvis voice] service started');
  return service;
};
