'use client';

import type { RunLogEntry } from '@/lib/api';
import { useEffect, useState } from 'react';
import { useIntelligence } from '../useIntelligence';
import { getSydneyDate } from '@/lib/sydneyDate';

interface Props {
  runLog: RunLogEntry[];
}

// Blended cost estimate: Claude Sonnet 4.6 ~$3/M input, $15/M output
// Assuming ~80% input / 20% output for synthesis workloads
const COST_PER_TOKEN = (0.8 * 3 + 0.2 * 15) / 1_000_000; // $5.40/M tokens

function formatCost(tokens: number | null): string {
  if (!tokens) return '';
  const cost = tokens * COST_PER_TOKEN;
  if (cost < 0.01) return `< $0.01`;
  return `~$${cost.toFixed(3)}`;
}

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatDate(): string {
  return new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Australia/Sydney',
  }).format(new Date());
}

function ElapsedTimer() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return (
    <span className="tabular-nums">
      {m > 0 ? `${m}m ` : ''}{s}s
    </span>
  );
}

export function DashboardHeader({ runLog }: Props) {
  const { isRunning, runError, pollCount, handleRunNow } = useIntelligence();

  const lastSuccessRun = runLog.find((r) => r.status === 'success');

  // Total tokens from today's successful runs (for cost display)
  const todayStr = getSydneyDate();

  const todayTokens = runLog
    .filter((r) => r.status === 'success' && r.llm_tokens && r.date === todayStr)
    .reduce((sum, r) => sum + (r.llm_tokens ?? 0), 0);

  const costLabel = formatCost(todayTokens);

  return (
    <div className="flex items-start justify-between mb-8 gap-4">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">{formatDate()}</h1>
        <div className="flex items-center gap-3 mt-1">
          <p className="text-sm text-zinc-500">
            {lastSuccessRun
              ? `Last run: ${formatRelativeTime(lastSuccessRun.created_at)} · ${lastSuccessRun.function_name}`
              : 'No runs recorded yet'}
          </p>
          {costLabel && (
            <span className="text-xs text-zinc-600 border border-zinc-800 rounded px-1.5 py-0.5">
              {costLabel} today
            </span>
          )}
        </div>
        {runError && (
          <p className="text-sm text-red-400 mt-1">{runError}</p>
        )}
      </div>

      <div className="flex flex-col items-end gap-2 shrink-0">
        <button
          onClick={handleRunNow}
          disabled={isRunning}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
            bg-[#111113] border border-zinc-800 text-zinc-300
            hover:border-aqua hover:text-aqua transition-colors
            disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isRunning ? (
            <>
              <span className="h-3.5 w-3.5 rounded-full border-2 border-aqua border-t-transparent animate-spin" />
              Running…
            </>
          ) : (
            <>
              <span className="text-xs">▶</span>
              Run Now
            </>
          )}
        </button>

        {isRunning && (
          <div className="text-right">
            <p className="text-sm font-medium text-aqua tabular-nums">
              <ElapsedTimer />
            </p>
            <p className="text-xs text-zinc-500">
              poll {pollCount} / 30
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
