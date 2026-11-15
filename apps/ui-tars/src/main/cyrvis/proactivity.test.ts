/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import { ProactivityPolicy } from './proactivity';
import type { ControllerEvent, ProactiveUtterance } from './types';

const setup = (options?: {
  enableSuggestions?: boolean;
  enableProgress?: boolean;
}) => {
  let now = 10_000;
  const utterances: ProactiveUtterance[] = [];
  const policy = new ProactivityPolicy(
    (utterance) => utterances.push(utterance),
    {
      now: () => now,
      enableSuggestions: options?.enableSuggestions,
      enableProgress: options?.enableProgress,
    },
  );

  return {
    policy,
    utterances,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const event = (value: ControllerEvent): ControllerEvent => value;

describe('ProactivityPolicy', () => {
  it('acknowledges a new task immediately', () => {
    const { policy, utterances } = setup();
    policy.onEvent(
      event({
        type: 'task_started',
        taskId: 'task-1',
        instruction: 'Open Notepad',
        source: 'voice',
      }),
    );

    expect(utterances).toHaveLength(1);
    expect(utterances[0].reason).toBe('task_started');
    expect(utterances[0].priority).toBe(1);
  });

  it('does not speak while the user is speaking', () => {
    const { policy, utterances } = setup();
    policy.setUserSpeaking(true);
    policy.onEvent(
      event({ type: 'task_done', taskId: 'task-1', summary: '任务完成' }),
    );

    expect(utterances).toHaveLength(0);
  });

  it('does not speak while TTS is playing', () => {
    const { policy, utterances } = setup();
    policy.setTtsSpeaking(true);
    policy.onEvent(
      event({ type: 'task_failed', taskId: 'task-1', error: 'timeout' }),
    );

    expect(utterances).toHaveLength(0);
  });

  it('respects the minimum gap for progress messages', () => {
    const { policy, utterances, advance } = setup({ enableProgress: true });
    policy.onEvent(
      event({
        type: 'task_started',
        taskId: 'task-1',
        instruction: 'Open Notepad',
        source: 'voice',
      }),
    );
    policy.onEvent(event({ type: 'task_stalled', taskId: 'task-1', step: 1 }));

    expect(utterances).toHaveLength(1);

    advance(3001);
    policy.onEvent(event({ type: 'task_stalled', taskId: 'task-1', step: 1 }));

    expect(utterances).toHaveLength(2);
    expect(utterances[1].reason).toBe('task_stalled');
  });

  it('reports done and only suggests next steps when enabled', () => {
    const { policy, utterances } = setup({ enableSuggestions: true });
    policy.onEvent(
      event({ type: 'task_done', taskId: 'task-1', summary: '任务完成' }),
    );

    expect(utterances[0].text).toContain('还需要我做什么');
  });

  it('speaks clarification questions at highest priority', () => {
    const { policy, utterances } = setup();
    policy.onEvent(
      event({
        type: 'task_needs_user',
        taskId: 'task-1',
        question: '你是指 Chrome 窗口吗？',
      }),
    );

    expect(utterances[0].text).toBe('你是指 Chrome 窗口吗？');
    expect(utterances[0].priority).toBe(0);
  });

  it('does not emit step progress by default', () => {
    const { policy, utterances } = setup();
    policy.onEvent(
      event({
        type: 'step_update',
        taskId: 'task-1',
        step: 3,
        summary: '点击目标',
        actionType: 'click',
      }),
    );

    expect(utterances).toHaveLength(0);
  });
});
