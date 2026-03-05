'use client';

import { useState, useEffect, useRef } from 'react';
import type { ComposerPost, DuplicateCheckResponse } from '@/lib/api';
import { api } from '@/lib/api';
import { toSydneyDateTimeLocalValue, trySydneyLocalDateTimeToUtcIso } from '@/lib/sydneyDate';
import { ACCOUNT_MAP } from '../types';

interface Props {
  post: ComposerPost;
  editingPostId: number | null;
  rejectingPostId: number | null;
  isLoading: boolean;
  onSubmit: (id: number) => void;
  onApprove: (id: number) => void;
  onReject: (id: number) => void;
  onRevise: (id: number, feedback: string) => void;
  onPublishNow: (id: number) => void;
  onDelete: (id: number) => void;
  onEdit: (id: number, content: string) => void;
  onEditSchedule: (id: number, scheduledAt: string) => void;
  onStartEdit: (id: number) => void;
  onCancelEdit: () => void;
  onStartReject: (id: number) => void;
  onCancelReject: () => void;
}

function formatAESTTime(isoString: string | null): string {
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

function formatAESTFull(isoString: string | null): string {
  if (!isoString) return '—';
  try {
    return new Date(isoString).toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }) + ' AEST';
  } catch {
    return isoString;
  }
}

