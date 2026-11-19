/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, beforeEach } from 'vitest';

import {
  TravelPlanner,
  isExplicitTravelGuiRequest,
  isTravelPlanningText,
  softBridgePhrase,
} from './travel-planner';
import { buildSeasonContext, inferTravelMonth } from './travel-season';

describe('TravelPlanner', () => {
  let planner: TravelPlanner;

  beforeEach(() => {
    planner = new TravelPlanner();
  });

  it('detects travel planning vs explicit GUI booking', () => {
    expect(isTravelPlanningText('给我看看去巴黎的机票')).toBe(true);
    expect(isExplicitTravelGuiRequest('给我看看去巴黎的机票')).toBe(false);
    expect(isExplicitTravelGuiRequest('打开携程帮我下单')).toBe(true);
  });

  it('collects framework then enters preference probing', () => {
    const first = planner.updateFramework({
      userText: '给我看看去巴黎的机票',
    });
    expect(first.phase).toBe('collecting_framework');
    expect(first.framework.destination).toBe('巴黎');

    const second = planner.updateFramework({
      origin: '上海',
      startDate: '下周五',
      endDate: '下下周日',
      companions: '两个人',
      budget: '3000元以内',
    });
    expect(second.phase).toBe('probing_preferences');
    expect(second.speakHint).toMatch(/travel_probe_highlights|亮点|偏好/);
  });

  it('probes highlights, sets preference, then constraint card before expand', () => {
    planner.updateFramework({
      destination: '巴黎',
      origin: '上海',
      startDate: '12月20日',
      endDate: '12月27日',
    });

    planner.setHighlights([
      { interest: 'food', title: '法式小酒馆' },
      { interest: 'checkin', title: '圣心堂阶梯' },
      { interest: 'landmark', title: '卢浮宫' },
      { interest: 'experience', title: '圣诞市场' },
    ]);

    const preferred = planner.setPreference('我更喜欢吃美食');
    expect(preferred.primaryInterest).toBe('food');
    expect(preferred.phase).toBe('collecting_constraints');
    expect(preferred.speakHint).toMatch(/约束卡片|走路|早起|排队/);

    const constrained = planner.setConstraints({
      userText: '不能走太多，不早起，排队还可以',
    });
    expect(constrained.constraints.okWithWalking).toBe(false);
    expect(constrained.constraints.okWithEarlyStart).toBe(false);
    expect(constrained.constraints.okWithQueues).toBe(true);
    expect(constrained.phase).toBe('awaiting_expand_choice');
    expect(constrained.speakHint).toMatch(/先记到这里|再加上|完善/);

    const expanded = planner.expandAspect('每日行程', undefined, [
      '法式小酒馆 Le Comptoir',
      '马莱区咖啡馆散步',
    ]);
    expect(expanded.speakHint).toMatch(/可执行选项/);
    expect(expanded.speakHint).toMatch(/法式小酒馆|马莱/);
    expect(expanded.speakHint).toMatch(/出发偏晚|少步行|地铁/);
    expect(softBridgePhrase('done')).toMatch(
      /先考虑到这里|先停在这版|先这样收/,
    );
  });

  it('does not re-ask preference when user already chose and asks for lodging', () => {
    planner.updateFramework({
      destination: '巴黎',
      origin: '上海',
      startDate: '12月20日',
      endDate: '12月27日',
      userText: '我想去巴黎玩，主打美食',
    });
    planner.syncFromConversation([
      '我想去巴黎玩，主打美食',
      '嗯，看一下住宿吧。',
    ]);
    expect(planner.getSnapshot().primaryInterest).toBe('food');

    const expanded = planner.expandAspect(
      '住宿',
      undefined,
      ['拉丁区步行可达的精品酒店', '圣日耳曼夜生活方便的公寓'],
      '嗯，看一下住宿吧。',
    );
    expect(expanded.speakHint).not.toMatch(/还没选定旅行偏好/);
    expect(expanded.speakHint).toMatch(/可执行选项/);
    expect(expanded.speakHint).toMatch(/拉丁区|圣日耳曼/);
    expect(expanded.phase).toBe('awaiting_expand_choice');
  });

  it('idle follow-up stops repeating preference probe after one ask', () => {
    planner.updateFramework({
      destination: '巴黎',
      origin: '上海',
      startDate: '12月20日',
      endDate: '12月27日',
    });
    planner.setHighlights([
      { interest: 'food', title: '法式小酒馆' },
      { interest: 'landmark', title: '卢浮宫' },
    ]);
    const first = planner.buildIdleSuggestion(['基础框架好了']);
    expect(first).toMatch(/想主打哪一类|美食|打卡/);
    const second = planner.buildIdleSuggestion(['十点吧。']);
    expect(second).not.toMatch(/还没选定旅行偏好/);
    expect(second).toMatch(/经典必去|可落地|具体/);
    const third = planner.buildIdleSuggestion(['嗯，看一下住宿吧。']);
    expect(third).toMatch(/住宿|具体推荐/);
    expect(third).not.toMatch(/旅行偏好/);
  });

  it('infers month and festival hints for seasonal search', () => {
    expect(inferTravelMonth('12月20日')).toBe(12);
    const season = buildSeasonContext('12月20日', '12月27日');
    expect(season.monthLabel).toBe('十二月');
    expect(season.festivalHints.join('')).toMatch(/圣诞|跨年/);
    expect(season.queryExtra).toMatch(/十二月|圣诞/);
  });
});
