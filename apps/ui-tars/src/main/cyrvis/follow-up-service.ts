/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';
import ElectronStore from 'electron-store';
import { execFile, type ChildProcess } from 'node:child_process';

import { logger } from '@main/logger';
import { speakProactiveText } from './voice-service';

export type FollowUpReason =
  | 'launch'
  | 'activate'
  | 'resume'
  | 'unlock'
  | 'idle';

export interface FollowUpPrompt {
  id: string;
  reason: FollowUpReason;
  createdAt: number;
  greeting: string;
}

interface FollowUpState {
  enabled: boolean;
  snoozedUntil: number;
  lastPromptAt: number;
  pending: FollowUpPrompt | null;
}

const PROMPT_GAP_MS = 30 * 60 * 1000;
const DEFAULT_SNOOZE_MS = 30 * 60 * 1000;
const IDLE_SUGGESTION_SECONDS = 15;

const createGreeting = (date = new Date()): string => {
  const hour = date.getHours();
  const day = date.getDay();
  const isWeekend = day === 0 || day === 6;
  const period =
    hour < 6
      ? '夜深了'
      : hour < 11
        ? '早上好'
        : hour < 14
          ? '中午好'
          : hour < 18
            ? '下午好'
            : '晚上好';

  if (hour < 6) {
    return `${period}，注意休息，剩下的任务可以交给我帮你记着。`;
  }
  if (isWeekend) {
    return `${period}，今天是周末。有没有出行或放松一下的计划？`;
  }

  const weekday = new Intl.DateTimeFormat('zh-CN', {
    weekday: 'long',
  }).format(date);
  return `${period}，今天是${weekday}。准备好后，我们可以接着推进上次的任务。`;
};

const followUpStore = new ElectronStore<FollowUpState>({
  name: 'cyrvis-proactivity',
  defaults: {
    enabled: true,
    snoozedUntil: 0,
    lastPromptAt: 0,
    pending: null,
  },
});

let registered = false;
let idleSuggestionShown = false;
let idleTimer: ReturnType<typeof setInterval> | null = null;
let weatherCache: { expiresAt: number; text: string } | null = null;
let localSpeechProcess: ChildProcess | null = null;

const HONG_KONG = {
  city: '香港',
  latitude: 22.3193,
  longitude: 114.1694,
};

interface WeatherResponse {
  current?: {
    temperature_2m?: number;
    apparent_temperature?: number;
    precipitation?: number;
    weather_code?: number;
  };
  daily?: {
    precipitation_probability_max?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
  };
}

const weatherName = (code = -1): string => {
  if (code === 0) return '晴朗';
  if (code <= 3) return '多云';
  if (code <= 48) return '有雾';
  if (code <= 67) return '有雨';
  if (code <= 77) return '有雪';
  if (code <= 82) return '有阵雨';
  if (code <= 99) return '有雷雨';
  return '天气情况暂不明确';
};

const getWeatherText = async (): Promise<string> => {
  if (weatherCache && weatherCache.expiresAt > Date.now()) {
    return weatherCache.text;
  }

  const params = new URLSearchParams({
    latitude: String(HONG_KONG.latitude),
    longitude: String(HONG_KONG.longitude),
    current: 'temperature_2m,apparent_temperature,precipitation,weather_code',
    daily:
      'precipitation_probability_max,temperature_2m_max,temperature_2m_min',
    timezone: 'auto',
    forecast_days: '1',
  });
  const response = await fetch(
    `https://api.open-meteo.com/v1/forecast?${params}`,
    {
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok)
    throw new Error(`weather request failed: ${response.status}`);

  const weather = (await response.json()) as WeatherResponse;
  const temperature = Math.round(weather.current?.temperature_2m ?? 0);
  const low = Math.round(weather.daily?.temperature_2m_min?.[0] ?? temperature);
  const high = Math.round(
    weather.daily?.temperature_2m_max?.[0] ?? temperature,
  );
  const rainChance = Math.round(
    weather.daily?.precipitation_probability_max?.[0] ?? 0,
  );
  const raining = (weather.current?.precipitation ?? 0) > 0;
  const rainAdvice =
    raining || rainChance >= 40
      ? `今天最高降雨概率${rainChance}%，出门记得带伞。`
      : '今天降雨概率不高。';
  const text = `${HONG_KONG.city}现在${weatherName(weather.current?.weather_code)}，${temperature}度，今天${low}到${high}度。${rainAdvice}`;
  weatherCache = { expiresAt: Date.now() + 15 * 60 * 1000, text };
  return text;
};

const speakLocally = (text: string): void => {
  localSpeechProcess?.kill();
  localSpeechProcess = execFile(
    '/usr/bin/say',
    ['-v', 'Tingting', '-r', '185', text],
    (error) => {
      localSpeechProcess = null;
      if (!error) return;
      logger.warn('[cyrvis follow-up] Chinese voice unavailable', error);
      localSpeechProcess = execFile('/usr/bin/say', ['-r', '180', text], () => {
        localSpeechProcess = null;
      });
    },
  );
};

const stopLocalSpeech = (): void => {
  if (localSpeechProcess && !localSpeechProcess.killed) {
    localSpeechProcess.kill();
    localSpeechProcess = null;
  }
};

const enrichAndSpeak = async (prompt: FollowUpPrompt): Promise<void> => {
  let weather = '';
  try {
    weather = await getWeatherText();
  } catch (error) {
    logger.warn('[cyrvis follow-up] weather unavailable', error);
  }

  const pending = followUpStore.get('pending');
  if (!pending || pending.id !== prompt.id) return;

  const enriched = {
    ...prompt,
    greeting: weather ? `${prompt.greeting}${weather}` : prompt.greeting,
  };
  followUpStore.set('pending', enriched);
  broadcast(enriched);

  const action =
    prompt.reason === 'idle'
      ? '要不要继续推进最近的任务？'
      : '要继续上次的任务吗？';
  const speech = `${enriched.greeting}${action}`;
  if (!speakProactiveText(speech)) speakLocally(speech);
};

const broadcast = (prompt: FollowUpPrompt) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('cyrvis:follow-up:prompt', prompt);
    }
  }
};

