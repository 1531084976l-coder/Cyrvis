/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import type {
  ControllerEvent,
  ProactiveUtterance,
  ProactivityPriority,
  ProactivityReason,
} from './types';

export interface ProactivityOptions {
  /** Minimum gap between priority >= 2 utterances. */
  minGapMs?: number;
  /** Cooldown for repeated progress/stall updates. */
  progressCooldownMs?: number;
  /** Cooldown for optional suggestions. */
  suggestionCooldownMs?: number;
  enableProgress?: boolean;
  enableSuggestions?: boolean;
  acknowledgeOnStart?: boolean;
  now?: () => number;
}

type RequiredOptions = Required<Omit<ProactivityOptions, 'now'>> & {
  now: () => number;
};

const DEFAULTS: RequiredOptions = {
  minGapMs: 3000,
  progressCooldownMs: 8000,
  suggestionCooldownMs: 30000,
  enableProgress: false,
  enableSuggestions: false,
  acknowledgeOnStart: true,
  now: Date.now,
};

const truncate = (text: string, max = 80): string =>
  text.length > max ? `${text.slice(0, max)}...` : text;

const cleanError = (error: string): string => {
  try {
    const parsed = JSON.parse(error) as { message?: string };
    if (parsed?.message) {
      return truncate(parsed.message);
    }
  } catch {
    // Not JSON, use the raw error text.
  }
  return truncate(error);
};

/**
 * Decides when the assistant is allowed to speak proactively.
 *
 * The Controller emits task events; this policy turns a subset of them into
 * utterances while respecting user speech, TTS playback, priority and cooldowns.
 */
export class ProactivityPolicy {
  private userSpeaking = false;
  private ttsSpeaking = false;
  private lastSpokenAt = 0;
  private readonly lastReasonAt = new Map<ProactivityReason, number>();
  private readonly options: RequiredOptions;

  constructor(
    private readonly speak: (utterance: ProactiveUtterance) => void,
    options: ProactivityOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  onEvent(event: ControllerEvent): void {
    switch (event.type) {
      case 'task_started':
        if (this.options.acknowledgeOnStart) {
          this.trySpeak('好，我来处理。', 1, 'task_started');
        }
        break;
      case 'task_stalled':
        if (this.options.enableProgress) {
          this.trySpeak(
            '这一步有点慢，我还在处理。',
            2,
            'task_stalled',
            this.options.progressCooldownMs,
          );
        }
        break;
      case 'task_needs_user':
        this.trySpeak(
          event.question || '需要你确认一下。',
          0,
          'task_needs_user',
        );
        break;
      case 'task_done':
        this.trySpeak(
          this.options.enableSuggestions
            ? '完成了。还需要我做什么吗？'
            : '完成了。',
          1,
          'task_done',
        );
        break;
      case 'task_failed':
        this.trySpeak(
          `没成功。${cleanError(event.error)} 要我重试吗？`,
          1,
          'task_failed',
        );
        break;
      case 'task_cancelled':
        this.trySpeak('已停止。', 1, 'task_cancelled');
        break;
      case 'task_paused':
        this.trySpeak('已暂停。', 2, 'progress');
        break;
      case 'task_resumed':
        this.trySpeak('继续执行。', 2, 'progress');
        break;
      case 'step_update':
        if (this.options.enableProgress && event.step % 3 === 0) {
          this.trySpeak(
            `还在执行，${event.summary}。`,
            2,
            'progress',
            this.options.progressCooldownMs,
          );
        }
        break;
      default:
        break;
    }
  }

  setUserSpeaking(value: boolean): void {
    this.userSpeaking = value;
  }

  setTtsSpeaking(value: boolean): void {
    this.ttsSpeaking = value;
  }

  canSpeak(
    priority: ProactivityPriority,
    reason: ProactivityReason,
    cooldownMs = 0,
  ): boolean {
    const now = this.options.now();
    if (this.userSpeaking || this.ttsSpeaking) {
      return false;
    }

    if (priority >= 2 && now - this.lastSpokenAt < this.options.minGapMs) {
      return false;
    }

    if (cooldownMs > 0) {
      const last = this.lastReasonAt.get(reason) ?? 0;
      if (now - last < cooldownMs) {
        return false;
      }
    }

    return true;
  }

  reset(): void {
    this.userSpeaking = false;
    this.ttsSpeaking = false;
    this.lastSpokenAt = 0;
    this.lastReasonAt.clear();
  }

  private trySpeak(
    text: string,
    priority: ProactivityPriority,
    reason: ProactivityReason,
    cooldownMs = 0,
  ): boolean {
    if (!text.trim() || !this.canSpeak(priority, reason, cooldownMs)) {
      return false;
    }

    const now = this.options.now();
    this.lastSpokenAt = now;
    this.lastReasonAt.set(reason, now);
    this.speak({ text, priority, reason });
    return true;
  }
}
