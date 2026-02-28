function normalizeTopicTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildTopicKey(category: string, keyword: string, topicTitle: string): string {
  return [
    category.toLowerCase(),
    keyword.toLowerCase(),
    normalizeTopicTitle(topicTitle),
  ].join('::');
}
