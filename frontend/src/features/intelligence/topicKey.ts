import type { EmergingTopic } from '@/lib/api';

function normalizeTopicTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Builds a stable-ish key for cross-day topic matching.
 * We include category + keyword + normalized title to avoid
 * accidental collisions across unrelated tracks.
 */
export function getTopicKey(topic: EmergingTopic): string {
  if (topic.topic_key && topic.topic_key.trim().length > 0) {
    return topic.topic_key;
  }

  return [
    topic.category.toLowerCase(),
    topic.keyword.toLowerCase(),
    normalizeTopicTitle(topic.topic_title),
  ].join('::');
}
