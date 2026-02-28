import type { EmergingTopic } from '@/lib/api';
import { TopicCard } from './TopicCard';
import { isSimilarTopic, isSimilarTopicText, similarityTokenSet } from '../similarity';
import { deriveStoryKey } from '../storyKey';

interface Props {
  topics: EmergingTopic[];
  todayDate: string; // YYYY-MM-DD in Sydney time
}

interface MergedTopic {
  topicTitle: string;
  summary: string;
  category: 'ecosystem' | 'enterprise';
  postCount: number;
  links: Array<{ url: string; platform: string }>;
  platforms: string[];
  tokenSet: Set<string>;
  signature: Set<string>;
  matchText: string;
  storyKeys: Set<string>;
}

const MAX_TOPICS = 20;

function buildTokenDocFreq(rows: EmergingTopic[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const row of rows) {
    const tokens = similarityTokenSet(`${row.topic_title} ${row.summary.slice(0, 220)}`);
    for (const token of tokens) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  return df;
}

function buildSignatureFromTokenSet(tokens: Set<string>, docFreq: Map<string, number>): Set<string> {
  const ranked = [...tokens]
    .map((token) => ({ token, df: docFreq.get(token) ?? 9999 }))
    .sort((a, b) => a.df - b.df || a.token.localeCompare(b.token))
    .slice(0, 8)
    .map((item) => item.token);
  return new Set(ranked);
}

function signatureOverlap(a: Set<string>, b: Set<string>): number {
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap++;
  }
  return overlap;
}

function platformBadge(platform: string): string {
  const p = platform.toLowerCase();
  if (p === 'hackernews') return 'HN';
  if (p === 'reddit') return 'Reddit';
  if (p === 'twitter') return 'X';
  return platform;
}

function mergeTopics(items: EmergingTopic[], category: 'ecosystem' | 'enterprise'): MergedTopic[] {
  const rows = items
    .filter((item) => item.category === category)
    .sort((a, b) => b.post_count - a.post_count);
  const docFreq = buildTokenDocFreq(rows);

  const clusters: MergedTopic[] = [];
  for (const row of rows) {
    const matchText = `${row.topic_title} ${row.summary.slice(0, 220)}`;
    const tokens = similarityTokenSet(matchText);
    const signature = buildSignatureFromTokenSet(tokens, docFreq);
    const rowStoryKey = deriveStoryKey(row.topic_title, row.summary, row.keyword);
    const match = clusters.find((cluster) =>
      (rowStoryKey && cluster.storyKeys.has(rowStoryKey)) ||
      signatureOverlap(cluster.signature, signature) >= 3 ||
      (signatureOverlap(cluster.signature, signature) >= 2 &&
        isSimilarTopic(cluster.tokenSet, tokens)) ||
      isSimilarTopic(cluster.tokenSet, tokens) ||
      isSimilarTopicText(cluster.matchText, matchText)
    );

    const links = (row.sample_urls ?? []).map((url) => ({ url, platform: row.platform }));
    const platform = platformBadge(row.platform);

    if (!match) {
      clusters.push({
        topicTitle: row.topic_title,
        summary: row.summary,
        category,
        postCount: row.post_count,
        links,
        platforms: [platform],
        tokenSet: tokens,
        signature,
        matchText,
        storyKeys: new Set(rowStoryKey ? [rowStoryKey] : []),
      });
      continue;
    }

    match.postCount += row.post_count;
    if (row.summary.length > match.summary.length) {
      match.summary = row.summary;
    }
    if (!match.platforms.includes(platform)) {
      match.platforms.push(platform);
    }
    match.links.push(...links);
    for (const token of tokens) {
      match.tokenSet.add(token);
    }
    for (const token of signature) {
      match.signature.add(token);
    }
    if (rowStoryKey) {
      match.storyKeys.add(rowStoryKey);
    }
    match.matchText = `${match.matchText} ${matchText}`.slice(0, 1200);
  }

  return clusters.sort((a, b) => b.postCount - a.postCount);
}

function EmptyState() {
  return (
    <div className="bg-[#111113] rounded-lg p-6 border border-zinc-800/60 text-center">
      <p className="text-sm text-zinc-500">
        No topics yet - run the collector to populate.
      </p>
    </div>
  );
}

export function TopicThreads({ topics, todayDate }: Props) {
  const todayTopics = topics.filter((t) => t.date === todayDate);
  const ecosystem = mergeTopics(todayTopics, 'ecosystem').slice(0, MAX_TOPICS);
  const enterprise = mergeTopics(todayTopics, 'enterprise').slice(0, MAX_TOPICS);

  const hasAny = ecosystem.length > 0 || enterprise.length > 0;

  return (
    <div>
      <p className="text-xs text-zinc-500 uppercase tracking-widest mb-4">
        Topic Threads
      </p>

      {!hasAny ? (
        <EmptyState />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div>
            <p className="text-xs text-zinc-600 mb-3">Ecosystem</p>
            {ecosystem.length === 0 ? (
              <p className="text-xs text-zinc-600 italic">
                No ecosystem topics today.
              </p>
            ) : (
              <div className="space-y-3">
                {ecosystem.map((topic, index) => (
                  <TopicCard key={`${topic.topicTitle}-${index}`} topic={topic} rank={index + 1} />
                ))}
              </div>
            )}
          </div>

          <div>
            <p className="text-xs text-zinc-600 mb-3">Enterprise AI</p>
            {enterprise.length === 0 ? (
              <p className="text-xs text-zinc-600 italic">
                No enterprise topics today.
              </p>
            ) : (
              <div className="space-y-3">
                {enterprise.map((topic, index) => (
                  <TopicCard key={`${topic.topicTitle}-${index}`} topic={topic} rank={index + 1} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
