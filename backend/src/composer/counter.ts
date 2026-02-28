import { supabase } from '../db/supabase.js';
import { getSydneyDate } from '../utils/sydneyDate.js';
import type { Platform } from './types.js';

const DAILY_LIMITS: Record<Platform, number> = {
  twitter: 16,
  linkedin: 50, // placeholder — adjust when LinkedIn is live
};

/**
 * Returns the number of posts published on the given platform today (AEST).
 */
export async function getDailyCount(platform: Platform): Promise<number> {
  const today = getSydneyDate();

  const { data } = await supabase
    .from('platform_post_counts')
    .select('count')
    .eq('platform', platform)
    .eq('date', today)
    .single();

  return data?.count ?? 0;
}

/**
 * Atomically increments the daily count using upsert on (platform, date).
 * If no row exists for today, inserts with count=1.
 * If a row exists, increments it.
 */
export async function incrementDailyCount(platform: Platform): Promise<void> {
  const today = getSydneyDate();

  // Read current count
  const { data: existing } = await supabase
    .from('platform_post_counts')
    .select('count')
    .eq('platform', platform)
    .eq('date', today)
    .single();

  if (existing) {
    await supabase
      .from('platform_post_counts')
      .update({ count: existing.count + 1 })
      .eq('platform', platform)
      .eq('date', today);
  } else {
    await supabase
      .from('platform_post_counts')
      .upsert(
        { platform, date: today, count: 1 },
        { onConflict: 'platform,date' },
      );
  }
}

/**
 * Returns true if the platform has reached its daily publishing limit.
 * X limit: 16/day.
 */
export async function isAtDailyLimit(platform: Platform): Promise<boolean> {
  const count = await getDailyCount(platform);
  return count >= (DAILY_LIMITS[platform] ?? 16);
}
