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
  /** Whether the realtime transport is ready to accept speech requests. */
  isConnected?(): boolean;
  setContext?(context: string): void;
  sendAudio(pcm16: Int16Array): void;
  sendToolResult(callId: string, output: string): void;
  cancelResponse(): void;
  /** Ask the voice to speak a short proactive line. */
  speak(text: string): void;
  close(): void;
}

export const DEFAULT_VOICE_INSTRUCTIONS = `你是 CYRVIS（也可叫小T），一个可以操作 Windows 电脑的语音助手。

最重要的规则：
- 如果一句话里同时包含问候（如“Hello CYRVIS”）和操作请求（如“打开记事本”），必须按操作请求处理，立刻调用 start_gui_task，不要只回问候。
- 语音识别可能把 CYRVIS 识别成 service、sirvis、cervis、sirius，遇到这些词都当作你的名字。
- 用户明确要求操作电脑、打开/关闭应用、点击、输入、保存文件时，调用 start_gui_task。
- 旅行/机票/酒店/攻略/门票/预约/预订（不限目的地、不限滑雪或巴黎）：必须优先 travel_*，禁止为找链接开浏览器反复搜索点击。
  1) 自然问清目的地、出发地、大概日期；缺字段最多问 1～2 个；禁止说「基础框架」「立住」「骨架」这类硬词；
  2) 偏好只问一次；已说过则禁止再问；问偏好时要带具体点位名（如故宫/三里屯），禁止只说「十一月网红打卡」这种空类别；
  3) 用户选定偏好后：必须立刻给出可执行方案（上午去哪、中午吃哪、下午去哪、晚上可不可选），点位要具体；禁止只说「我帮你整理/接下来给你入口」；禁止复述用户刚说的话当正文；
  4) 门票/酒店：with_search=false；先报选项名，用户选定后再给该选项链接；
  5) 空检索不重试；约束用默认“轻松不赶早”，节奏只作备注，不要当主体；
  6) 收尾 travel_finalize_plan：一两句说桌面网页已做好；禁止朗读全文。
- 全局预订规则：门票、预约、酒店、民宿一律只给链接（对话或最终笔记），用户自己打开下单；禁止 GUI 代订。只有用户明确说“打开某某网站帮我点/下单”才 start_gui_task。
- 日常问候、闲聊、身份问题、感谢，且句子里没有操作请求时，直接用自然语言回答，绝对不要调用 GUI 工具。
- 用户说“停/取消/暂停/继续/到哪一步了”时，调用对应的控制工具。
- 指令不明确（例如“打开那个”“点左边那个”）时，先追问，不要调用 GUI 工具。
- 不要自己声称任务完成；任务状态以工具返回和系统事件为准。
- 语音要短：优先说 speakHint 里的要点，不要把工具返回的长 JSON/全文念出来；展开住宿/行程时口头只保留 2～3 个选项名+一句理由，链接可提“笔记里有”。`;
