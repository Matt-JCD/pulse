/**
 * Intelligence.api.ts — server-safe fetch functions.
 * Called directly from Server Components (page.tsx).
 * No React imports. Pure async functions.
 */

import type {
  DailyReport,
  EmergingTopic,
  KeywordSignal,
  RunLogEntry,
} from '@/lib/api';

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    cache: 'no-store', // always fresh — this is a daily digest
  });
  if (!res.ok) throw new Error(`API ${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

export async function fetchTodayReport(): Promise<DailyReport | null> {
  try {
    const data = await get<DailyReport | { date: string; status: string }>(
      '/api/intelligence/today',
    );
    // Backend returns { date, status: 'no_report_yet' } when nothing exists
    if ('status' in data && data.status === 'no_report_yet') return null;
    return data as DailyReport;
  } catch {
    return null;
  }
}

export async function fetchKeywordSignals(days = 14): Promise<KeywordSignal[]> {
  try {
    return await get<KeywordSignal[]>(`/api/intelligence/keywords?days=${days}`);
  } catch {
    return [];
  }
}

export async function fetchTopics(days = 7): Promise<EmergingTopic[]> {
  try {
    return await get<EmergingTopic[]>(`/api/intelligence/topics?days=${days}&mode=active`);
  } catch {
    return [];
  }
}

export async function fetchRunLog(): Promise<RunLogEntry[]> {
  try {
    return await get<RunLogEntry[]>('/api/intelligence/run-log');
  } catch {
    return [];
  }
}
