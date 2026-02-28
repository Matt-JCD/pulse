import OAuth from 'oauth-1.0a';
import crypto from 'crypto';
import type { PlatformResult } from '../types.js';

const TWITTER_TWEET_URL = 'https://api.twitter.com/2/tweets';

/**
 * Publishes a tweet to X using the v2 API with OAuth 1.0a user-context auth.
 * Never throws — always returns a PlatformResult.
 */
export async function publish(content: string): Promise<PlatformResult> {
  try {
    const apiKey = process.env.X_API_KEY;
    const apiSecret = process.env.X_API_SECRET;
    const accessToken = process.env.X_ACCESS_TOKEN;
    const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET;

    if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
      return {
        platform: 'twitter',
        success: false,
        error: 'X API credentials not configured. Set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET.',
      };
    }

    // X enforces 280 chars. Truncate with ellipsis if needed.
    const tweetText = content.length > 280 ? content.slice(0, 277) + '...' : content;

    const oauth = new OAuth({
      consumer: { key: apiKey, secret: apiSecret },
      signature_method: 'HMAC-SHA1',
      hash_function(baseString: string, key: string) {
        return crypto.createHmac('sha1', key).update(baseString).digest('base64');
      },
    });

    const token = { key: accessToken, secret: accessTokenSecret };
    const requestData = { url: TWITTER_TWEET_URL, method: 'POST' as const };
    const authHeader = oauth.toHeader(oauth.authorize(requestData, token));

    const res = await fetch(TWITTER_TWEET_URL, {
      method: 'POST',
      headers: {
        ...authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: tweetText }),
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        platform: 'twitter',
        success: false,
        error: `X API ${res.status}: ${body}`,
      };
    }

    const data = (await res.json()) as { data?: { id?: string } };
    const postId = data.data?.id;

    return {
      platform: 'twitter',
      success: true,
      postId: postId || undefined,
      url: postId ? `https://x.com/i/status/${postId}` : undefined,
    };
  } catch (err) {
    return {
      platform: 'twitter',
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
