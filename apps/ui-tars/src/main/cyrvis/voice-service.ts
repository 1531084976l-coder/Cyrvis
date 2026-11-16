/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow, globalShortcut, ipcMain } from 'electron';

import * as env from '@main/env';
import { logger } from '@main/logger';
import {
  describeControllerEvent,
  describeVoiceToolCall,
  type CyrvisActivityEvent,
  type CyrvisMemoryTurnRole,
  type VoiceToolName,
} from '@shared/cyrvis';

import { startCaptureService, type CaptureService } from './capture-service';
import { CyrvisController } from './controller';
import { ElectronGUIAdapter } from './gui-adapter';
import { voiceMemoryService } from './memory';
import { SpeakerEchoDetector } from './speaker-barge';
import { isLikelySpeakerEcho } from './speaker-echo';
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
let capturePreroll: Int16Array[] = [];
let lastCaptureLogAt = 0;
// Two selectable audio modes:
// - headset: capture without AEC + full voice barge-in (verified)
// - speaker: reference-aware echo gating plus an interrupt probe, so the
//   assistant can still be interrupted while its own audio is playing.
let audioMode: 'headset' | 'speaker' = 'headset';
let speakerOutputMode = false;
let speakerGuardUntil = 0;
let lastAssistantText = '';
let lastAssistantAt = 0;
let ipcRegistered = false;
let testAudioActive = false;
let pttActive = false;
// Hands-free by default. PTT remains available as a fallback mode.
const pttMode = false;

const CAPTURE_BARGE_THRESHOLD = 1500;
const CAPTURE_BARGE_SUSTAIN_MS = 180;
const SPEAKER_REVERB_GUARD_MS = 1400;
// A bare "停" is often only 200-300ms. The old 220ms decay + 140ms confirm
// discarded the whole word, so every short stop failed the probe.
const SPEAKER_PROBE_DECAY_MS = 220;
const SPEAKER_PROBE_CONFIRM_MS = 140;
const HEADSET_PROBE_DECAY_MS = 80;
const HEADSET_PROBE_CONFIRM_MS = 100;
const SPEAKER_PROBE_TIMEOUT_MS = 700;
const SPEAKER_PROBE_THRESHOLD = 1100;
const SPEAKER_RESUME_SUPPRESS_MS = 550;
const SPEAKER_DIRECT_PREROLL_CHUNKS = 24;
const HEADSET_REVERB_GUARD_MS = 900;

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

interface SpeakerProbeState {
  startedAt: number;
  speechMs: number;
  chunks: Int16Array[];
}

const speakerEchoDetector = new SpeakerEchoDetector();
let speakerProbe: SpeakerProbeState | null = null;
let speakerCandidateMs = 0;
// Headset mode has no meaningful speaker echo; use direct energy barge so a
// short "停" is never lost to a 700ms probe confirmation window.
let headsetBargeMs = 0;
let speakerResumeSuppressUntil = 0;
let lastSpeakerDiagnosticAt = 0;
let voiceprintPending = false;
let lastVoiceprintAt = 0;
const VOICEPRINT_COOLDOWN_MS = 600;
let speakerBargeStopPending = false;
let speakerBargeStopTimer: ReturnType<typeof setTimeout> | null = null;

const pushCapturePreroll = (pcm16: Int16Array): void => {
  capturePreroll.push(pcm16.slice());
  // Keep ~1s so the voiceprint verifier has enough audio for a stable
  // embedding (ERes2Net works best with >=0.6s).
  if (capturePreroll.length > 50) {
    capturePreroll.shift();
  }
};

const resetSpeakerDetection = (): void => {
  speakerEchoDetector.reset();
  speakerProbe = null;
  speakerCandidateMs = 0;
  headsetBargeMs = 0;
  speakerResumeSuppressUntil = 0;
};

const expectSpeakerBargeStop = (): void => {
  speakerBargeStopPending = true;
  if (speakerBargeStopTimer) {
    clearTimeout(speakerBargeStopTimer);
  }
  speakerBargeStopTimer = setTimeout(() => {
    speakerBargeStopTimer = null;
    speakerBargeStopPending = false;
  }, 1500);
};

