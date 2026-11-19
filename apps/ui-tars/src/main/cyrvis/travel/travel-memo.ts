/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { app, shell } from 'electron';

import type { TravelPlanSnapshot } from './travel-planner';
import { aspectLabel, interestLabel } from './travel-planner';

export interface TravelMemoEntry {
  id: string;
  createdAt: number;
  kind: string;
  title: string;
  body: string;
}

interface TravelMemoFile {
  version: 1;
  entries: TravelMemoEntry[];
}

const MAX_ENTRIES = 200;

const getMemoPath = (): string =>
  path.join(app.getPath('userData'), 'cyrvis-travel-memos.json');

const readMemos = async (): Promise<TravelMemoFile> => {
  try {
    const parsed = JSON.parse(
      await readFile(getMemoPath(), 'utf8'),
    ) as Partial<TravelMemoFile>;
    return {
      version: 1,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch {
    return { version: 1, entries: [] };
  }
};

const writeMemos = async (file: TravelMemoFile): Promise<void> => {
  await mkdir(path.dirname(getMemoPath()), { recursive: true });
  await writeFile(getMemoPath(), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
};

export const appendTravelMemo = async (
  kind: string,
  title: string,
  body: string,
): Promise<TravelMemoEntry | null> => {
  const normalizedTitle = title.trim();
  const normalizedBody = body.trim();
  if (!normalizedTitle || !normalizedBody) return null;

  const file = await readMemos();
  const entry: TravelMemoEntry = {
    id: randomUUID(),
    createdAt: Date.now(),
    kind: kind.trim() || 'note',
    title: normalizedTitle.slice(0, 80),
    body: normalizedBody.slice(0, 4000),
  };
  file.entries = [...file.entries, entry].slice(-MAX_ENTRIES);
  await writeMemos(file);
  return entry;
};

export const listRecentTravelMemos = async (
  limit = 12,
): Promise<TravelMemoEntry[]> => {
  const file = await readMemos();
  return file.entries.slice(-limit);
};

export const formatTravelPlanSummary = (
  plan: TravelPlanSnapshot,
  recentMemos: TravelMemoEntry[] = [],
): string => {
  const f = plan.framework;
  const lines: string[] = [
    'CYRVIS 旅行计划备忘录',
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    '【基础框架】',
    `- 路线：${f.origin || '待定'} → ${f.destination || '待定'}`,
    `- 时间：${[f.startDate, f.endDate].filter(Boolean).join(' ~ ') || '待定'}`,
    `- 同行：${f.companions || '待定'}`,
    `- 预算：${f.budget || '待定'}`,
    `- 大交通：${f.transport || '待定'}`,
    `- 主题：${f.purpose || plan.interestLabel || '待定'}`,
    '',
  ];

  if (plan.primaryInterest) {
    lines.push(`【旅行偏好】${interestLabel(plan.primaryInterest)}`);
  }
  if (plan.constraints) {
    const c = plan.constraints;
    lines.push(
      '【约束卡片】',
      `- 步行较多：${formatConstraint(c.okWithWalking)}`,
      `- 早起出行：${formatConstraint(c.okWithEarlyStart)}`,
      `- 热门排队：${formatConstraint(c.okWithQueues)}`,
      c.notes ? `- 补充：${c.notes}` : '',
      '',
    );
  }

  if (plan.highlights.length) {
    lines.push('【亮点试探】');
    for (const item of plan.highlights) {
      lines.push(
        `- ${interestLabel(item.interest)}：${item.title}${item.detail ? `（${item.detail}）` : ''}`,
      );
    }
    lines.push('');
  }

  if (plan.aspects.length) {
    lines.push('【已展开板块】');
    for (const item of plan.aspects) {
      lines.push(`- ${aspectLabel(item.aspect)}：${item.summary}`);
    }
    lines.push('');
  }

  if (plan.skeleton) {
    lines.push('【骨架摘要】', plan.skeleton, '');
  }

  if (recentMemos.length) {
    lines.push('【对话备忘摘录】');
    for (const memo of recentMemos.slice(-8)) {
      lines.push(`- ${memo.title}：${memo.body}`);
    }
    lines.push('');
  }

  lines.push(
    '【说明】',
    '这是语音规划过程的整理结果，价格与开放时间请以订票网站实时信息为准。',
    '你之后想起来要改的，直接跟我说，我们再往这份计划上加。',
    '',
  );

  return lines.filter((line) => Boolean(line) || line === '').join('\n');
};

const formatConstraint = (value?: boolean | null): string => {
  if (value === true) return '可以接受';
  if (value === false) return '尽量避免';
  return '未确认';
};

export const writeTravelPlanDesktopTxt = async (
  plan: TravelPlanSnapshot,
): Promise<{ memoPath: string; desktopPath: string }> => {
  const recent = await listRecentTravelMemos(12);
  const summary = formatTravelPlanSummary(plan, recent);
  await appendTravelMemo('finalize', '旅行计划敲定摘要', summary);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = (plan.framework.destination || '旅行').replace(
    /[\\/:*?"<>|]/g,
    '_',
  );
  const desktopPath = path.join(
    app.getPath('desktop'),
    `CYRVIS旅行计划-${dest}-${stamp}.txt`,
  );
  await writeFile(desktopPath, `\uFEFF${summary}\n`, 'utf8');
  await shell.openPath(desktopPath);

  return { memoPath: getMemoPath(), desktopPath };
};
