/**
 * Composer.api.ts — server-safe fetch functions.
 * Called from Server Components (page.tsx) for initial data loading.
 * No React imports. Pure async functions.
 */

import type { ComposerPost, ComposerStats, EmergingTopic } from '@/lib/api';

import { getApiUrl } from '@/lib/apiUrl';

const API_URL = getApiUrl();

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    cache: 'no-store', // always fresh — queue changes frequently
  });
  if (!res.ok) throw new Error(`API ${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

export async function fetchQueue(): Promise<ComposerPost[]> {
  try {
    return await get<ComposerPost[]>('/api/composer/queue');
  } catch {
    return [];
  }
}

export async function fetchStats(): Promise<ComposerStats> {
  try {
    return await get<ComposerStats>('/api/composer/stats');
  } catch {
    return {
      date: new Date().toISOString().slice(0, 10),
      twitter: { count: 0, limit: 16 },
      linkedin: { count: 0, limit: 50 },
    };
  }
}

export async function fetchTodayTopics(): Promise<EmergingTopic[]> {
  try {
    return await get<EmergingTopic[]>('/api/intelligence/topics?days=1');
  } catch {
    return [];
  }
}

export async function fetchHistory(): Promise<ComposerPost[]> {
  try {
    return await get<ComposerPost[]>('/api/composer/history');
  } catch {
    return [];
  }
}