const showMainWindow = () => {
  const win = BrowserWindow.getAllWindows().find(
    (item) => item.getTitle() === 'UI-TARS Desktop',
  );
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
};

export const requestFollowUp = (
  reason: FollowUpReason,
  options: { force?: boolean; revealWindow?: boolean } = {},
): FollowUpPrompt | null => {
  const now = Date.now();
  const enabled = followUpStore.get('enabled');
  const snoozedUntil = followUpStore.get('snoozedUntil');
  const lastPromptAt = followUpStore.get('lastPromptAt');

  if (
    !enabled ||
    now < snoozedUntil ||
    (!options.force && now - lastPromptAt < PROMPT_GAP_MS)
  ) {
    return null;
  }

  const prompt: FollowUpPrompt = {
    id: `${reason}-${now}`,
    reason,
    createdAt: now,
    greeting: createGreeting(new Date(now)),
  };
  followUpStore.set({
    ...followUpStore.store,
    lastPromptAt: now,
    pending: prompt,
  });

  if (options.revealWindow) showMainWindow();
  broadcast(prompt);
  void enrichAndSpeak(prompt);
  logger.info('[cyrvis follow-up] prompt', prompt);
  return prompt;
};

export const registerFollowUpService = (): void => {
  if (registered) return;
  registered = true;

  ipcMain.handle('cyrvis:follow-up:get-pending', () =>
    followUpStore.get('pending'),
  );
  ipcMain.handle('cyrvis:follow-up:complete', (_event, id: unknown) => {
    stopLocalSpeech();
    const pending = followUpStore.get('pending');
    if (!pending || pending.id === id) followUpStore.set('pending', null);
    return { ok: true };
  });
  ipcMain.handle(
    'cyrvis:follow-up:snooze',
    (_event, id: unknown, delayMs: unknown) => {
      stopLocalSpeech();
      const pending = followUpStore.get('pending');
      if (!pending || pending.id === id) followUpStore.set('pending', null);
      const safeDelay =
        typeof delayMs === 'number' && delayMs > 0
          ? Math.min(delayMs, 24 * 60 * 60 * 1000)
          : DEFAULT_SNOOZE_MS;
      followUpStore.set('snoozedUntil', Date.now() + safeDelay);
      return { ok: true, snoozedUntil: followUpStore.get('snoozedUntil') };
    },
  );

  powerMonitor.on('resume', () =>
    requestFollowUp('resume', { revealWindow: true }),
  );
  powerMonitor.on('unlock-screen', () =>
    requestFollowUp('unlock', { revealWindow: true }),
  );

  // Treat a lack of keyboard/mouse activity as a short pause in the user's
  // workflow. Only prompt once per idle episode and never stack dialogs.
  idleTimer = setInterval(() => {
    const idleSeconds = powerMonitor.getSystemIdleTime();
    if (idleSeconds < IDLE_SUGGESTION_SECONDS) {
      idleSuggestionShown = false;
      return;
    }
    if (idleSuggestionShown || followUpStore.get('pending')) return;

    const prompt = requestFollowUp('idle', {
      force: true,
      revealWindow: true,
    });
    if (prompt) idleSuggestionShown = true;
  }, 1000);

  app.once('before-quit', () => {
    stopLocalSpeech();
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
  });
};
