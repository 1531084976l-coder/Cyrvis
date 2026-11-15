/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export type TaskStatus =
  | 'idle'
  | 'starting'
  | 'executing'
  | 'paused'
  | 'cancelling'
  | 'done'
  | 'failed'
  | 'cancelled';

export type TaskSource = 'voice' | 'text';

export interface TaskRequest {
  taskId: string;
  instruction: string;
  source: TaskSource;
  createdAt: number;
}

export interface TaskSnapshot {
  taskId: string | null;
  status: TaskStatus;
  instruction: string | null;
  source: TaskSource | null;
  step: number;
  lastSummary: string | null;
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

export interface StepUpdate {
  index: number;
  summary: string;
  actionType: string;
}

export interface GUIAdapterCallbacks {
  onStarted: () => void;
  onStep: (step: StepUpdate) => void;
  onNeedsUser: (question: string) => void;
  onPaused: () => void;
  onResumed: () => void;
  onDone: (summary: string) => void;
  onFailed: (error: string) => void;
  onCancelled: () => void;
}

/**
 * Provider-independent GUI executor contract.
 * The real implementation wraps UI-TARS `runAgent`; tests can use a fake.
 */
export interface GUIAdapter {
  start(instruction: string, callbacks: GUIAdapterCallbacks): Promise<void>;
  cancel(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
}

export type VoiceToolCall =
  | {
      name: 'start_gui_task';
      args: { instruction: string; confidence?: number };
    }
  | { name: 'cancel_gui_task'; args: { task_id?: string } }
  | { name: 'pause_gui_task'; args: Record<string, never> }
  | { name: 'resume_gui_task'; args: Record<string, never> }
  | { name: 'get_gui_status'; args: Record<string, never> }
  | {
      name: 'confirm_action';
      args: { task_id: string; approved: boolean };
    };

export type ControllerEvent =
  | {
      type: 'task_started';
      taskId: string;
      instruction: string;
      source: TaskSource;
    }
  | { type: 'task_executing'; taskId: string }
  | {
      type: 'step_update';
      taskId: string;
      step: number;
      summary: string;
      actionType: string;
    }
  | { type: 'task_stalled'; taskId: string; step: number }
  | { type: 'task_needs_user'; taskId: string; question: string }
  | { type: 'task_paused'; taskId: string }
  | { type: 'task_resumed'; taskId: string }
  | { type: 'task_cancelling'; taskId: string }
  | { type: 'task_done'; taskId: string; summary: string }
  | { type: 'task_failed'; taskId: string; error: string }
  | { type: 'task_cancelled'; taskId: string };

export type ProactivityReason =
  | 'task_started'
  | 'task_stalled'
  | 'task_needs_user'
  | 'task_done'
  | 'task_failed'
  | 'task_cancelled'
  | 'progress'
  | 'suggestion';

export type ProactivityPriority = 0 | 1 | 2 | 3;

export interface ProactiveUtterance {
  text: string;
  priority: ProactivityPriority;
  reason: ProactivityReason;
}
