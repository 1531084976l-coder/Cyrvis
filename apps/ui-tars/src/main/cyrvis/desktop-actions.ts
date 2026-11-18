import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { shell } from 'electron';

import { logger } from '@main/logger';

export type SearchEngine = 'bing' | 'baidu' | 'google';
export type AllowedApp = 'vscode' | 'chrome' | 'explorer' | 'notepad';

const execFileAsync = promisify(execFile);

const SEARCH_ENDPOINTS: Record<SearchEngine, string> = {
  bing: 'https://www.bing.com/search?q=',
  baidu: 'https://www.baidu.com/s?wd=',
  google: 'https://www.google.com/search?q=',
};

const assertHttpUrl = (value: string): URL => {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }
  return url;
};

export const buildSearchUrl = (
  query: string,
  engine: SearchEngine = 'bing',
  site?: string,
): string => {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error('search query is empty');
  }
  const normalizedSite = site?.trim().replace(/^https?:\/\//i, '');
  if (normalizedSite && !/^[A-Za-z0-9.-]+$/.test(normalizedSite)) {
    throw new Error(`invalid site filter: ${site}`);
  }
  const fullQuery = normalizedSite
    ? `${trimmed} site:${normalizedSite}`
    : trimmed;
  return `${SEARCH_ENDPOINTS[engine]}${encodeURIComponent(fullQuery)}`;
};

/**
 * Windows uses Bing; macOS uses Safari's default search engine. The caller can
 * still override the engine explicitly.
 */
export const defaultSearchEngine = (): SearchEngine =>
  process.platform === 'darwin' ? 'google' : 'bing';

export const openUrl = async (value: string): Promise<string> => {
  const url = assertHttpUrl(value.trim());
  logger.info('[cyrvis desktop] opening url', { url: url.toString() });
  await shell.openExternal(url.toString());
  return url.toString();
};

/**
 * Search opens in the platform's native browser: Bing on Windows, Safari on
 * macOS. If Safari is unavailable, fall back to the default browser.
 */
export const openSearch = async (value: string): Promise<string> => {
  const url = assertHttpUrl(value.trim()).toString();
  logger.info('[cyrvis desktop] opening search', {
    url,
    platform: process.platform,
  });

  if (process.platform === 'darwin') {
    try {
      await execFileAsync('open', ['-a', 'Safari', url], { timeout: 3000 });
      return url;
    } catch (error) {
      logger.warn(
        '[cyrvis desktop] Safari launch failed; using default browser',
        error,
      );
    }
  }

  await shell.openExternal(url);
  return url;
};

const firstExisting = (
  candidates: Array<string | undefined>,
): string | null => {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

const findVscode = () =>
  firstExisting([
    process.env.LOCALAPPDATA
      ? path.join(
          process.env.LOCALAPPDATA,
          'Programs',
          'Microsoft VS Code',
          'Code.exe',
        )
      : undefined,
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe')
      : undefined,
    process.env['ProgramFiles(x86)']
      ? path.join(
          process.env['ProgramFiles(x86)'],
          'Microsoft VS Code',
          'Code.exe',
        )
      : undefined,
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
  ]);

const findChrome = () =>
  firstExisting([
    process.env.ProgramFiles
      ? path.join(
          process.env.ProgramFiles,
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        )
      : undefined,
    process.env['ProgramFiles(x86)']
      ? path.join(
          process.env['ProgramFiles(x86)'],
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        )
      : undefined,
    process.env.LOCALAPPDATA
      ? path.join(
          process.env.LOCALAPPDATA,
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        )
      : undefined,
  ]);

const spawnDetached = (executable: string, args: string[]) => {
  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return child.pid;
};

export const openApp = async (
  app: AllowedApp,
  target?: string,
): Promise<{ app: AllowedApp; target: string | null; pid?: number }> => {
  const trimmedTarget = target?.trim() || '';
  switch (app) {
    case 'vscode': {
      const executable = findVscode();
      if (!executable) {
        throw new Error('VS Code executable was not found');
      }
      const pid = spawnDetached(
        executable,
        trimmedTarget ? [trimmedTarget] : [],
      );
      return { app, target: trimmedTarget || null, pid };
    }
    case 'chrome': {
      const executable = findChrome();
      if (executable) {
        const pid = spawnDetached(executable, [
          '--new-tab',
          trimmedTarget || 'about:blank',
        ]);
        return { app, target: trimmedTarget || null, pid };
      }
      const url = trimmedTarget
        ? assertHttpUrl(trimmedTarget).toString()
        : 'https://www.bing.com';
      await shell.openExternal(url);
      return { app, target: url };
    }
    case 'explorer': {
      const pid = spawnDetached(
        'explorer.exe',
        trimmedTarget ? [trimmedTarget] : [],
      );
      return { app, target: trimmedTarget || null, pid };
    }
    case 'notepad': {
      const pid = spawnDetached(
        'notepad.exe',
        trimmedTarget ? [trimmedTarget] : [],
      );
      return { app, target: trimmedTarget || null, pid };
    }
    default: {
      const exhaustive: never = app;
      throw new Error(`unsupported app: ${String(exhaustive)}`);
    }
  }
};
