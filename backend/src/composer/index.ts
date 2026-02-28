import { supabase } from '../db/supabase.js';
import { getAdapter } from './adapters/index.js';
import { isAtDailyLimit, incrementDailyCount } from './counter.js';
import type { Platform, ComposerPost } from './types.js';

/**
 * Publishes a single post through its platform adapter.
 *
 * Flow:
 * 1. Check daily rate limit — skip if at limit
 * 2. Look up the correct adapter (twitter, linkedin, etc.)
 * 3. Call adapter.publish() — adapters never throw
 * 4. Update the post row with result (published or failed)
 * 5. Increment daily counter on success
 */
export async function publishPost(post: ComposerPost): Promise<void> {
  const platform = post.platform as Platform;

  // Rate limit check
  if (await isAtDailyLimit(platform)) {
    console.warn(`[composer] Daily limit reached for ${platform}. Marking post #${post.id} as failed.`);
    await supabase
      .from('posts')
      .update({
        status: 'failed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', post.id);
    return;
  }

  // Adapter lookup
  const adapter = getAdapter(platform);
  if (!adapter) {
    console.error(`[composer] No adapter for platform "${platform}".`);
    await supabase
      .from('posts')
      .update({
        status: 'failed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', post.id);
    return;
  }

  console.log(`[composer] Publishing post #${post.id} to ${platform}...`);
  const result = await adapter.publish(post.content);

  if (result.success) {
    await supabase
      .from('posts')
      .update({
        status: 'published',
        published_at: new Date().toISOString(),
        platform_post_id: result.postId || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', post.id);

    await incrementDailyCount(platform);
    console.log(`[composer] Post #${post.id} published successfully. Platform ID: ${result.postId || 'n/a'}`);
  } else {
    await supabase
      .from('posts')
      .update({
        status: 'failed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', post.id);

    console.error(`[composer] Post #${post.id} failed: ${result.error}`);
  }
}
