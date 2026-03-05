/**
 * MediaLibrary.api.ts — server-safe fetch functions.
 * Called from Server Components (page.tsx) for initial data loading.
 */

import type { Episode } from '@/lib/api';

import { getApiUrl } from '@/lib/apiUrl';

const API_URL = getApiUrl();

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`API ${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

export async function fetchEpisodes(): Promise<Episode[]> {
  try {
    return await get<Episode[]>('/api/media/episodes');
  } catch {
    return [];
  }
}
