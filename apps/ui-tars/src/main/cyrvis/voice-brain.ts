/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CyrvisController } from './controller';
import { TaskBusyError } from './controller';
import { classifyIntent, isExplicitChat } from './intent-gate';
import { ProactivityPolicy, type ProactivityOptions } from './proactivity';
import type { ControllerEvent, TaskSnapshot } from './types';
import type {
  VoiceProvider,
  VoiceProviderCallbacks,
  VoiceToolCallWithId,
} from './voice/provider';

export interface VoiceBrainState {
  awake: boolean;
  userSpeaking: boolean;
  ttsSpeaking: boolean;
  lastUserText: string;
  task: TaskSnapshot;
}

export interface VoiceBrainCallbacks {
  onAudio?: (pcm16: Int16Array) => void;
  onSpeechStarted?: () => void;
  onSpeechStopped?: () => void;
  onTranscript?: (text: string, final: boolean) => void;
  onAssistantText?: (text: string, final: boolean) => void;
  onState?: (state: VoiceBrainState) => void;
  onWake?: () => void;
  onSleep?: () => void;
  onTaskEvent?: (event: ControllerEvent) => void;
  onError?: (error: Error) => void;
}

export interface VoiceBrainOptions {
  requireWakeWord?: boolean;
  awakeTimeoutMs?: number;
  wakePatterns?: RegExp[];
  enableProactivity?: boolean;
  /** A clear task/control command can wake the assistant without the wake word. */
  autoWakeOnTask?: boolean;
  proactivity?: ProactivityOptions;
}