export function PostCard({
  post,
  editingPostId,
  rejectingPostId,
  isLoading,
  onSubmit,
  onApprove,
  onReject,
  onRevise,
  onPublishNow,
  onDelete,
  onEdit,
  onEditSchedule,
  onStartEdit,
  onCancelEdit,
  onStartReject,
  onCancelReject,
}: Props) {
  const [editContent, setEditContent] = useState(post.content);
  const [feedback, setFeedback] = useState('');
  const [scheduleInput, setScheduleInput] = useState(toSydneyDateTimeLocalValue(post.scheduled_at));
  const [dupCheck, setDupCheck] = useState<DuplicateCheckResponse | null>(null);
  const dupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isEditing = editingPostId === post.id;
  const isRejecting = rejectingPostId === post.id;
  const charCount = isEditing ? editContent.length : post.content.length;
  const acc = ACCOUNT_MAP[post.account];
  const charMax = acc?.charMax ?? (post.platform === 'twitter' ? 280 : Infinity);
  const isOverLimit = charCount > charMax;

  // Debounced duplicate check while editing (1500ms, min 100 chars)
  useEffect(() => {
    if (!isEditing) { setDupCheck(null); return; }
    if (editContent.trim().length < 100) { setDupCheck(null); return; }

    if (dupTimerRef.current) clearTimeout(dupTimerRef.current);
    dupTimerRef.current = setTimeout(() => {
      api.composer.checkDuplicate({
        content: editContent,
        account: post.account,
        excludePostId: String(post.id),
      })
        .then(setDupCheck)
        .catch(() => setDupCheck(null));
    }, 1500);

    return () => { if (dupTimerRef.current) clearTimeout(dupTimerRef.current); };
  }, [editContent, isEditing, post.account, post.id]);

  useEffect(() => {
    setScheduleInput(toSydneyDateTimeLocalValue(post.scheduled_at));
  }, [post.scheduled_at]);

  return (
    <div className="rounded-lg border border-zinc-800/60 bg-[#111113] p-5">
      {/* Top row: platform + topic + time */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Account badge */}
          <span
            className="rounded px-2 py-0.5 text-xs font-medium"
            style={{
              backgroundColor: `${acc?.badgeColor || '#27272a'}20`,
              color: acc?.badgeColor || '#a1a1aa',
            }}
          >
            {acc?.label || (post.platform === 'twitter' ? 'X' : 'LinkedIn')}
          </span>
          {/* Status badge */}
          {post.status === 'draft' && (
            <span className="rounded px-2 py-0.5 text-[10px] font-medium bg-amber-900/20 text-amber-400">
              Draft
            </span>
          )}
          {post.status === 'pending_approval' && (
            <span className="rounded px-2 py-0.5 text-[10px] font-medium bg-blue-900/20 text-blue-400">
              Pending approval
            </span>
          )}
          {post.status === 'approved' && (
            <span className="rounded px-2 py-0.5 text-[10px] font-medium bg-aqua/10 text-aqua">
              Approved
            </span>
          )}
          {/* Source topic */}
          {post.source_topic && (
            <span className="text-xs text-zinc-500 truncate max-w-[300px]">
              {post.source_topic}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Char count */}
          <span className={`text-xs tabular-nums ${isOverLimit ? 'text-red-400' : 'text-zinc-600'}`}>
            {charCount}
            {charMax < Infinity && ` / ${charMax}`}
          </span>
          {/* Scheduled time */}
          {post.scheduled_at && (
            <span className="text-xs text-zinc-500">
              {formatAESTTime(post.scheduled_at)}
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      {isEditing ? (
        <>
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="mb-3 w-full resize-none rounded-md border border-zinc-700 bg-[#0A0A0B] px-3 py-2 text-sm text-zinc-200 focus:border-aqua focus:outline-none"
            rows={4}
          />
          {dupCheck?.hasDuplicate && dupCheck.matches[0] && (
            <div className="mb-3 rounded-md border border-amber-900/40 bg-amber-900/10 px-4 py-2 text-xs text-amber-400">
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
            <div className="mb-3 rounded-md border border-zinc-800/60 bg-zinc-800/20 px-4 py-2 text-xs text-zinc-400">
              ℹ️ Similar post found from{' '}
              {new Date(dupCheck.matches[0].published_at).toLocaleDateString('en-AU', {
                day: 'numeric', month: 'short', year: 'numeric',
                timeZone: 'Australia/Sydney',
              })}. Review before posting.
            </div>
          )}
        </>
      ) : (
        <p className="mb-4 text-sm leading-relaxed text-zinc-300 whitespace-pre-wrap">
          {post.content}
        </p>
      )}

      {/* Feedback panel — shown when "Reject" is clicked */}
      {isRejecting && (
        <div className="mb-4 rounded-md border border-zinc-700 bg-[#0A0A0B] p-4">
          <p className="mb-2 text-xs font-medium text-zinc-400">
            What should change?
          </p>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="e.g. 'More specific about compliance risk' or 'Add our angle on agent governance'"
            className="mb-3 w-full resize-none rounded-md border border-zinc-700 bg-[#111113] px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-aqua focus:outline-none"
            rows={3}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => onRevise(post.id, feedback)}
              disabled={isLoading || feedback.trim().length === 0}
              className="rounded-md bg-aqua px-3 py-1.5 text-xs font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {isLoading ? 'Revising...' : 'Revise'}
            </button>
            <button
              onClick={() => onReject(post.id)}
              disabled={isLoading}
              className="rounded-md border border-red-900/40 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-900/20 disabled:opacity-40"
            >
              Replace topic
            </button>
            <button
              onClick={() => {
                setFeedback('');
                onCancelReject();
              }}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Actions */}
      {post.status === 'draft' && !isRejecting && (
        <div className="flex items-center gap-2">
          {isEditing ? (
            <>
              <button
                onClick={() => onEdit(post.id, editContent)}
                disabled={isLoading || editContent.trim().length === 0}
                className="rounded-md bg-aqua px-3 py-1.5 text-xs font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setEditContent(post.content);
                  onCancelEdit();
                }}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => onSubmit(post.id)}
                disabled={isLoading}
                className="rounded-md bg-aqua px-3 py-1.5 text-xs font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                Submit
              </button>
              <button
                onClick={() => {
                  setEditContent(post.content);
                  onStartEdit(post.id);
                }}
                disabled={isLoading}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-40"
              >
                Edit
              </button>
              <button
                onClick={() => onStartReject(post.id)}
                disabled={isLoading}
                className="rounded-md border border-red-900/40 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-900/20 disabled:opacity-40"
              >
                Reject
              </button>
              <button
                onClick={() => onDelete(post.id)}
                disabled={isLoading}
                className="ml-auto rounded-md px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:text-red-400 disabled:opacity-40"
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}

      {post.status === 'pending_approval' && !isRejecting && (
        <div className="flex items-center gap-2">
          {isEditing ? (
            <>
              <button
                onClick={() => onEdit(post.id, editContent)}
                disabled={isLoading || editContent.trim().length === 0}
                className="rounded-md bg-aqua px-3 py-1.5 text-xs font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setEditContent(post.content);
                  onCancelEdit();
                }}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => onApprove(post.id)}
                disabled={isLoading}
                className="rounded-md bg-aqua px-3 py-1.5 text-xs font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                Approve
              </button>
              <button
                onClick={() => onStartReject(post.id)}
                disabled={isLoading}
                className="rounded-md border border-red-900/40 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-900/20 disabled:opacity-40"
              >
                Reject
              </button>
              <button
                onClick={() => {
                  setEditContent(post.content);
                  onStartEdit(post.id);
                }}
                disabled={isLoading}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-40"
              >
                Edit
              </button>
              <button
                onClick={() => onDelete(post.id)}
                disabled={isLoading}
                className="ml-auto rounded-md px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:text-red-400 disabled:opacity-40"
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}

      {post.status === 'approved' && (
        <div className="flex items-center gap-3 flex-wrap">
          {post.scheduled_at ? (
            <span className="text-xs text-aqua">
              Approved for {formatAESTFull(post.scheduled_at)}
            </span>
          ) : (
            <span className="text-xs text-aqua">
              Approved — ready to publish
            </span>
          )}
          <input
            type="datetime-local"
            value={scheduleInput}
            onChange={(e) => setScheduleInput(e.target.value)}
            className="rounded-md border border-zinc-700 bg-[#0A0A0B] px-2 py-1 text-xs text-zinc-200 focus:border-aqua focus:outline-none"
          />
          <button
            onClick={() => {
              if (!scheduleInput) return;
              const nextIso = trySydneyLocalDateTimeToUtcIso(scheduleInput);
              if (!nextIso) return;
              onEditSchedule(post.id, nextIso);
            }}
            disabled={isLoading || !scheduleInput}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:text-zinc-100 disabled:opacity-40"
          >
            Update time
          </button>
          <button
            onClick={() => onPublishNow(post.id)}
            disabled={isLoading}
            className="rounded-md bg-aqua px-3 py-1.5 text-xs font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {isLoading ? 'Publishing...' : 'Publish Now'}
          </button>
          <button
            onClick={() => onDelete(post.id)}
            disabled={isLoading}
            className="ml-auto rounded-md px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:text-red-400 disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
