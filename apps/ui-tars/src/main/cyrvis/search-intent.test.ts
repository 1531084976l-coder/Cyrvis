/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import {
  detectSearchIntent,
  extractSearchQuery,
  isHighConfidenceSearch,
} from './search-intent';

describe('extractSearchQuery', () => {
  it.each([
    ['帮我搜索一下去巴黎的机票', '去巴黎的机票'],
    ['我要去巴黎的机票', '去巴黎的机票'],
    ['我想买一个降噪耳机', '买一个降噪耳机'],
    ['今天天气怎么样', '今天天气'],
    ['我要看看今天上海的天气', '今天上海的天气'],
    ['请帮我查一下携程和去哪儿的机票价格', '携程和去哪儿的机票价格'],
  ])('turns "%s" into "%s"', (text, expected) => {
    expect(extractSearchQuery(text)).toBe(expected);
  });
});

describe('detectSearchIntent', () => {
  it.each([
    '帮我搜索巴黎的机票',
    '我要去巴黎的机票',
    '我想买一个降噪耳机',
    '今天天气怎么样',
    '我要看看最近的新闻',
    '帮我比较一下携程和去哪儿的机票',
    '我要去巴黎',
  ])('detects a high-confidence search need: %s', (text) => {
    const decision = detectSearchIntent(text);
    expect(decision.isSearch).toBe(true);
    expect(decision.confidence).toBe('high');
    expect(decision.query.length).toBeGreaterThan(0);
    expect(isHighConfidenceSearch(text)).toBe(true);
  });

  it.each([
    ['你好', false],
    ['谢谢', false],
    ['你能做什么', false],
    ['打开记事本', false],
    ['我要打开记事本', false],
    ['帮我查一下电脑配置', false],
    ['我要写代码', false],
    ['我想听音乐', false],
    ['今天天气不错', false],
  ])('does not treat "%s" as a high-confidence search', (text) => {
    expect(isHighConfidenceSearch(text)).toBe(false);
  });

  it('keeps pointer-dependent questions out of the GUI redirect path', () => {
    const decision = detectSearchIntent('这个耳机多少钱');
    expect(decision.isSearch).toBe(true);
    expect(decision.confidence).toBe('medium');
  });

  it('treats local configuration lookups as desktop work', () => {
    const decision = detectSearchIntent('帮我查一下电脑配置');
    expect(decision.isSearch).toBe(false);
    expect(decision.reason).toContain('local');
  });
});
