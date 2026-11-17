/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { VoiceToolCall } from '../types';

export type VoiceToolCallWithId = VoiceToolCall & { callId: string };

export interface VoiceProviderCallbacks {
  onReady?: () => void;
  onClose?: () => void;
  onSpeechStarted?: () => void;
  onSpeechStopped?: () => void;
  onTranscript?: (text: string, final: boolean) => void;
  onAssistantText?: (text: string, final: boolean) => void;
  onSpeechText?: (text: string, final: boolean) => void;
  onToolCall?: (call: VoiceToolCallWithId) => void;
  onAudio?: (pcm16: Int16Array) => void;
  onResponseStarted?: () => void;
  onResponseDone?: () => void;
  /** Renderer confirmed the WAV queue is empty (not just response.done). */
  onPlaybackIdle?: () => void;
  onUtteranceCommitted?: () => void;
  onError?: (error: Error) => void;
}

/**
 * Transport boundary for the voice layer.
 * Realtime providers and the streaming cascade implement the same interface,
 * so the Controller / VoiceBrain never depend on a specific vendor.
 */
export interface VoiceProvider {
  connect(): Promise<void>;
  setContext?(context: string): void;
  sendAudio(pcm16: Int16Array): void;
  sendToolResult(callId: string, output: string): void;
  cancelResponse(): void;
  /** Ask the voice to speak a short proactive line. */
  speak(text: string): void;
  close(): void;
}

/**
 * Runtime controls used by the desktop capture/playback shell. Both the
 * realtime omni provider and the ASR -> LLM -> TTS cascade implement this
 * interface so VoiceService does not depend on a vendor-specific class.
 */
export interface InteractiveVoiceProvider extends VoiceProvider {
  beginUtterance?(): void;
  finishUtterance?(): void;
  cancelUtterance?(): void;
  bargeIn(options?: { forceCommit?: boolean }): void;
  clearAudioBuffer(): void;
  muteMicFor(ms: number): void;
  notifyPlaybackIdle(tailMs?: number): void;
  endPtt(): void;
}

export const DEFAULT_VOICE_INSTRUCTIONS = `你是 CYRVIS，一个可以操作 Windows 电脑的语音助手。

最重要的规则：
- 如果一句话里同时包含问候（如“Hello CYRVIS”）和操作请求（如“打开记事本”），必须按操作请求处理，立刻调用 start_gui_task，不要只回问候。
- 语音识别可能把 CYRVIS 识别成 service、sirvis、cervis、sirius，遇到这些词都当作你的名字。
- 用户明确要求操作电脑、打开/关闭应用、浏览器、搜索、点击、输入、保存文件时，调用 start_gui_task。
- 日常问候、闲聊、身份问题、感谢，且句子里没有操作请求时，直接用自然语言回答，绝对不要调用 GUI 工具。
- 用户说“停/取消/暂停/继续/到哪一步了”时，调用对应的控制工具。
- 指令不明确（例如“打开那个”“点左边那个”）时，先追问，不要调用 GUI 工具。
- 不要自己声称任务完成；任务状态以工具返回和系统事件为准。
- 回答简短、口语化，适合语音播报。`;
