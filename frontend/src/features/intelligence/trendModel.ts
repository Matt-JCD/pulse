import type { EmergingTopic } from "@/lib/api";
import { getTopicKey } from "./topicKey";
import { isSimilarTopic, isSimilarTopicText, similarityTokenSet } from "./similarity";
import { deriveStoryKey } from "./storyKey";

export interface TrendTopic {
  key: string;
  title: string;
  keyword: string;
  category: string;
  primaryUrl: string | null;
  todayCount: number;
  yesterdayCount: number;
  twoDaysAgoCount: number;
  todayRank: number | null;
  yesterdayRank: number | null;
  totalCount: number;
  score: number;
  firstSeen: string;
  lastSeen: string;
  ongoingDays: number;
  isNewToday: boolean;
  trendState: "new" | "rising" | "steady" | "fading";
  data: Array<{ date: string; posts: number }>;
  urls: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function getDateOffset(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  date.setDate(date.getDate() + deltaDays);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function daysBetween(start: string, end: string): number {
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return 1;
  return Math.max(1, Math.floor((b - a) / DAY_MS) + 1);
}

function trendState(
  today: number,
  yesterday: number,
  twoDaysAgo: number,
  isNewToday: boolean
): TrendTopic["trendState"] {
  if (isNewToday) return "new";
  if (today > yesterday) return "rising";
  if (today < yesterday && yesterday > 0) return "fading";
  if (today === yesterday && (today > 0 || twoDaysAgo > 0)) return "steady";
  return "steady";
}

function buildDocFreqForTrend(topics: TrendTopic[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const topic of topics) {
    const tokens = similarityTokenSet(topic.title);
    for (const token of tokens) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  return df;
}

function signatureFromTokens(tokens: Set<string>, docFreq: Map<string, number>): Set<string> {
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

function recomputeDerivedFields(topic: TrendTopic, todayDate: string): TrendTopic {
  const yesterday = getDateOffset(todayDate, -1);
  const twoDaysAgo = getDateOffset(todayDate, -2);

  const activeDates = topic.data
    .filter((item) => item.posts > 0)
    .map((item) => item.date);

  const firstSeen = activeDates[0] ?? todayDate;
  const lastSeen = activeDates[activeDates.length - 1] ?? todayDate;
  const todayCount = topic.data.find((item) => item.date === todayDate)?.posts ?? 0;
  const yesterdayCount = topic.data.find((item) => item.date === yesterday)?.posts ?? 0;
  const twoDaysAgoCount = topic.data.find((item) => item.date === twoDaysAgo)?.posts ?? 0;
  const totalCount = topic.data.reduce((sum, item) => sum + item.posts, 0);
  const score = todayCount + 0.5 * yesterdayCount - 0.5 * twoDaysAgoCount;
  const isNewToday = firstSeen === todayDate;

  return {
    ...topic,
    firstSeen,
    lastSeen,
    todayCount,
    yesterdayCount,
    twoDaysAgoCount,
    totalCount,
    score,
    isNewToday,
    ongoingDays: daysBetween(firstSeen, todayDate),
    trendState: trendState(todayCount, yesterdayCount, twoDaysAgoCount, isNewToday),
  };
}

function mergeNearDuplicateTrendTopics(topics: TrendTopic[], todayDate: string): TrendTopic[] {
  const docFreq = buildDocFreqForTrend(topics);
  const clusters: Array<{
    tokenSet: Set<string>;
    signature: Set<string>;
    matchText: string;
    storyKeys: Set<string>;
    topic: TrendTopic;
  }> = [];

  for (const candidate of topics) {
    const matchText = candidate.title;
    const tokens = similarityTokenSet(matchText);
    const signature = signatureFromTokens(tokens, docFreq);
    const candidateStoryKey = deriveStoryKey(candidate.title, "", candidate.keyword);
    const existing = clusters.find(
      (cluster) =>
        (candidateStoryKey ? cluster.storyKeys.has(candidateStoryKey) : false) ||
        signatureOverlap(cluster.signature, signature) >= 3 ||
        (signatureOverlap(cluster.signature, signature) >= 2 &&
          isSimilarTopic(cluster.tokenSet, tokens)) ||
        isSimilarTopic(cluster.tokenSet, tokens) ||
        isSimilarTopicText(cluster.matchText, matchText)
    );

    if (!existing) {
      clusters.push({
        tokenSet: new Set(tokens),
        signature: new Set(signature),
        matchText,
        storyKeys: new Set(candidateStoryKey ? [candidateStoryKey] : []),
        topic: candidate,
      });
      continue;
    }

    const mergedByDate = new Map<string, number>();
    for (const item of existing.topic.data) {
      mergedByDate.set(item.date, (mergedByDate.get(item.date) ?? 0) + item.posts);
    }
    for (const item of candidate.data) {
      mergedByDate.set(item.date, (mergedByDate.get(item.date) ?? 0) + item.posts);
    }

    const keepCandidateTitle = candidate.todayCount > existing.topic.todayCount;
    const mergedTitle = keepCandidateTitle ? candidate.title : existing.topic.title;
    const mergedPrimaryUrl =
      existing.topic.primaryUrl ||
      candidate.primaryUrl ||
      existing.topic.urls[0] ||
      candidate.urls[0] ||
      null;
    const mergedUrls = Array.from(new Set([...existing.topic.urls, ...candidate.urls]));

    existing.topic = recomputeDerivedFields(
      {
        ...existing.topic,
        key: keepCandidateTitle ? candidate.key : existing.topic.key,
        title: mergedTitle,
        primaryUrl: mergedPrimaryUrl,
        data: [...mergedByDate.entries()]
          .map(([date, posts]) => ({ date, posts }))
          .sort((a, b) => a.date.localeCompare(b.date)),
        urls: mergedUrls,
      },
      todayDate
    );

    for (const token of tokens) existing.tokenSet.add(token);
    for (const token of signature) existing.signature.add(token);
    if (candidateStoryKey) existing.storyKeys.add(candidateStoryKey);
    existing.matchText = `${existing.matchText} ${matchText}`.slice(0, 800);
  }

  return clusters.map((cluster) => cluster.topic);
}

export function buildTrendTopics(
  topics: EmergingTopic[],
  category: string,
  todayDate: string
): TrendTopic[] {
  const yesterday = getDateOffset(todayDate, -1);
  const twoDaysAgo = getDateOffset(todayDate, -2);
  const allDates = Array.from(new Set(topics.map((t) => t.date))).sort();

  const byKey = new Map<
    string,
    {
      title: string;
      keyword: string;
      dayMap: Map<string, number>;
      urlByDate: Map<string, string[]>;
      urls: Set<string>;
    }
  >();

  for (const topic of topics) {
    if (topic.category !== category) continue;
    const key = getTopicKey(topic);
    const entry = byKey.get(key) ?? {
      title: topic.topic_title,
      keyword: topic.keyword,
      dayMap: new Map<string, number>(),
      urlByDate: new Map<string, string[]>(),
      urls: new Set<string>(),
    };

    if (topic.date >= todayDate) {
      entry.title = topic.topic_title;
      entry.keyword = topic.keyword;
    }

    entry.dayMap.set(
      topic.date,
      (entry.dayMap.get(topic.date) ?? 0) + topic.post_count
    );

    const urlsForDate = topic.sample_urls ?? [];
    if (urlsForDate.length > 0) {
      const existing = entry.urlByDate.get(topic.date) ?? [];
      entry.urlByDate.set(topic.date, [...existing, ...urlsForDate]);
    }

    for (const url of urlsForDate) {
      entry.urls.add(url);
    }

    byKey.set(key, entry);
  }

  const result: TrendTopic[] = [];
  for (const [key, entry] of byKey) {
    const activeDates = allDates.filter((date) => (entry.dayMap.get(date) ?? 0) > 0);
    const firstSeen = activeDates[0] ?? todayDate;
    const lastSeen = activeDates[activeDates.length - 1] ?? todayDate;
    const todayCount = entry.dayMap.get(todayDate) ?? 0;
    const yesterdayCount = entry.dayMap.get(yesterday) ?? 0;
    const twoDaysAgoCount = entry.dayMap.get(twoDaysAgo) ?? 0;
    const totalCount = Array.from(entry.dayMap.values()).reduce((sum, n) => sum + n, 0);
    const score = todayCount + 0.5 * yesterdayCount - 0.5 * twoDaysAgoCount;
    const isNewToday = firstSeen === todayDate;
    const dateWithPrimaryUrl =
      [todayDate, yesterday, ...activeDates.slice().reverse()].find(
        (date) => (entry.urlByDate.get(date) ?? []).length > 0
      ) ?? null;
    const primaryUrl = dateWithPrimaryUrl
      ? (entry.urlByDate.get(dateWithPrimaryUrl) ?? [])[0] ?? null
      : null;

    result.push({
      key,
      title: entry.title,
      keyword: entry.keyword,
      category,
      primaryUrl,
      todayCount,
      yesterdayCount,
      twoDaysAgoCount,
      todayRank: null,
      yesterdayRank: null,
      totalCount,
      score,
      firstSeen,
      lastSeen,
      ongoingDays: daysBetween(firstSeen, todayDate),
      isNewToday,
      trendState: trendState(todayCount, yesterdayCount, twoDaysAgoCount, isNewToday),
      data: allDates.map((date) => ({
        date,
        posts: entry.dayMap.get(date) ?? 0,
      })),
      urls: Array.from(entry.urls),
    });
  }

  const deduped = mergeNearDuplicateTrendTopics(result, todayDate);

  const todayRanked = deduped
    .filter((topic) => topic.todayCount > 0)
    .sort((a, b) => b.todayCount - a.todayCount || b.score - a.score);
  for (const [index, topic] of todayRanked.entries()) {
    topic.todayRank = index + 1;
  }

  const yesterdayRanked = deduped
    .filter((topic) => topic.yesterdayCount > 0)
    .sort((a, b) => b.yesterdayCount - a.yesterdayCount || b.totalCount - a.totalCount);
  for (const [index, topic] of yesterdayRanked.entries()) {
    topic.yesterdayRank = index + 1;
  }

  return deduped;
}

export function getNewTodayTop(topics: TrendTopic[], topN: number): TrendTopic[] {
  return topics
    .filter((topic) => topic.isNewToday && topic.todayCount > 0)
    .sort((a, b) => b.todayCount - a.todayCount || b.score - a.score)
    .slice(0, topN);
}

export function getTrendingOverallTop(topics: TrendTopic[], topN: number): TrendTopic[] {
  return topics
    .filter((topic) => topic.totalCount > 0)
    .sort((a, b) => b.score - a.score || b.totalCount - a.totalCount)
    .slice(0, topN);
}
