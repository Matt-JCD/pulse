import { supabase } from '../db/supabase.js';
import { getAdapter } from './adapters/index.js';
import { isAtDailyLimit, incrementDailyCount } from './counter.js';
import { getPlatformForAccount } from './accounts.js';
import { embedPost } from '../scheduler/embeddings.js';
import type { Platform, ComposerPost, AccountSlug } from './types.js';

/**
 * Publishes a single post through its platform adapter.
 *
 * Flow:
 * 1. Resolve platform from the post's account
 * 2. Check daily rate limit — skip if at limit
 * 3. Look up the correct adapter (twitter, linkedin, etc.)
 * 4. Call adapter.publish() — adapters never throw
 * 5. Update the post row with result (published or failed)
 * 6. Increment daily counter on success
 */
export async function publishPost(post: ComposerPost): Promise<void> {
  // Resolve platform from account (e.g. agents_after_dark_linkedin → 'linkedin')
  const platform = post.account
    ? getPlatformForAccount(post.account as AccountSlug)
    : post.platform as Platform;

  // Rate limit check
  if (await isAtDailyLimit(platform)) {
    console.warn(`[composer] Daily limit reached for ${platform}. Marking post #${post.id} (${post.account}) as failed.`);
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
    console.error(`[composer] No adapter for platform "${platform}" (account: ${post.account}).`);
    await supabase
      .from('posts')
      .update({
        status: 'failed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', post.id);
    return;
  }

  console.log(`[composer] Publishing post #${post.id} [${post.account}] to ${platform}...`);
  const result = await adapter.publish(post);

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
    console.log(`[composer] Post #${post.id} [${post.account}] published. Platform ID: ${result.postId || 'n/a'}`);

    // Fire-and-forget embedding generation
    embedPost(post.id, post.content);
  } else {
    await supabase
      .from('posts')
      .update({
        status: 'failed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', post.id);

    console.error(`[composer] Post #${post.id} [${post.account}] failed: ${result.error}`);
  }
}
