/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CyrvisController } from './controller';
import { TaskBusyError } from './controller';
import { classifyIntent, isExplicitChat } from './intent-gate';
import { ProactivityPolicy, type ProactivityOptions } from './proactivity';
import type { ControllerEvent } from './types';
import type { CyrvisVoiceState } from '@shared/cyrvis';
import type {
  VoiceProvider,
  VoiceProviderCallbacks,
  VoiceToolCallWithId,
} from './voice/provider';

export type VoiceBrainState = CyrvisVoiceState;

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
  /** The ASR transcript is almost certainly the assistant's own speaker audio. */
  onSelfEcho?: () => void;
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
  memoryContextProvider?: () => Promise<string>;
  rememberFact?: (text: string) => Promise<string | null>;
}

const DEFAULT_WAKE_PATTERNS: RegExp[] = [
  /\b(hello|hallo|hi|hey|ok)[\s,，]*(cyrvis|cyrus|cyris|cyprus|cypres|cypress|cybris|sirvis|cervis|sirius|siris|service|zawis|zavis|savis|cywiz|cy vis)\b/i,
  /\b(cyrvis|cyrus|cyris|cyprus|cypres|cypress|cybris|zawis|zavis|savis|savage|savages|s voice|svoice)\b/i,
  /\b(hello|hallo|hi|hey)\b/i,
  /(你好|您好|嗨|哈喽|哈啰|哈罗)/,
  /(你好|您好|嗨|喂|哈喽|哈啰|哈罗)[，,\s]*(cyrvis|赛维斯|瑟维斯|瑟尔维斯|赛勒斯|塞勒斯|赛鲁斯|塞浦路斯|塞维斯)/i,
  /(赛维斯|瑟维斯|瑟尔维斯|赛勒斯|塞勒斯|赛鲁斯|塞维斯)/i,
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
  private playbackWatchdog: ReturnType<typeof setTimeout> | null = null;
  private responseHadAudio = false;
  private lastAssistantText = '';
  private lastAssistantAudioAt = 0;
  private suppressControlProactivityUntil = 0;
  // After a bare "停/暂停", do not let the model speak an acknowledgment.
  // The user expects the audio to stop, not a new reply confirming it.
  private suppressReplyUntil = 0;
  private lastDeterministicControl: {
    kind: 'cancel' | 'pause';
    at: number;
  } | null = null;
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
      // Pause/cancel/resume are acknowledged by the tool-result response.
      // The proactive "已暂停/已停止" line used to race that response and cut
      // it off mid-word. Suppress control events for a short window after the
      // user's control utterance; task_done/task_failed still speak.
      const isControlEvent =
        event.type === 'task_paused' ||
        event.type === 'task_cancelled' ||
        event.type === 'task_resumed';
      const controlSuppressed =
        isControlEvent && Date.now() < this.suppressControlProactivityUntil;
      if (this.options.enableProactivity !== false && !controlSuppressed) {
        this.proactivity.onEvent(event);
      }
      this.notifyState();
    });
  }

  async start(): Promise<void> {
    if (this.provider.setContext) {
      const memoryContext =
        (await this.options
          .memoryContextProvider?.()
          .catch((error: unknown) => {
            console.warn('[cyrvis memory] context load failed', error);
            return '';
          })) || '';
      this.provider.setContext(memoryContext);
    }
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

  shouldSuppressReply(): boolean {
    return Date.now() < this.suppressReplyUntil;
  }

  /**
   * Any confirmed barge is a stop request, even when ASR returns empty or
   * mishears "停". Cancel the current response and keep the model silent for
   * a short window so it cannot answer with "好的，已暂停…".
   */
  markUserStop(): void {
    // Qwen can start a follow-up response 2-3s after the barge audio was
    // cancelled. 3s covers the observed 2.3s follow-up while still allowing
    // a real new command to clear the window immediately.
    this.suppressReplyUntil = Date.now() + 3000;
  }

  /**
   * Deterministic barge stop. Do not wait for ASR: a confirmed barge may be a
   * short "停" that the model hears as empty or something else several seconds
   * later. Pause the GUI task and keep the assistant silent.
   */
  handleBargeStop(): void {
    this.markUserStop();
    const status = this.controller.getStatus().status;
    if (['starting', 'executing', 'paused'].includes(status)) {
      void this.controller.pauseTask().catch((error: unknown) => {
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    }
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
    this.clearPlaybackWatchdog();
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
        this.clearPlaybackWatchdog();
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
        if (this.shouldSuppressReply()) {
          return;
        }
        if (final && text.trim()) {
          this.lastAssistantText = text;
        }
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
        this.responseHadAudio = true;
        this.lastAssistantAudioAt = Date.now();
        if (
          this.awake &&
          !this.suppressAudioUntilResponseDone &&
          !this.shouldSuppressReply()
        ) {
          this.callbacks.onAudio?.(pcm16);
        }
      },
      onResponseStarted: () => {
        if (this.shouldSuppressReply()) {
          console.log('[cyrvis voice] suppressed reply after stop command');
          this.provider.cancelResponse();
          return;
        }
        this.assistantTextBuffer = '';
        this.completionGuardTriggered = false;
        this.suppressAudioUntilResponseDone = false;
        this.responseHadAudio = false;
        this.clearPlaybackWatchdog();
        this.ttsSpeaking = true;
        this.proactivity.setTtsSpeaking(true);
        this.notifyState();
      },
      onResponseDone: () => {
        this.assistantTextBuffer = '';
        this.suppressAudioUntilResponseDone = false;
        this.completionGuardTriggered = false;
        this.resetAwakeTimer();
        if (this.responseHadAudio) {
          // The server finished generating audio, but the renderer is still
          // playing the WAV queue. Keep ttsSpeaking=true so proactive lines
          // cannot start a second response and cut this one off.
          this.armPlaybackWatchdog();
        } else {
          this.ttsSpeaking = false;
          this.proactivity.setTtsSpeaking(false);
          this.clearPlaybackWatchdog();
        }
        this.notifyState();
      },
      onPlaybackIdle: () => {
        this.clearPlaybackWatchdog();
        this.ttsSpeaking = false;
        this.proactivity.setTtsSpeaking(false);
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
      // Treat it like a stop for a short window; an unrecognized "停" often
      // arrives here as an empty transcript and must not produce "好的，请问…".
      this.markUserStop();
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

    // Speaker mode: the mic can pick up the assistant's own voice. If ASR
    // returns a short echo of the last reply ("我在", "我来", "我"), do not
    // start another turn; otherwise the model answers itself forever.
    if (this.isSelfEchoTranscript(text)) {
      console.log('[cyrvis voice] self-echo transcript ignored', text);
      this.callbacks.onSelfEcho?.();
      this.provider.cancelResponse();
      return;
    }

    this.lastUserText = text;

    // Safety-critical: stop/pause must act even if the voice model forgets to
    // call the tool (observed in real testing: it said "paused" but the GUI
    // agent kept running).
    const deterministicControl = this.handleDeterministicControl(text);
    const bareStop =
      /^(停|停下|停止|暂停|停一下|停一停|先停|先停一下|别说了|不要说了|stop|cancel)[。！!，,\s]*$/i.test(
        text.trim(),
      );
    if (bareStop) {
      // A bare stop should end playback, not trigger "好的，已暂停…" audio.
      this.markUserStop();
      this.provider.cancelResponse();
    }
    if (deterministicControl) {
      // The tool-result response is the single acknowledgment. Suppress the
      // proactive "已暂停/已停止" line that would otherwise race it.
      this.suppressControlProactivityUntil = Date.now() + 5000;
    }

    // After a stop, a real new command should not be delayed by the 3s
    // anti-acknowledgment window. Numeric/short fragments are usually TTS
    // echo or noise, so they do not clear it.
    if (this.shouldSuppressReply() && !bareStop) {
      const trimmed = text.trim();
      if (trimmed.length >= 3 && !/^\d+$/.test(trimmed)) {
        this.suppressReplyUntil = 0;
        console.log('[cyrvis voice] new command after stop; allowing reply');
      }
    }

    if (!this.awake) {
      const decision = classifyIntent(text);
      const autoWake =
        this.options.autoWakeOnTask !== false &&
        (decision.kind === 'task' || decision.kind === 'control');

      if (this.isWakePhrase(text) || autoWake) {
        this.wake();
      } else {
        // The model may already be answering background speech. Suppress it.
        console.log('[cyrvis voice] asleep; transcript ignored', text);
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
        this.suppressControlProactivityUntil = Date.now() + 5000;
        if (
          this.lastDeterministicControl?.kind === 'cancel' &&
          Date.now() - this.lastDeterministicControl.at < 4000
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: true,
              status: this.controller.getStatus().status,
              message: 'ALREADY_HANDLED',
            }),
          );
          break;
        }
        const task = await this.controller.cancelTask(call.args.task_id);
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({ ok: true, status: task.status }),
        );
        break;
      }
      case 'pause_gui_task': {
        this.suppressControlProactivityUntil = Date.now() + 5000;
        if (
          this.lastDeterministicControl?.kind === 'pause' &&
          Date.now() - this.lastDeterministicControl.at < 4000
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: true,
              status: this.controller.getStatus().status,
              message: 'ALREADY_HANDLED',
            }),
          );
          break;
        }
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
      case 'remember_fact': {
        const text = call.args.text?.trim();
        if (!text || !this.options.rememberFact) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: long-term memory is unavailable or the fact is empty.',
          );
          break;
        }
        try {
          await this.options.rememberFact(text);
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({ ok: true, remembered: text }),
          );
        } catch (error) {
          this.provider.sendToolResult(
            call.callId,
            `ERROR: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
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

  private handleDeterministicControl(text: string): 'cancel' | 'pause' | null {
    const status = this.controller.getStatus().status;
    const active = ['starting', 'executing', 'paused', 'cancelling'].includes(
      status,
    );
    if (!active) {
      return null;
    }

    const explicitCancel =
      /(取消|算了|不想|不要|不用|停止|停下|别动|stop|cancel)/i.test(text) ||
      /(^|[\s，。])停([\s，。！？]|$)/.test(text);
    const pause = /(暂停|等一下|等等|pause)/i.test(text);

    if (explicitCancel) {
      this.lastDeterministicControl = { kind: 'cancel', at: Date.now() };
      // Set this before calling the controller: cancelTask can emit
      // task_cancelled synchronously, and that event must not trigger the
      // proactive "已停止" line.
      this.suppressControlProactivityUntil = Date.now() + 5000;
      void this.controller.cancelTask().catch((error: unknown) => {
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
      return 'cancel';
    }
    if (pause) {
      this.lastDeterministicControl = { kind: 'pause', at: Date.now() };
      this.suppressControlProactivityUntil = Date.now() + 5000;
      void this.controller.pauseTask().catch((error: unknown) => {
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
      return 'pause';
    }
    return null;
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

  private isSelfEchoTranscript(text: string): boolean {
    if (!this.lastAssistantText.trim()) {
      return false;
    }
    // Only close to recent assistant audio; this avoids treating an unrelated
    // "我在" much later as an echo.
    if (Date.now() - this.lastAssistantAudioAt > 3000) {
      return false;
    }
    const strip = (value: string) =>
      normalize(value).replace(/[，。！？,.!?\s]/g, '');
    const heard = strip(text);
    if (!heard) {
      return false;
    }
    const spoken = strip(this.lastAssistantText);
    if (spoken.includes(heard) || heard.includes(spoken)) {
      return true;
    }
    // ASR often truncates the assistant's short acknowledgement in speaker
    // mode. Keep this list deliberately narrow so a real "停" is unaffected.
    return /^(我在|我来|我|在听|我听到了|听到|嗯+|啊+|好+)$/.test(heard);
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

  private armPlaybackWatchdog(): void {
    this.clearPlaybackWatchdog();
    this.playbackWatchdog = setTimeout(() => {
      this.playbackWatchdog = null;
      console.warn('[cyrvis voice] playback idle watchdog fired');
      this.ttsSpeaking = false;
      this.proactivity.setTtsSpeaking(false);
      this.notifyState();
    }, 15_000);
  }

  private clearPlaybackWatchdog(): void {
    if (this.playbackWatchdog) {
      clearTimeout(this.playbackWatchdog);
      this.playbackWatchdog = null;
    }
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