const finishSpeakerBargeIn = (_buffered: Int16Array[]): void => {
  if (!service) {
    return;
  }

  speakerProbe = null;
  speakerCandidateMs = 0;
  expectSpeakerBargeStop();
  assistantPlaybackActive = false;
  speakerGuardUntil = 0;
  speakerEchoDetector.reset();
  capturePreroll = [];
  service.provider.bargeIn();
  service.provider.muteMicFor(900);
  service.brain.forceAwake();
  service.brain.handleBargeStop();
  broadcast('cyrvis:voice:response-stopped');
  emitActivity('speech', '已通过外放麦克风打断助手');
};

const resumeSpeakerPlayback = (): void => {
  speakerProbe = null;
  speakerCandidateMs = 0;
  speakerResumeSuppressUntil = Date.now() + SPEAKER_RESUME_SUPPRESS_MS;
  // Keep the playback references collected before the probe. Resetting them
  // here made the next analysis run with corr=0 and triggered a second probe
  // for the same sentence.
  speakerEchoDetector.setReferenceEnabled(true);
  broadcast('cyrvis:voice:playback-resume');
};

const startSpeakerProbe = (now: number): void => {
  speakerProbe = {
    startedAt: now,
    speechMs: 0,
    chunks: [],
  };
  speakerCandidateMs = 0;
  speakerEchoDetector.setReferenceEnabled(false);
  broadcast('cyrvis:voice:playback-pause');
  logger.info('[cyrvis speaker] playback paused for interrupt probe');
};

const handleSpeakerProbePcm = (
  pcm16: Int16Array,
  average: number,
  now: number,
): void => {
  const probe = speakerProbe;
  if (!probe) {
    return;
  }

  probe.chunks.push(pcm16.slice());
  if (probe.chunks.length > 100) {
    probe.chunks.shift();
  }
  // Speaker mode needs a longer decay: its own reverb tail was being counted
  // as user speech and confirmed false interruptions. Headset mode has almost
  // no echo, so it can accept a short 200ms "停".
  const decayMs = speakerOutputMode
    ? SPEAKER_PROBE_DECAY_MS
    : HEADSET_PROBE_DECAY_MS;
  const confirmMs = speakerOutputMode
    ? SPEAKER_PROBE_CONFIRM_MS
    : HEADSET_PROBE_CONFIRM_MS;
  const elapsed = now - probe.startedAt;
  if (elapsed < decayMs) {
    return;
  }

  const chunkMs = (pcm16.length / 16000) * 1000;
  if (average > SPEAKER_PROBE_THRESHOLD) {
    probe.speechMs += chunkMs;
  } else {
    probe.speechMs = Math.max(0, probe.speechMs - chunkMs);
  }

  if (probe.speechMs >= confirmMs) {
    logger.info('[cyrvis speaker] interrupt confirmed', {
      avg: Math.round(average),
      elapsed,
    });
    const dropSamples = Math.floor((decayMs * 16000) / 1000);
    const buffered: Int16Array[] = [];
    let remainingDrop = dropSamples;
    for (const chunk of probe.chunks) {
      if (remainingDrop >= chunk.length) {
        remainingDrop -= chunk.length;
        continue;
      }
      buffered.push(
        remainingDrop > 0 ? chunk.slice(remainingDrop) : chunk.slice(),
      );
      remainingDrop = 0;
    }
    finishSpeakerBargeIn(buffered);
    return;
  }

  if (elapsed >= SPEAKER_PROBE_TIMEOUT_MS) {
    logger.info('[cyrvis speaker] interrupt probe rejected', {
      elapsed,
      speechMs: Math.round(probe.speechMs),
    });
    resumeSpeakerPlayback();
  }
};

const voiceprintUrl = (): string | null => {
  const value = process.env.CYRVIS_VOICEPRINT_URL?.trim();
  return value ? value.replace(/\/$/, '') : null;
};

/**
 * Ask the local speaker-verification sidecar whether the last ~1s of mic audio
 * belongs to the enrolled user. Returns null when the service is unavailable
 * or not enrolled, so callers can fall back to the old barge policy.
 */
