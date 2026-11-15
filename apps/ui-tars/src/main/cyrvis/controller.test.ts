/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CyrvisController,
  EmptyInstructionError,
  TaskBusyError,
} from './controller';
import type { ControllerEvent, GUIAdapter, GUIAdapterCallbacks } from './types';

class FakeGUIAdapter implements GUIAdapter {
  callbacks: GUIAdapterCallbacks | null = null;
  instruction = '';
  cancelCalls = 0;
  pauseCalls = 0;
  resumeCalls = 0;
  private resolveStart: (() => void) | null = null;

  start(instruction: string, callbacks: GUIAdapterCallbacks): Promise<void> {
    this.instruction = instruction;
    this.callbacks = callbacks;
    callbacks.onStarted();
    return new Promise<void>((resolve) => {
      this.resolveStart = resolve;
    });
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
    this.callbacks?.onCancelled();
  }

  async pause(): Promise<void> {
    this.pauseCalls += 1;
    this.callbacks?.onPaused();
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    this.callbacks?.onResumed();
  }

  step(index: number, summary: string, actionType = 'click'): void {
    this.callbacks?.onStep({ index, summary, actionType });
  }

  finish(summary = '任务完成'): void {
    this.callbacks?.onDone(summary);
    this.resolveStart?.();
  }

  fail(error = 'boom'): void {
    this.callbacks?.onFailed(error);
    this.resolveStart?.();
  }

  needsUser(question: string): void {
    this.callbacks?.onNeedsUser(question);
  }
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const setup = (options?: { stallTimeoutMs?: number }) => {
  const adapter = new FakeGUIAdapter();
  const controller = new CyrvisController(adapter, {
    stallTimeoutMs: options?.stallTimeoutMs ?? 0,
    idFactory: () => 'task-1',
  });
  const events: ControllerEvent[] = [];
  controller.onEvent((event) => events.push(event));
  return { adapter, controller, events };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('CyrvisController', () => {
  it('starts a task and emits started/executing events', async () => {
    const { adapter, controller, events } = setup();

    const snapshot = controller.startTask('Open Notepad', 'voice');
    await flush();

    expect(snapshot.status).toBe('starting');
    expect(adapter.instruction).toBe('Open Notepad');
    expect(controller.getStatus().status).toBe('executing');
    expect(events.map((event) => event.type)).toEqual([
      'task_started',
      'task_executing',
    ]);
  });

  it('rejects empty instructions', () => {
    const { controller } = setup();
    expect(() => controller.startTask('   ')).toThrow(EmptyInstructionError);
  });

  it('rejects a second task while one is running', async () => {
    const { controller } = setup();
    controller.startTask('first');
    await flush();

    expect(() => controller.startTask('second')).toThrow(TaskBusyError);
  });

  it('tracks steps and completes a task', async () => {
    const { adapter, controller, events } = setup();
    controller.startTask('Open Notepad');
    await flush();

    adapter.step(1, '点击目标');
    adapter.step(2, '输入文本', 'type');
    adapter.finish('任务完成');

    const snapshot = controller.getStatus();
    expect(snapshot.status).toBe('done');
    expect(snapshot.step).toBe(2);
    expect(snapshot.lastSummary).toBe('输入文本');
    expect(events.some((event) => event.type === 'task_done')).toBe(true);
  });

  it('cancels the active task', async () => {
    const { adapter, controller, events } = setup();
    controller.startTask('Open Notepad');
    await flush();

    await controller.cancelTask();

    expect(adapter.cancelCalls).toBe(1);
    expect(controller.getStatus().status).toBe('cancelled');
    expect(events.some((event) => event.type === 'task_cancelled')).toBe(true);
  });

  it('emits task_stalled when no step arrives', async () => {
    vi.useFakeTimers();
    const { controller, events } = setup({ stallTimeoutMs: 5000 });

    controller.startTask('Open Notepad');
    await flush();
    vi.advanceTimersByTime(5000);

    expect(events.some((event) => event.type === 'task_stalled')).toBe(true);
  });

  it('emits task_needs_user without ending the task', async () => {
    const { adapter, controller, events } = setup();
    controller.startTask('Open Notepad');
    await flush();

    adapter.needsUser('你是指 Chrome 吗？');

    expect(events.some((event) => event.type === 'task_needs_user')).toBe(true);
    expect(controller.getStatus().status).toBe('executing');
  });

  it('pauses and resumes a task', async () => {
    const { adapter, controller } = setup();
    controller.startTask('Open Notepad');
    await flush();

    await controller.pauseTask();
    expect(controller.getStatus().status).toBe('paused');
    expect(adapter.pauseCalls).toBe(1);

    await controller.resumeTask();
    expect(controller.getStatus().status).toBe('executing');
    expect(adapter.resumeCalls).toBe(1);
  });

  it('records failures', async () => {
    const { adapter, controller, events } = setup();
    controller.startTask('Open Notepad');
    await flush();

    adapter.fail('model timeout');

    expect(controller.getStatus().status).toBe('failed');
    expect(controller.getStatus().error).toBe('model timeout');
    expect(events.some((event) => event.type === 'task_failed')).toBe(true);
  });
});