const DEFAULT_WAKE_PATTERNS: RegExp[] = [
  /\b(hello|hi|hey|ok)[\s,，]*(cyrvis|cyrus|cyris|cyprus|cypres|cypress|cybris|sirvis|cervis|sirius|siris|service)\b/i,
  /\b(cyrvis|cyrus|cyris|cyprus|cypres|cypress|cybris)\b/i,
  /\b(hello|hi|hey)\b/i,
  /(你好|您好|嗨)/,
  /(你好|嗨|喂)[，,\s]*(cyrvis|赛维斯|瑟维斯|瑟尔维斯|赛勒斯|塞勒斯|赛鲁斯|塞浦路斯)/i,
  /(赛维斯|瑟维斯|瑟尔维斯|赛勒斯|塞勒斯|赛鲁斯)/i,
];

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[，。！？、,.!?;；:：""''“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The conversational brain.
 *
 * Responsibilities:
 * - wake/sleep gating for "Hello CYRVIS";
 * - route tool calls through the intent gate before touching the GUI agent;
 * - drop audio/tool calls while asleep;
 * - translate Controller events into proactive speech.
 */
export class VoiceBrain {
  private readonly provider: VoiceProvider;
  private readonly proactivity: ProactivityPolicy;
  private awake = false;
  private userSpeaking = false;
  private ttsSpeaking = false;
  private lastUserText = '';
  private partialUserText = '';
  private assistantTextBuffer = '';
  private lastFinalTranscript = '';
  private lastFinalAt = 0;
  private suppressAudioUntilResponseDone = false;
  private completionGuardTriggered = false;
  private awakeTimer: ReturnType<typeof setTimeout> | null = null;
  private speakWatchdog: ReturnType<typeof setTimeout> | null = null;
  private readonly unsubscribeController: () => void;
  private readonly completionClaimPattern =
    /(已经打开|已经输入|已经完成|已完成|完成了|打开了|输入了|opened|typed|completed|finished|done|succeeded)/i;

  private readonly requireWakeWord: boolean;
  private readonly awakeTimeoutMs: number;
  private readonly wakePatterns: RegExp[];

  constructor(
    private readonly controller: CyrvisController,
    private readonly callbacks: VoiceBrainCallbacks = {},
    providerFactory: (callbacks: VoiceProviderCallbacks) => VoiceProvider,
    private readonly options: VoiceBrainOptions = {},
  ) {
    this.requireWakeWord = options.requireWakeWord ?? true;
    this.awakeTimeoutMs = options.awakeTimeoutMs ?? 20_000;
    this.wakePatterns = options.wakePatterns || DEFAULT_WAKE_PATTERNS;

    this.provider = providerFactory(this.createProviderCallbacks());

    this.proactivity = new ProactivityPolicy(
      (utterance) => {
        if (!this.awake) {
          return;
        }
        this.speak(utterance.text);
      },
      {
        // Qwen acknowledges a successful tool call by itself; do not double-ack.
        acknowledgeOnStart: false,
        enableProgress: false,
        enableSuggestions: false,
        ...options.proactivity,
      },
    );

    this.unsubscribeController = controller.onEvent((event) => {
      this.callbacks.onTaskEvent?.(event);
      if (this.options.enableProactivity !== false) {
        this.proactivity.onEvent(event);
      }
      this.notifyState();
    });
  }

  async start(): Promise<void> {
    await this.provider.connect();
    if (!this.requireWakeWord) {
      this.wake();
    }
    this.notifyState();
  }

  getState(): VoiceBrainState {
    return {
      awake: this.awake,
      userSpeaking: this.userSpeaking,
      ttsSpeaking: this.ttsSpeaking,
      lastUserText: this.lastUserText,
      task: this.controller.getStatus(),
    };
  }

  forceAwake(): void {
    this.wake();
  }

  sleep(): void {
    if (!this.awake) {
      return;
    }
    this.awake = false;
    this.clearAwakeTimer();
    this.callbacks.onSleep?.();
    this.notifyState();
  }

  dispose(): void {
    this.clearAwakeTimer();
    if (this.speakWatchdog) {
      clearTimeout(this.speakWatchdog);
      this.speakWatchdog = null;
    }
    this.unsubscribeController();
    this.proactivity.reset();
    this.provider.close();
  }

  private createProviderCallbacks(): VoiceProviderCallbacks {
    return {
      onReady: () => {
        if (!this.requireWakeWord) {
          this.wake();
        }
        this.notifyState();
      },
      onClose: () => {
        this.sleep();
        this.notifyState();
      },
      onSpeechStarted: () => {
        this.userSpeaking = true;
        this.ttsSpeaking = false;
        this.proactivity.setUserSpeaking(true);
        this.proactivity.setTtsSpeaking(false);
        this.callbacks.onSpeechStarted?.();
        this.notifyState();
      },
      onSpeechStopped: () => {
        this.userSpeaking = false;
        this.proactivity.setUserSpeaking(false);
        this.callbacks.onSpeechStopped?.();
        this.notifyState();
      },
      onTranscript: (text, final) => this.handleTranscript(text, final),
      onAssistantText: (text, final) => {
        this.guardCompletionClaim(text);
        this.callbacks.onAssistantText?.(text, final);
      },
      onToolCall: (call) => {
        void this.handleToolCall(call).catch((error: unknown) => {
          this.callbacks.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      },
      onAudio: (pcm16) => {
        if (this.awake && !this.suppressAudioUntilResponseDone) {
          this.callbacks.onAudio?.(pcm16);
        }
      },
      onResponseStarted: () => {
        this.assistantTextBuffer = '';
        this.completionGuardTriggered = false;
        this.suppressAudioUntilResponseDone = false;
        this.ttsSpeaking = true;
        this.proactivity.setTtsSpeaking(true);
        this.notifyState();
      },
      onResponseDone: () => {
        this.assistantTextBuffer = '';
        this.suppressAudioUntilResponseDone = false;
        this.completionGuardTriggered = false;
        this.ttsSpeaking = false;
        this.proactivity.setTtsSpeaking(false);
        this.resetAwakeTimer();
        this.notifyState();
      },
      onError: (error) => {
        this.callbacks.onError?.(error);
      },
    };
  }

  private handleTranscript(text: string, final: boolean): void {
    this.callbacks.onTranscript?.(text, final);

    if (!final) {
      this.partialUserText += text;
      if (!this.awake && this.isWakePhrase(this.partialUserText)) {
        this.wake();
      }
      return;
    }

    this.partialUserText = '';

    if (!text.trim()) {
      // Qwen sometimes commits silence/noise and still generates a reply.
      // Cancel it instead of stacking another assistant voice.
      this.provider.cancelResponse();
      return;
    }

    const now = Date.now();
    if (text === this.lastFinalTranscript && now - this.lastFinalAt < 3000) {
      console.log('[cyrvis voice] duplicate transcript ignored');
      return;
    }
    this.lastFinalTranscript = text;
    this.lastFinalAt = now;

    this.lastUserText = text;

    // Safety-critical: stop/pause must act even if the voice model forgets to
    // call the tool (observed in real testing: it said "paused" but the GUI
    // agent kept running).
    this.handleDeterministicControl(text);

    if (!this.awake) {
      const decision = classifyIntent(text);
      const autoWake =
        this.options.autoWakeOnTask !== false &&
        (decision.kind === 'task' || decision.kind === 'control');

      if (this.isWakePhrase(text) || autoWake) {
        this.wake();
      } else {
        // The model may already be answering background speech. Suppress it.
        this.provider.cancelResponse();
      }
      this.notifyState();
      return;
    }

    this.resetAwakeTimer();
    this.notifyState();
  }

  private async handleToolCall(call: VoiceToolCallWithId): Promise<void> {
    if (!this.awake) {
      this.provider.sendToolResult(
        call.callId,
        'REJECTED: the assistant is asleep. Do not execute anything.',
      );
      return;
    }

    this.resetAwakeTimer();

    switch (call.name) {
      case 'start_gui_task': {
        const instruction = call.args.instruction?.trim();
        if (!instruction) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: instruction is required.',
          );
          return;
        }

        const instructionDecision = classifyIntent(instruction);
        const userDecision = this.lastUserText
          ? classifyIntent(this.lastUserText)
          : null;
        const userIsExplicitChat = this.lastUserText
          ? isExplicitChat(this.lastUserText)
          : false;

        // The model often paraphrases the user's task with verbs the gate does
        // not know ("在桌面新建一个txt文件..." lacks 打开/搜索/给我). Allow the
        // call when either the instruction or the original user text is a task.
        const allowedByUserText = userDecision?.kind === 'task';
        if (
          (instructionDecision.kind !== 'task' && !allowedByUserText) ||
          userIsExplicitChat
        ) {
          this.provider.sendToolResult(
            call.callId,
            'REJECTED: this is conversation, not a GUI task. Do not call the GUI agent. Answer the user directly or ask a clarifying question.',
          );
          return;
        }

        try {
          const task = this.controller.startTask(instruction, 'voice');
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: true,
              task_id: task.taskId,
              status: 'started',
              message:
                'TASK_STARTED. The GUI agent is still executing. Do NOT claim the task is complete. Say briefly that you are working on it, then wait for the final task_done/task_failed event.',
            }),
          );
        } catch (error) {
          if (error instanceof TaskBusyError) {
            this.provider.sendToolResult(
              call.callId,
              'TASK_BUSY: a GUI task is already running. Ask the user whether to cancel it before starting a new one.',
            );
            return;
          }
          throw error;
        }
        break;
      }
      case 'cancel_gui_task': {
        const task = await this.controller.cancelTask(call.args.task_id);
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({ ok: true, status: task.status }),
        );
        break;
      }
      case 'pause_gui_task': {
        const task = await this.controller.pauseTask();
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({ ok: true, status: task.status }),
        );
        break;
      }
      case 'resume_gui_task': {
        const task = await this.controller.resumeTask();
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({ ok: true, status: task.status }),
        );
        break;
      }
      case 'get_gui_status': {
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(this.controller.getStatus()),
        );
        break;
      }
      case 'confirm_action': {
        this.provider.sendToolResult(
          call.callId,
          'ERROR: confirmation is not implemented yet.',
        );
        break;
      }
      default: {
        const unknown = call as { callId: string; name: string };
        this.provider.sendToolResult(
          unknown.callId,
          `ERROR: unknown tool "${unknown.name}".`,
        );
      }
    }
  }

  private handleDeterministicControl(text: string): void {
    const status = this.controller.getStatus().status;
    const active = ['starting', 'executing', 'paused', 'cancelling'].includes(
      status,
    );
    if (!active) {
      return;
    }

    const explicitCancel =
      /(取消|算了|不想|不要|不用|停止|停下|别动|stop|cancel)/i.test(text) ||
      /(^|[\s，。])停([\s，。！？]|$)/.test(text);
    const pause = /(暂停|等一下|等等|pause)/i.test(text);

    if (explicitCancel) {
      void this.controller.cancelTask().catch((error: unknown) => {
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    } else if (pause) {
      void this.controller.pauseTask().catch((error: unknown) => {
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    }
  }

  private guardCompletionClaim(text: string): void {
    if (this.completionGuardTriggered) {
      return;
    }

    const status = this.controller.getStatus().status;
    const taskActive = [
      'starting',
      'executing',
      'paused',
      'cancelling',
    ].includes(status);
    if (!taskActive) {
      return;
    }

    this.assistantTextBuffer += text;
    if (!this.completionClaimPattern.test(this.assistantTextBuffer)) {
      return;
    }

    this.completionGuardTriggered = true;
    this.suppressAudioUntilResponseDone = true;
    this.provider.cancelResponse();
    this.callbacks.onAssistantText?.(
      '[任务仍在执行，已拦截提前完成声明]',
      true,
    );
    setTimeout(() => {
      this.speak('好的，我正在执行，请稍等。');
    }, 300);
  }

  private isWakePhrase(text: string): boolean {
    const normalized = normalize(text);
    return this.wakePatterns.some((pattern) => pattern.test(normalized));
  }

  private wake(): void {
    if (this.awake) {
      this.resetAwakeTimer();
      return;
    }
    this.awake = true;
    this.callbacks.onWake?.();
    this.resetAwakeTimer();
    this.notifyState();
  }

  private speak(text: string): void {
    this.ttsSpeaking = true;
    this.proactivity.setTtsSpeaking(true);
    this.provider.speak(text);
    this.notifyState();

    if (this.speakWatchdog) {
      clearTimeout(this.speakWatchdog);
    }
    this.speakWatchdog = setTimeout(() => {
      this.ttsSpeaking = false;
      this.proactivity.setTtsSpeaking(false);
      this.notifyState();
    }, 15_000);
  }

  private resetAwakeTimer(): void {
    this.clearAwakeTimer();
    if (!this.awake || this.awakeTimeoutMs <= 0) {
      return;
    }
    this.awakeTimer = setTimeout(() => {
      this.sleep();
    }, this.awakeTimeoutMs);
  }

  private clearAwakeTimer(): void {
    if (this.awakeTimer) {
      clearTimeout(this.awakeTimer);
      this.awakeTimer = null;
    }
  }

  private notifyState(): void {
    this.callbacks.onState?.(this.getState());
  }
}
