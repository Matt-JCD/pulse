import { getApiUrl } from '@/lib/apiUrl';

const API_URL = getApiUrl();

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || res.statusText);
  }
  return res.json() as Promise<T>;
}

// --- Types ---

export interface Keyword {
  id: number;
  keyword: string;
  active: boolean;
  category: 'ecosystem' | 'enterprise';
  platforms: string[];
  created_at: string;
}

export interface ApiConnection {
  id: number;
  provider: string;
  status: 'connected' | 'error' | 'unknown';
  last_checked_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectionTestResult {
  provider: string;
  connected: boolean;
  error?: string;
}

export interface PipelineRun {
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

export interface AppConfig {
  id: number;
  llm_model: string | null;
  daily_run_time_utc: string | null;
  linkedin_frequency: number | null;
  posts_per_keyword: number | null;
  report_email: string | null;
  email_report_enabled: boolean | null;
  alert_on_failure: boolean;
  alert_on_no_posts: boolean;
  daily_summary_enabled: boolean;
  notification_email: string | null;
  updated_at: string;
}

// --- API methods ---

export const settingsApi = {
  // Keywords
  fetchKeywords: () => request<Keyword[]>('/api/admin/keywords'),
  addKeyword: (keyword: string, category: string, platforms: string[]) =>
    request<Keyword>('/api/admin/keywords', {
      method: 'POST',
      body: JSON.stringify({ keyword, category, platforms }),
    }),
  updateKeyword: (id: number, updates: Partial<Pick<Keyword, 'keyword' | 'active' | 'category' | 'platforms'>>) =>
    request<Keyword>(`/api/admin/keywords/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),
  deleteKeyword: (id: number) =>
    request<Keyword>(`/api/admin/keywords/${id}`, { method: 'DELETE' }),

  // Connections
  fetchConnections: () => request<ApiConnection[]>('/api/admin/connections'),
  testConnections: () => request<ConnectionTestResult[]>('/api/admin/connections/test', { method: 'POST' }),

  // Pipeline
  fetchPipelineStatus: () => request<PipelineRun[]>('/api/admin/pipeline/status'),
  triggerPipeline: (fn: string) =>
    request<{ ok: boolean; message: string }>(`/api/admin/pipeline/trigger/${fn}`, { method: 'POST' }),

  // Config
  fetchConfig: () => request<AppConfig>('/api/admin/config'),
  updateConfig: (updates: Partial<AppConfig>) =>
    request<AppConfig>('/api/admin/config', {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),
};