const verifyVoiceprint = async (): Promise<boolean | null> => {
  const base = voiceprintUrl();
  if (!base) {
    return null;
  }
  const chunks = capturePreroll.slice(-50);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (total < 9600) {
    return null;
  }
  const pcm = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const response = await fetch(`${base}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
    });
    if (!response.ok) {
      logger.warn('[cyrvis voiceprint] verify failed', {
        status: response.status,
      });
      return null;
    }
    const result = (await response.json()) as {
      score?: number;
      match?: boolean;
      threshold?: number;
    };
    logger.info('[cyrvis voiceprint] verify', result);
    return typeof result.match === 'boolean' ? result.match : null;
  } catch (error) {
    logger.warn('[cyrvis voiceprint] unavailable', error);
    return null;
  } finally {
    voiceprintPending = false;
  }
};

const handleSpeakerPlaybackPcm = (
  pcm16: Int16Array,
  average: number,
  now: number,
): void => {
  if (speakerProbe) {
    handleSpeakerProbePcm(pcm16, average, now);
    return;
  }

  const analysis = speakerEchoDetector.analyze(pcm16, now);
  if (now - lastSpeakerDiagnosticAt >= 1000) {
    lastSpeakerDiagnosticAt = now;
    logger.info('[cyrvis speaker] echo analysis', {
      avg: Math.round(average),
      ref: Math.round(analysis.referenceAverage * 0x8000),
      corr: Number(analysis.correlation.toFixed(3)),
      echo: analysis.likelyEcho,
      ambiguous: analysis.ambiguous,
    });
  }

  if (now < speakerResumeSuppressUntil) {
    speakerCandidateMs = 0;
    return;
  }

  const chunkMs = (pcm16.length / 16000) * 1000;
  if (average <= CAPTURE_BARGE_THRESHOLD || analysis.likelyEcho) {
    speakerCandidateMs = Math.max(0, speakerCandidateMs - chunkMs);
    return;
  }

  speakerCandidateMs += chunkMs;
  if (speakerCandidateMs < CAPTURE_BARGE_SUSTAIN_MS) {
    return;
  }

  // Speaker-verification gate: only an enrolled user's voice may interrupt.
  // This is what lets us ignore the assistant's own speaker output even when
  // its energy is higher than the user's voice.
  if (
    voiceprintUrl() &&
    !voiceprintPending &&
    now - lastVoiceprintAt >= VOICEPRINT_COOLDOWN_MS
  ) {
    lastVoiceprintAt = now;
    speakerCandidateMs = 0;
    voiceprintPending = true;
    const fallbackDirect =
      !analysis.ambiguous && analysis.referenceActive;
    void verifyVoiceprint().then((match) => {
      if (!assistantPlaybackActive) {
        return;
      }
      if (match === true) {
        logger.info('[cyrvis voiceprint] enrolled user; interrupt');
        finishSpeakerBargeIn(
          capturePreroll.slice(-SPEAKER_DIRECT_PREROLL_CHUNKS),
        );
      } else if (match === false) {
        logger.info('[cyrvis voiceprint] not the user; keep playing');
      } else if (fallbackDirect) {
        logger.info('[cyrvis voiceprint] fallback direct interrupt');
        finishSpeakerBargeIn(
          capturePreroll.slice(-SPEAKER_DIRECT_PREROLL_CHUNKS),
        );
      }
    });
    return;
  }

  // Missing references happen between WAV segments and during device
  // latency. In that window a loud speaker tail is indistinguishable from a
  // user, so fail closed and wait for the next valid playback reference.
  if (!analysis.referenceActive) {
    speakerCandidateMs = 0;
    return;
  }

  if (analysis.ambiguous) {
    // By default, do not pause playback to "probe" an ambiguous echo. On this
    // hardware the probe itself sounded like a brief stop and then resumed.
    // CYRVIS_SPEAKER_PROBE=1 restores the old pause-and-confirm behavior.
    if (process.env.CYRVIS_SPEAKER_PROBE === '1') {
      startSpeakerProbe(now);
    } else {
      speakerCandidateMs = 0;
    }
    return;
  }

  logger.info('[cyrvis speaker] direct interrupt detected', {
    avg: Math.round(average),
    corr: Number(analysis.correlation.toFixed(3)),
  });
  finishSpeakerBargeIn(capturePreroll.slice(-SPEAKER_DIRECT_PREROLL_CHUNKS));
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
  for (let i = 0; i < pcm16.length; i += 1) {
    sum += Math.abs(pcm16[i]);
  }
  const average = sum / pcm16.length;

  const now = Date.now();
  if (now - lastCaptureLogAt >= 1000) {
    lastCaptureLogAt = now;
    logger.info('[cyrvis capture] level', {
      avg: Math.round(average),
      playing: assistantPlaybackActive,
      mode: audioMode,
    });
  }

  pushCapturePreroll(pcm16);

  if (assistantPlaybackActive && !speakerOutputMode) {
    const chunkMs = (pcm16.length / 16000) * 1000;
    if (average > CAPTURE_BARGE_THRESHOLD) {
      headsetBargeMs += chunkMs;
    } else {
      headsetBargeMs = Math.max(0, headsetBargeMs - chunkMs);
    }
    if (headsetBargeMs >= CAPTURE_BARGE_SUSTAIN_MS) {
      logger.info('[cyrvis capture] barge-in', {
        avg: Math.round(average),
        mode: 'headset',
      });
      headsetBargeMs = 0;
      assistantPlaybackActive = false;
      capturePreroll = [];
      service.provider.bargeIn();
      service.provider.muteMicFor(900);
      service.brain.forceAwake();
      service.brain.handleBargeStop();
      broadcast('cyrvis:voice:response-stopped');
    }
    return;
  }

  if (assistantPlaybackActive) {
    // Speaker mode: reference-aware gating; ambiguous echo is ignored rather
    // than pausing playback for a probe.
    handleSpeakerPlaybackPcm(pcm16, average, now);
    return;
  }

  const analysis = speakerEchoDetector.analyze(pcm16, now);
  if (analysis.likelyEcho) {
    return;
  }
  const clearUserSpeech =
    average > CAPTURE_BARGE_THRESHOLD && !analysis.ambiguous;
  if (now < speakerGuardUntil && !clearUserSpeech) {
    return;
  }

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
          emitActivity('session', `麦克风已连接：${label}`);
        },
        onError: (message) => {
          if (generation !== captureGeneration) {
            return;
          }
          captureReady = false;
          logger.error('[cyrvis capture] error', { message });
          broadcast('cyrvis:voice:capture-error', { message });
          emitActivity('error', `麦克风连接失败：${message}`);
          scheduleCaptureRetry(message);
        },
      },
      // The capture renderer has no reference signal from the playback
      // renderer. Keep browser AEC off and perform reference-aware gating in
      // the main process instead.
      { echoCancellation: false },
    );
  } catch (error) {
    if (generation === captureGeneration) {
      captureReady = false;
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[cyrvis capture] start failed', { message });
      broadcast('cyrvis:voice:capture-error', { message });
      emitActivity('error', `麦克风连接失败：${message}`);
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

const emitActivity = (
  kind: CyrvisActivityEvent['kind'],
  text: string,
): void => {
  const event: CyrvisActivityEvent = {
    id: randomUUID(),
    kind,
    text,
    createdAt: Date.now(),
  };
  broadcast('cyrvis:voice:activity', event);
  void voiceMemoryService.appendActivity(event).catch((error) => {
    logger.warn('[cyrvis memory] activity persist failed', error);
  });
};

const syncProviderMemoryContext = async (): Promise<void> => {
  if (!service) {
    return;
  }
  service.provider.setContext(await voiceMemoryService.getContext());
};

const recordTurn = (role: CyrvisMemoryTurnRole, text: string): void => {
  void voiceMemoryService
    .appendTurn(role, text)
    .then(() => syncProviderMemoryContext())
    .catch((error) => {
      logger.warn('[cyrvis memory] turn persist failed', error);
    });
};

const broadcastPtt = () => {
  broadcast('cyrvis:voice:ptt', { active: pttActive, mode: pttMode });
};

const triggerBargeIn = () => {
  if (!service) {
    return;
  }
  logger.info('[cyrvis voice] barge-in');
  const wasPlaying = assistantPlaybackActive;
  expectSpeakerBargeStop();
  assistantPlaybackActive = false;
  capturePreroll = [];
  resetSpeakerDetection();
  service.provider.bargeIn();
  if (wasPlaying) {
    service.provider.muteMicFor(900);
  }
  service.brain.forceAwake();
  service.brain.handleBargeStop();
  broadcast('cyrvis:voice:response-stopped');
  emitActivity('speech', '已打断助手回答');
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

  ipcMain.handle('cyrvis:voice:get-memory', () => {
    return voiceMemoryService.getSnapshot();
  });

  ipcMain.handle('cyrvis:voice:get-capture-ready', () => ({
    ready: captureReady,
  }));

  ipcMain.handle('cyrvis:voice:cancel-task', async () => {
    if (!service) {
      return null;
    }
    return service.controller.cancelTask();
  });

  ipcMain.handle('cyrvis:voice:pause-task', async () => {
    if (!service) {
      return null;
    }
    return service.controller.pauseTask();
  });

  ipcMain.handle('cyrvis:voice:resume-task', async () => {
    if (!service) {
      return null;
    }
    return service.controller.resumeTask();
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

  ipcMain.on(
    'cyrvis:voice:playback-reference',
    (_event, buffer: ArrayBuffer, startedAt?: number) => {
      if (speakerProbe || !(buffer instanceof ArrayBuffer)) {
        return;
      }
      speakerEchoDetector.addReference(
        new Int16Array(buffer),
        typeof startedAt === 'number' ? startedAt : Date.now(),
      );
    },
  );

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
    capturePreroll = [];
    if (speakerProbe) {
      broadcast('cyrvis:voice:playback-resume');
    }
    resetSpeakerDetection();
    logger.info('[cyrvis voice] audio mode', {
      mode: audioMode,
      echoCancellation: false,
    });
    broadcast('cyrvis:voice:audio-mode', { mode: audioMode });
    if (changed) {
      // Bluetooth profile/A2DP switches briefly drop the HFP microphone.
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
    // route audio to external speakers while keeping headset/full-duplex mode.
    if (speakerProbe) {
      broadcast('cyrvis:voice:playback-resume');
    }
    resetSpeakerDetection();
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
    const bargeStopPending = speakerBargeStopPending;
    speakerBargeStopPending = false;
    if (speakerBargeStopTimer) {
      clearTimeout(speakerBargeStopTimer);
      speakerBargeStopTimer = null;
    }
    assistantPlaybackActive = false;
    resetSpeakerDetection();
    speakerGuardUntil = !bargeStopPending
      ? Date.now() +
        (speakerOutputMode ? SPEAKER_REVERB_GUARD_MS : HEADSET_REVERB_GUARD_MS)
      : 0;
    service?.provider.notifyPlaybackIdle(
      speakerOutputMode && !bargeStopPending ? 150 : 0,
    );
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
  // Keep the renderer control surface available even when the model key is
  // missing. It reports a clean "not configured" state instead of exposing
  // Electron's missing IPC handler error in the floating panel.
  registerVoiceIpc();

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
      onTranscript: (text, final) => {
        broadcast('cyrvis:voice:transcript', { text, final });
        if (final) {
          recordTurn('user', text);
        }
      },
      onAssistantText: (text, final) => {
        logger.info('[cyrvis voice] assistant text', { text, final });
        broadcast('cyrvis:voice:assistant', { text, final });
        lastAssistantAt = Date.now();
        lastAssistantText = final ? text : `${lastAssistantText}${text}`;
        if (final) {
          recordTurn('assistant', text);
        }
      },
      onState: (state: VoiceBrainState) =>
        broadcast('cyrvis:voice:state', state),
      onWake: () => {
        logger.info('[cyrvis voice] wake');
        broadcast('cyrvis:voice:wake');
        emitActivity('session', '语音会话已唤醒');
      },
      onSleep: () => {
        logger.info('[cyrvis voice] sleep');
        broadcast('cyrvis:voice:sleep');
        emitActivity('session', '语音会话已休眠');
      },
      onTaskEvent: (event: ControllerEvent) => {
        broadcast('cyrvis:voice:task-event', event);
        const text = describeControllerEvent(event);
        if (text) {
          emitActivity(event.type === 'task_failed' ? 'error' : 'task', text);
        }
      },
      onError: (error) => {
        logger.error('[cyrvis voice] error', error);
        emitActivity('error', `语音服务错误：${error.message}`);
      },
    },
    (callbacks) => {
      const wrapped = {
        ...callbacks,
        onReady: () => {
          logger.info('[cyrvis voice] qwen session ready');
          emitActivity('session', 'Qwen Realtime 已连接');
          callbacks.onReady?.();
        },
        onTranscript: (text: string, final: boolean) => {
          logger.info('[cyrvis voice] transcript', { text, final });
          if (
            final &&
            isLikelySpeakerEcho(
              text,
              lastAssistantText,
              Date.now() - lastAssistantAt,
            )
          ) {
            logger.warn('[cyrvis voice] ignored likely speaker echo', {
              transcript: text,
            });
            provider?.cancelResponse();
            provider?.clearAudioBuffer();
            broadcast('cyrvis:voice:transcript', { text: '', final: true });
            emitActivity('speech', '已忽略外放回声，未触发追问');
            return;
          }
          callbacks.onTranscript?.(text, final);
        },
        onResponseStarted: () => {
          if (service?.brain.shouldSuppressReply()) {
            logger.info('[cyrvis voice] suppress reply after stop command');
            service.provider.cancelResponse();
            return;
          }
          speakerBargeStopPending = false;
          if (speakerBargeStopTimer) {
            clearTimeout(speakerBargeStopTimer);
            speakerBargeStopTimer = null;
          }
          resetSpeakerDetection();
          assistantPlaybackActive = true;
          capturePreroll = [];
          speakerGuardUntil = 0;
          lastAssistantText = '';
          // Never carry playback-tail audio into the next ASR turn, regardless
          // of which output mode the UI currently reports.
          service?.provider.clearAudioBuffer();
          broadcast('cyrvis:voice:response-started');
          emitActivity('speech', '助手开始流式回答');
          callbacks.onResponseStarted?.();
        },
        onResponseDone: () => {
          // Tool-call-only responses produce no audio. Tell the renderer so
          // its half-duplex gate does not stay closed for the watchdog period
          // and swallow the user's next words (e.g. "stop").
          broadcast('cyrvis:voice:response-done');
          emitActivity('speech', '助手回答完成');
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
          emitActivity('speech', '正在理解语音指令');
          callbacks.onUtteranceCommitted?.();
        },
        onToolCall: (
          call: Parameters<NonNullable<typeof callbacks.onToolCall>>[0],
        ) => {
          logger.info('[cyrvis voice] tool call', call.name, call.args);
          const instruction =
            call.name === 'start_gui_task'
              ? call.args.instruction
              : call.name === 'remember_fact'
                ? call.args.text
                : undefined;
          broadcast('cyrvis:voice:tool-call', {
            name: call.name,
            instruction,
          });
          emitActivity(
            call.name === 'remember_fact' ? 'memory' : 'tool',
            describeVoiceToolCall(call.name as VoiceToolName, instruction),
          );
          callbacks.onToolCall?.(call);
        },
        onError: (error: Error) => {
          logger.error('[cyrvis voice] provider error', error);
          emitActivity('error', `语音模型错误：${error.message}`);
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
        // 800ms felt sluggish. 400ms is near the practical floor for Chinese
        // speech: shorter values start splitting normal sentence pauses.
        silenceDurationMs: 400,
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
      memoryContextProvider: () => voiceMemoryService.getContext(),
      rememberFact: async (text) => {
        const remembered = await voiceMemoryService.rememberFact(text);
        if (remembered) {
          emitActivity('memory', `已保存长期记忆：${remembered}`);
        }
        return remembered;
      },
    },
  );

  service = { brain, provider, controller };

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
    captureService?.close();
    captureService = null;
    brain.dispose();
    service = null;
  });

  // Connect eagerly so the app is listening after launch.
  brain
    .start()
    .then(async () => {
      logger.info('[cyrvis voice] qwen connected');
      await startCapture();
    })
    .catch((error) => {
      logger.error('[cyrvis voice] connect/capture failed', error);
      broadcast('cyrvis:voice:capture-error', {
        message: error instanceof Error ? error.message : String(error),
      });
    });

  logger.info('[cyrvis voice] service started');
  return service;
};
