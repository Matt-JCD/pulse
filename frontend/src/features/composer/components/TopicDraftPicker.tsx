'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { EmergingTopic, MixResponse, DuplicateCheckResponse } from '@/lib/api';
import { api } from '@/lib/api';
import { ACCOUNTS, ACCOUNT_MAP, CATEGORY_MAP, mapTopicToPostCategory } from '../types';

import { getApiUrl } from '@/lib/apiUrl';

const API_URL = getApiUrl();

interface Props {
  topics: EmergingTopic[];
}

/** Category options for the filter dropdown. 'All' shows every topic. */
const FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'ecosystem', label: 'Ecosystem' },
  { value: 'governance', label: 'Governance' },
  { value: 'security', label: 'Security' },
  { value: 'enterprise_ai', label: 'Enterprise AI' },
  { value: 'podcast_events', label: 'Podcast & Events' },
  { value: 'founder', label: 'Founder' },
  { value: 'direct_value', label: 'Direct Value' },
  { value: 'product', label: 'Product' },
];

export function TopicDraftPicker({ topics }: Props) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isDrafting, setIsDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedAccount, setSelectedAccount] = useState('prefactor_x');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [selectedTopicId, setSelectedTopicId] = useState<number | null>(null);
  const [postedTopics, setPostedTopics] = useState<Set<string>>(new Set());
  const [mixData, setMixData] = useState<MixResponse | null>(null);
  const [dupCheck, setDupCheck] = useState<DuplicateCheckResponse | null>(null);
  const controlsRef = useRef<HTMLDivElement>(null);

  // Fetch category mix for selected account (re-fetches on account change)
  useEffect(() => {
    if (!selectedAccount) return;
    let cancelled = false;
    api.composer.mix(selectedAccount)
      .then((r) => { if (!cancelled) setMixData(r); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedAccount]);

  // Fetch today's posts to mark topics that already have a draft/post
  useEffect(() => {
    fetch(`${API_URL}/api/composer/queue`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((posts: Array<{ source_topic: string | null }>) => {
        const titles = new Set(
          posts.map((p) => p.source_topic).filter((t): t is string => !!t),
        );
        setPostedTopics(titles);
      })
      .catch(() => {});
  }, []);

  // Map each topic to a post category
  const topicsWithCategory = topics.map((t) => ({
    ...t,
    postCategory: mapTopicToPostCategory(t.keyword, t.category),
  }));

  const filteredTopics = categoryFilter
    ? topicsWithCategory.filter((t) => t.postCategory === categoryFilter)
    : topicsWithCategory;

  const selectedTopic = topicsWithCategory.find((t) => t.id === selectedTopicId) ?? null;
  const isScheduled = scheduledAt.length > 0;
  const canDraft = !!selectedAccount && !!selectedTopic && !isDrafting;

  if (topics.length === 0) return null;

  async function handleDraft() {
    if (!selectedTopic) return;
    setIsDrafting(true);
    setError(null);

    try {
      // 1. Generate AI draft
      const draftRes = await fetch(`${API_URL}/api/composer/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topicId: String(selectedTopic.id),
          topicTitle: selectedTopic.topic_title,
          topicSummary: selectedTopic.summary,
          keywords: [selectedTopic.keyword],
          sourceLinks: selectedTopic.sample_urls || [],
          account: selectedAccount,
          category: selectedTopic.postCategory,
          ...(isScheduled && { scheduled_at: new Date(scheduledAt).toISOString() }),
        }),
      });

      const draftData = await draftRes.json().catch(() => null) as { content?: string; id?: number; error?: string } | null;

      if (!draftRes.ok) {
        throw new Error(draftData?.error || `Draft request failed (${draftRes.status})`);
      }
      if (draftData?.content) {
        api.composer.checkDuplicate({
          content: draftData.content,
          account: selectedAccount,
          excludePostId: draftData.id ? String(draftData.id) : undefined,
        })
          .then(setDupCheck)
          .catch(() => {});
      }

      setSelectedTopicId(null);
      router.refresh();
      // Refresh mix data after creating a post
      api.composer.mix(selectedAccount).then(setMixData).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create draft');
    } finally {
      setIsDrafting(false);
    }
  }

  return (
    <section className="mb-8">
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
        Draft from today&apos;s topics ({topics.length})
        <span className="ml-2 normal-case tracking-normal text-[10px] text-zinc-600 font-normal">
          For topics not covered in the auto-draft
        </span>
      </button>

      {isOpen && (
        <div className="space-y-2">
          {error && (
            <div className="rounded-md border border-red-900/40 bg-red-900/10 px-4 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Controls bar */}
          <div ref={controlsRef} className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800/60 bg-[#111113] p-3">
            <label className="flex items-center gap-1.5 text-[10px] text-zinc-500">
              Account
              <select
                value={selectedAccount}
                onChange={(e) => setSelectedAccount(e.target.value)}
                className="rounded-md border border-zinc-700 bg-[#0A0A0B] px-2 py-1.5 text-xs text-zinc-200 focus:border-aqua focus:outline-none"
              >
                {ACCOUNTS.map((acc) => (
                  <option key={acc.slug} value={acc.slug}>
                    {acc.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-1.5 text-[10px] text-zinc-500">
              Category
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="rounded-md border border-zinc-700 bg-[#0A0A0B] px-2 py-1.5 text-xs text-zinc-200 focus:border-aqua focus:outline-none"
              >
                {FILTER_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-1.5 text-[10px] text-zinc-500">
              Schedule
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="rounded-md border border-zinc-700 bg-[#0A0A0B] px-2 py-1.5 text-xs text-zinc-200 focus:border-aqua focus:outline-none"
              />
            </label>

            <button
              onClick={handleDraft}
              disabled={!canDraft}
              className="rounded-md bg-aqua px-4 py-1.5 text-xs font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {isDrafting
                ? (isScheduled ? 'Scheduling...' : 'Drafting...')
                : (isScheduled ? 'Schedule' : 'Draft')}
            </button>
          </div>

          {/* Category threshold warning */}
          {selectedTopic && mixData && (() => {
            const cat = selectedTopic.postCategory;
            const count = mixData.mix[cat] ?? 0;
            const threshold = mixData.threshold ?? 2;
            if (count < threshold) return null;
            const catLabel = CATEGORY_MAP[cat]?.label || cat;
            const accLabel = ACCOUNT_MAP[selectedAccount]?.label || selectedAccount;
            return (
              <div className="rounded-md border border-amber-900/40 bg-amber-900/10 px-4 py-2 text-xs text-amber-400">
                ⚠️ You already have {count} {catLabel} post{count !== 1 ? 's' : ''} this week for {accLabel}. Consider a different category.
              </div>
            );
          })()}

          {/* Duplicate detection warning (shown after AI draft) */}
          {dupCheck?.hasDuplicate && dupCheck.matches[0] && (
            <div className="rounded-md border border-amber-900/40 bg-amber-900/10 px-4 py-2 text-xs text-amber-400">
              <p className="font-medium mb-1">⚠️ This post is very similar to something you&apos;ve already published.</p>
              <p className="text-amber-400/70">
                &quot;{dupCheck.matches[0].content.slice(0, 120)}…&quot;
                {' · '}
                {new Date(dupCheck.matches[0].published_at).toLocaleDateString('en-AU', {
                  day: 'numeric', month: 'short', year: 'numeric',
                  timeZone: 'Australia/Sydney',
                })}
              </p>
            </div>
          )}
          {dupCheck && !dupCheck.hasDuplicate && dupCheck.matches.length > 0 && (
            <div className="rounded-md border border-zinc-800/60 bg-zinc-800/20 px-4 py-2 text-xs text-zinc-400">
              ℹ️ Similar post found from{' '}
              {new Date(dupCheck.matches[0].published_at).toLocaleDateString('en-AU', {
                day: 'numeric', month: 'short', year: 'numeric',
                timeZone: 'Australia/Sydney',
              })}. Review before posting.
            </div>
          )}

          {filteredTopics.length === 0 && (
            <p className="text-sm text-zinc-500 py-2">No topics for this category.</p>
          )}

          {/* Topic list */}
          {filteredTopics.map((topic) => {
            const catInfo = CATEGORY_MAP[topic.postCategory];
            const isSelected = selectedTopicId === topic.id;
            const alreadyPosted = postedTopics.has(topic.topic_title);

            return (
              <div
                key={topic.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedTopicId(isSelected ? null : topic.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedTopicId(isSelected ? null : topic.id); }}
                className={`w-full text-left rounded-lg border p-4 transition-colors cursor-pointer ${
                  isSelected
                    ? 'border-aqua/60 bg-aqua/5'
                    : 'border-zinc-800/60 bg-[#111113] hover:border-zinc-700'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                      catInfo?.className || 'bg-aqua/10 text-aqua'
                    }`}
                  >
                    {catInfo?.label || topic.postCategory}
                  </span>
                  <span className="text-[10px] text-zinc-600">
                    {topic.post_count} posts
                  </span>
                  {alreadyPosted && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 font-medium">
                      Posted today
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-2">
                    {isSelected && (
                      <span className="text-[10px] text-aqua font-medium">Selected</span>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedTopicId(topic.id);
                        controlsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                      }}
                      className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-300 hover:border-aqua/50 hover:text-aqua transition-colors"
                    >
                      Draft
                    </button>
                  </span>
                </div>
                <p className="text-sm font-semibold text-zinc-100 leading-snug mb-1">
                  {topic.topic_title}
                </p>
                <p className="text-xs text-zinc-500 line-clamp-2">
                  {topic.summary}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
