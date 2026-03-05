'use client';

import { useState, useEffect } from 'react';
import type { ComposerPost } from '@/lib/api';
import { ACCOUNTS, ACCOUNT_MAP } from '../types';

import { getApiUrl } from '@/lib/apiUrl';

const API_URL = getApiUrl();

interface Props {
  posts: ComposerPost[];
}

function formatAEST(isoString: string | null): string {
  if (!isoString) return '—';
  try {
    return new Date(isoString).toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }) + ' AEST';
  } catch {
    return isoString;
  }
}

function getTodayAEST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
}

function isToday(isoString: string | null): boolean {
  if (!isoString) return false;
  const postDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date(isoString));
  return postDate === getTodayAEST();
}

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  published: { label: 'Published', className: 'bg-emerald-900/20 text-emerald-400' },
  failed:    { label: 'Failed',    className: 'bg-red-900/20 text-red-400' },
  rejected:  { label: 'Rejected',  className: 'bg-zinc-800 text-zinc-500' },
};

export function PostHistory({ posts }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [accountFilter, setAccountFilter] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<'today' | 'all'>('today');
  const [allTimePosts, setAllTimePosts] = useState<ComposerPost[] | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);

  useEffect(() => {
    if (timeRange === 'all' && allTimePosts === null && !loadingAll) {
      setLoadingAll(true);
      fetch(`${API_URL}/api/composer/history?limit=200`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((data) => setAllTimePosts(data as ComposerPost[]))
        .catch(() => setAllTimePosts([]))
        .finally(() => setLoadingAll(false));
    }
  }, [timeRange, allTimePosts, loadingAll]);

  const basePosts = timeRange === 'today'
    ? posts.filter((p) => isToday(p.published_at || p.updated_at))
    : (allTimePosts ?? posts);

  if (posts.length === 0 && timeRange === 'today') return null;

  const filtered = accountFilter
    ? basePosts.filter((p) => p.account === accountFilter)
    : basePosts;

  const published = filtered.filter((p) => p.status === 'published').length;
  const failed = filtered.filter((p) => p.status === 'failed').length;
  const rejected = filtered.filter((p) => p.status === 'rejected').length;

  const summary = [
    published > 0 && `${published} published`,
    failed > 0 && `${failed} failed`,
    rejected > 0 && `${rejected} rejected`,
  ].filter(Boolean).join(', ');

  return (
    <section>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-zinc-500 hover:text-zinc-300 transition-colors mb-3"
      >
        <svg
          className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        {timeRange === 'today' ? 'Today\u2019s activity' : 'All activity'} ({summary})
      </button>

      {isOpen && (
        <div className="flex flex-col gap-2">
          {/* Time range + Account filter */}
          <div className="mb-2 flex items-center gap-2">
            <button
              onClick={() => setTimeRange('today')}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                timeRange === 'today'
                  ? 'bg-aqua/15 text-aqua'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Today
            </button>
            <button
              onClick={() => setTimeRange('all')}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                timeRange === 'all'
                  ? 'bg-aqua/15 text-aqua'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              All Time
            </button>

            <span className="mx-1 h-4 w-px bg-zinc-800" />

            <button
              onClick={() => setAccountFilter(null)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                accountFilter === null
                  ? 'bg-aqua/15 text-aqua'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              All
            </button>
            {ACCOUNTS.map((acc) => (
              <button
                key={acc.slug}
                onClick={() => setAccountFilter(acc.slug)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  accountFilter === acc.slug
                    ? ''
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
                style={
                  accountFilter === acc.slug
                    ? { backgroundColor: `${acc.badgeColor}30`, color: acc.badgeColor }
                    : undefined
                }
              >
                {acc.label}
              </button>
            ))}
          </div>

          {loadingAll && (
            <p className="text-sm text-zinc-500 py-2">Loading history...</p>
          )}

          {!loadingAll && filtered.length === 0 && (
            <p className="text-sm text-zinc-500 py-2">No activity{accountFilter ? ' for this account' : ''}.</p>
          )}

          {filtered.map((post) => {
            const style = STATUS_STYLES[post.status] || STATUS_STYLES.rejected;

            return (
              <div
                key={post.id}
                className="rounded-lg border border-zinc-800/40 bg-[#111113] p-4 opacity-80"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {(() => {
                      const postAcc = ACCOUNT_MAP[post.account];
                      return (
                        <span
                          className="rounded px-2 py-0.5 text-xs font-medium"
                          style={{
                            backgroundColor: `${postAcc?.badgeColor || '#27272a'}20`,
                            color: postAcc?.badgeColor || '#a1a1aa',
                          }}
                        >
                          {postAcc?.label || (post.platform === 'twitter' ? 'X' : 'LinkedIn')}
                        </span>
                      );
                    })()}
                    <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${style.className}`}>
                      {style.label}
                    </span>
                    {post.source_topic && (
                      <span className="text-xs text-zinc-600 truncate max-w-[250px]">
                        {post.source_topic}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-zinc-600">
                    {formatAEST(post.published_at || post.updated_at)}
                  </span>
                </div>
                <p className="text-sm text-zinc-500 leading-relaxed line-clamp-2">
                  {post.content}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
