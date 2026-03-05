import { getApiUrl } from './apiUrl';

const API_URL = getApiUrl();

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body || res.statusText);
  }

  return res.json() as Promise<T>;
}

// --- Types matching the backend DB schema ---

export interface DailyReport {
  id: number;
  date: string;
  ecosystem_synthesis: string | null;
  enterprise_synthesis: string | null;
  sentiment_score: number | null;
  sentiment_direction: string | null;
  sentiment_label: string | null;
  slack_post_text: string | null;
  posted_at: string | null;
  created_at: string;
}

export interface KeywordSignal {
  id: number;
  date: string;
  platform: string;
  keyword: string;
  post_count: number;
  sentiment: string;
  momentum: string;
  category: string;
  created_at: string;
}

export interface EmergingTopic {
  id: number;
  date: string;
  platform: string;
  keyword: string;
  topic_key?: string | null;
  topic_title: string;
  summary: string;
  post_count: number;
  sample_urls: string[] | null;
  category: string;
  created_at: string;
}

export interface RunLogEntry {
  id: number;
  date: string;
  function_name: string;
  status: string;
  duration_ms: number | null;
  posts_fetched: number | null;
  llm_tokens: number | null;
  error_msg: string | null;
  created_at: string;
}

export interface ComposerPost {
  id: number;
  account: string;
  platform: string;
  content: string;
  status: string;
  category: string | null;
  is_reshare: boolean;
  is_podcast: boolean;
  guest_name: string | null;
  episode_number: number | null;
  scheduled_at: string | null;
  published_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  slack_message_ts: string | null;
  platform_post_id: string | null;
  source_topic: string | null;
  source_keyword: string | null;
  created_at: string;
  updated_at: string;
}

export interface ComposerStats {
  date: string;
  twitter: { count: number; limit: number };
  linkedin: { count: number; limit: number };
}

// --- Media Library types ---

export interface Episode {
  id: string;
  title: string;
  guest_name: string | null;
  episode_number: number | null;
  publish_date: string | null;
  status: 'upcoming' | 'published';
  created_at: string;
  updated_at: string;
}

export interface EpisodeWithAssets extends Episode {
  assets: MediaAsset[];
}

export type AssetType = 'clip' | 'graphic' | 'headshot' | 'show_notes' | 'questions';

export interface MediaAsset {
  id: string;
  episode_id: string;
  asset_type: AssetType;
  title: string | null;
  storage_url: string | null;
  external_url: string | null;
  file_name: string | null;
  mime_type: string | null;
  created_at: string;
}

export interface MixResponse {
  account: string;
  week: string;
  mix: Record<string, number>;
  threshold: number;
}

export interface DuplicateMatch {
  id: string;
  content: string;
  published_at: string;
  similarity: number;
}

export interface DuplicateCheckResponse {
  hasDuplicate: boolean;
  matches: DuplicateMatch[];
}

// --- Analytics types ---

export interface AnalyticsPost extends ComposerPost {
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  engagement_fetched_at: string | null;
}

export interface CategoryStats {
  account: string;
  category: string;
  post_count: number;
  avg_impressions: number | null;
  avg_likes: number | null;
  avg_comments: number | null;
  avg_shares: number | null;
  avg_engagement_rate: number | null;
}

export interface TimeslotStats {
  account: string;
  hour: number;
  post_count: number;
  avg_impressions: number | null;
}

export interface AccountSummary {
  account: string;
  total_posts: number;
  total_impressions: number;
  avg_engagement_rate: number | null;
  best_category: string | null;
  best_hour: number | null;
}

export interface RejectResult {
  rejected: { id: number; source_topic: string | null };
  replacement: ComposerPost | null;
}

export interface ReviseResult {
  rejected: { id: number; source_topic: string | null };
  revision: ComposerPost;
}

// --- API methods ---

export const api = {
  health: () => request<{ status: string; db: string }>("/api/health"),

  intelligence: {
    today: () =>
      request<DailyReport | { date: string; status: string }>(
        "/api/intelligence/today",
      ),
    keywords: (days = 14) =>
      request<KeywordSignal[]>(`/api/intelligence/keywords?days=${days}`),
    topics: (days = 7) =>
      request<EmergingTopic[]>(`/api/intelligence/topics?days=${days}`),
    runLog: () => request<RunLogEntry[]>("/api/intelligence/run-log"),
    triggerRun: (platform?: string) =>
      request<{ status: string; platform: string }>(
        "/api/intelligence/trigger-run",
        {
          method: "POST",
          body: JSON.stringify({ platform }),
        },
      ),
  },

  composer: {
    queue: () => request<ComposerPost[]>("/api/composer/queue"),
    stats: () => request<ComposerStats>("/api/composer/stats"),
    approve: (id: number) =>
      request<ComposerPost>(`/api/composer/${id}/approve`, { method: "PATCH" }),
    reject: (id: number) =>
      request<RejectResult>(`/api/composer/${id}/reject`, { method: "PATCH" }),
    revise: (id: number, feedback: string) =>
      request<ReviseResult>(`/api/composer/${id}/revise`, {
        method: "PATCH",
        body: JSON.stringify({ feedback }),
      }),
    edit: (id: number, content: string) =>
      request<ComposerPost>(`/api/composer/${id}/edit`, {
        method: "PATCH",
        body: JSON.stringify({ content }),
      }),
    draft: (body: {
      topicTitle: string;
      topicSummary: string;
      keywords: string[];
      sourceLinks?: string[];
      account: string;
      category?: string;
      scheduled_at?: string;
      is_podcast?: boolean;
      is_reshare?: boolean;
      guest_name?: string;
      episode_number?: number;
    }) =>
      request<ComposerPost>("/api/composer/draft", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    mix: (account: string, week?: string) =>
      request<MixResponse>(
        `/api/composer/mix?account=${account}${week ? `&week=${week}` : ""}`,
      ),
    checkDuplicate: (body: {
      content: string;
      account: string;
      excludePostId?: string;
    }) =>
      request<DuplicateCheckResponse>("/api/composer/check-duplicate", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },

  analytics: {
    posts: (account?: string) =>
      request<AnalyticsPost[]>(
        `/api/analytics/posts${account ? `?account=${account}` : ""}`,
      ),
    byCategory: () => request<CategoryStats[]>("/api/analytics/by-category"),
    byTimeslot: () => request<TimeslotStats[]>("/api/analytics/by-timeslot"),
    summary: () => request<AccountSummary[]>("/api/analytics/summary"),
  },

  media: {
    episodes: () => request<Episode[]>("/api/media/episodes"),
    latest: () => request<EpisodeWithAssets>("/api/media/episodes/latest"),
    createEpisode: (body: {
      title: string;
      guest_name?: string;
      episode_number?: number;
      publish_date?: string;
      status?: string;
    }) =>
      request<Episode>("/api/media/episodes", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    updateEpisode: (id: string, body: Partial<{
      title: string;
      guest_name: string | null;
      episode_number: number | null;
      publish_date: string | null;
      status: string;
    }>) =>
      request<Episode>(`/api/media/episodes/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    deleteEpisode: (id: string) =>
      request<{ deleted: true; id: string }>(`/api/media/episodes/${id}`, {
        method: "DELETE",
      }),
    assets: (episodeId: string) =>
      request<MediaAsset[]>(`/api/media/episodes/${episodeId}/assets`),
    deleteAsset: (id: string) =>
      request<{ deleted: true; id: string }>(`/api/media/assets/${id}`, {
        method: "DELETE",
      }),
  },
};
