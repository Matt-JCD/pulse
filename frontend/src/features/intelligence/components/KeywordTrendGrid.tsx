'use client';

import React from 'react';
import { LineChart, Line, ResponsiveContainer, Tooltip } from 'recharts';
import type { EmergingTopic } from '@/lib/api';
import {
  buildTrendTopics,
  getNewTodayTop,
  getTrendingOverallTop,
  type TrendTopic,
} from '../trendModel';

const TOP_N = 5;

interface Props {
  topics: EmergingTopic[];
  todayDate: string;
}

function formatDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function toneForState(state: TrendTopic['trendState']): string {
  if (state === 'new' || state === 'rising') return 'text-aqua';
  if (state === 'fading') return 'text-red-400';
  return 'text-zinc-500';
}

function rankLabel(rank: number | null): string {
  return rank ? `#${rank}` : '-';
}

function SparkCard({ topic, color }: { topic: TrendTopic; color: string }) {
  const ageLabel = topic.isNewToday ? 'new' : 'old';

  const cardBody = (
    <div className="bg-[#111113] rounded-lg border border-zinc-800/60 p-3 h-full">
      <div style={{ height: 48 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={topic.data}>
            <Line
              type="monotone"
              dataKey="posts"
              stroke={color}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            <Tooltip
              content={({ active, payload }) =>
                active && payload?.length ? (
                  <div className="bg-[#0A0A0B] border border-zinc-800 rounded px-2 py-1 text-[10px] text-zinc-300">
                    {payload[0].payload.date}: {payload[0].value} posts
                  </div>
                ) : null
              }
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="text-[11px] text-zinc-400 leading-tight line-clamp-2 mt-1.5 mb-1">{topic.title}</p>

      <div className="flex items-center gap-1.5 tabular-nums flex-wrap">
        <span className="text-[10px] text-zinc-500">today {rankLabel(topic.todayRank)}</span>
        <span className={`text-[10px] font-medium ${toneForState(topic.trendState)}`}>{ageLabel}</span>
        <span className="text-[10px] text-zinc-500">yesterday {rankLabel(topic.yesterdayRank)}</span>
        <span className="text-[10px] text-zinc-600">started {formatDate(topic.firstSeen)}</span>
      </div>
    </div>
  );

  if (!topic.primaryUrl) return cardBody;

  return (
    <a
      href={topic.primaryUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-aqua/60"
      title="Open most relevant thread"
    >
      {cardBody}
    </a>
  );
}

function TopicRow({ label, items, color }: { label: string; items: TrendTopic[]; color: string }) {
  return (
    <div>
      <p className="text-xs text-zinc-600 mb-2">{label}</p>
      {items.length === 0 ? (
        <div className="bg-[#111113] rounded-lg border border-zinc-800/60 p-4">
          <p className="text-xs text-zinc-600">No topics in this list yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
          {items.map((topic, index) => (
            <SparkCard key={`${label}-${topic.key}-${index}`} topic={topic} color={color} />
          ))}
        </div>
      )}
    </div>
  );
}

function CategorySection({
  heading,
  newToday,
  trendingOverall,
  color,
}: {
  heading: string;
  newToday: TrendTopic[];
  trendingOverall: TrendTopic[];
  color: string;
}) {
  if (newToday.length === 0 && trendingOverall.length === 0) return null;

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">{heading}</p>
      <TopicRow label="Top 5 New Today" items={newToday} color={color} />
      <TopicRow label="Top 5 Trending Overall" items={trendingOverall} color={color} />
    </div>
  );
}

export function KeywordTrendGrid({ topics, todayDate }: Props) {
  const ecosystemAll = buildTrendTopics(topics, 'ecosystem', todayDate);
  const enterpriseAll = buildTrendTopics(topics, 'enterprise', todayDate);

  const ecosystemNew = getNewTodayTop(ecosystemAll, TOP_N);
  const enterpriseNew = getNewTodayTop(enterpriseAll, TOP_N);
  const ecosystemTrending = getTrendingOverallTop(ecosystemAll, TOP_N);
  const enterpriseTrending = getTrendingOverallTop(enterpriseAll, TOP_N);

  if (
    ecosystemNew.length === 0 &&
    enterpriseNew.length === 0 &&
    ecosystemTrending.length === 0 &&
    enterpriseTrending.length === 0
  ) {
    return (
      <div>
        <p className="text-xs text-zinc-500 uppercase tracking-widest mb-4">Topic Trends - New Today vs Trending Overall - 14 days</p>
        <div className="bg-[#111113] rounded-lg border border-zinc-800/60 p-6 text-center">
          <p className="text-sm text-zinc-600">No topics yet - run the collector to populate.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs text-zinc-500 uppercase tracking-widest mb-4">Topic Trends - New Today vs Trending Overall - 14 days</p>
      <div className="space-y-5">
        <CategorySection heading="Ecosystem" newToday={ecosystemNew} trendingOverall={ecosystemTrending} color="#08CAA6" />
        <CategorySection heading="Enterprise AI" newToday={enterpriseNew} trendingOverall={enterpriseTrending} color="#93D1BD" />
      </div>
    </div>
  );
}
