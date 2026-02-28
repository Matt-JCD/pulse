'use client';

import type { EmergingTopic } from '@/lib/api';
import { useMemo } from 'react';
import { buildTrendTopics, getTrendingOverallTop, type TrendTopic } from '../trendModel';
import { cloudEventLabel } from '../storyKey';

interface Props {
  topics: EmergingTopic[];
  todayDate: string;
}

interface CloudWord {
  key: string;
  label: string;
  weight: number;
  urls: string[];
  state: TrendTopic['trendState'];
}

function urlLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace('www.', '');
    if (host.includes('reddit.com')) return 'Reddit thread';
    if (host.includes('ycombinator.com') || host.includes('news.ycombinator')) return 'HN thread';
    if (host.includes('twitter.com') || host.includes('x.com')) return 'Twitter thread';
    return 'Read article';
  } catch {
    return 'Read article';
  }
}

function toTwoWords(label: string): string {
  const words = label
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length <= 2) return words.join(' ');
  return `${words[0]} ${words[1]}`;
}

function stateRank(state: TrendTopic['trendState']): number {
  if (state === 'new') return 4;
  if (state === 'rising') return 3;
  if (state === 'steady') return 2;
  return 1;
}

function buildWords(topics: TrendTopic[]): CloudWord[] {
  const maxScore = Math.max(1, ...topics.map((t) => t.score));
  const byLabel = new Map<string, CloudWord>();

  for (const topic of topics) {
    const eventLabel = toTwoWords(cloudEventLabel(topic.title, topic.keyword));
    const existing = byLabel.get(eventLabel);
    const topicWeight = Math.max(0.25, topic.score / maxScore);

    if (!existing) {
      byLabel.set(eventLabel, {
        key: topic.key,
        label: eventLabel,
        urls: [...topic.urls],
        state: topic.trendState,
        weight: topicWeight,
      });
      continue;
    }

    existing.weight = Math.max(existing.weight, topicWeight);
    existing.urls = Array.from(new Set([...existing.urls, ...topic.urls]));
    if (stateRank(topic.trendState) > stateRank(existing.state)) {
      existing.state = topic.trendState;
      existing.key = topic.key;
    }
  }

  return [...byLabel.values()];
}

function wordColor(state: TrendTopic['trendState']): string {
  if (state === 'new' || state === 'rising') return '#08CAA6';
  if (state === 'fading') return '#666666';
  return '#93D1BD';
}

function wordSize(weight: number): number {
  return Math.round(14 + weight * 20);
}

function CloudPanel({ label, words }: { label: string; words: CloudWord[] }) {
  if (words.length === 0) {
    return (
      <div className="bg-[#111113] rounded-lg border border-zinc-800/60 p-5">
        <p className="text-xs text-zinc-500 uppercase tracking-widest mb-3">{label}</p>
        <p className="text-sm text-zinc-600 text-center py-8">No topics yet - run the collector to populate.</p>
      </div>
    );
  }

  return (
    <div className="bg-[#111113] rounded-lg border border-zinc-800/60 p-5">
      <p className="text-xs text-zinc-500 uppercase tracking-widest mb-3">{label}</p>

      <div className="min-h-[220px] flex flex-wrap items-center gap-x-4 gap-y-2">
        {words.map((word) => {
          const primary = word.urls[0];
          return (
            <a
              key={word.key}
              href={primary || undefined}
              target={primary ? '_blank' : undefined}
              rel={primary ? 'noopener noreferrer' : undefined}
              title={primary ? urlLabel(primary) : 'No source URL'}
              className="leading-none"
              style={{
                color: wordColor(word.state),
                fontSize: `${wordSize(word.weight)}px`,
                opacity: primary ? 1 : 0.6,
                pointerEvents: primary ? 'auto' : 'none',
              }}
            >
              {word.label}
            </a>
          );
        })}
      </div>

      <div className="flex gap-4 mt-2 justify-end">
        <span className="flex items-center gap-1 text-[10px] text-zinc-500">
          <span className="inline-block w-2 h-2 rounded-full bg-[#08CAA6]" /> New / Rising
        </span>
        <span className="flex items-center gap-1 text-[10px] text-zinc-500">
          <span className="inline-block w-2 h-2 rounded-full bg-[#93D1BD]" /> Steady
        </span>
        <span className="flex items-center gap-1 text-[10px] text-zinc-500">
          <span className="inline-block w-2 h-2 rounded-full bg-[#666666]" /> Fading
        </span>
      </div>
    </div>
  );
}

export function WordCloudSection({ topics, todayDate }: Props) {
  const { ecosystemWords, enterpriseWords } = useMemo(() => {
    const ecosystemTrending = getTrendingOverallTop(buildTrendTopics(topics, 'ecosystem', todayDate), 8);
    const enterpriseTrending = getTrendingOverallTop(buildTrendTopics(topics, 'enterprise', todayDate), 8);
    return {
      ecosystemWords: buildWords(ecosystemTrending),
      enterpriseWords: buildWords(enterpriseTrending),
    };
  }, [topics, todayDate]);

  return (
    <div>
      <p className="text-xs text-zinc-500 uppercase tracking-widest mb-4">Trending Topics - Overall</p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CloudPanel label="Ecosystem" words={ecosystemWords} />
        <CloudPanel label="Enterprise AI" words={enterpriseWords} />
      </div>
    </div>
  );
}
