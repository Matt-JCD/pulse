'use client';

import type { PipelineRun } from './settings.api';

const FUNCTION_LABELS: Record<string, string> = {
  'hn-collector': 'Hacker News Collector',
  'reddit-collector': 'Reddit Collector',
  'twitter-collector': 'Twitter/X Collector',
  'synthesizer': 'Synthesizer',
  'composer-auto-draft': 'Auto-Draft (Composer)',
  'engagement-refresh': 'Engagement Refresh',
};

const STATUS_STYLES: Record<string, string> = {
  success: 'bg-emerald-900/20 text-emerald-400',
  error: 'bg-red-900/20 text-red-400',
};

interface Props {
  runs: PipelineRun[];
  triggeringFn: string | null;
  onTrigger: (fn: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export function PipelineTab({ runs, triggeringFn, onTrigger, onRefresh }: Props) {
  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  function formatDuration(ms: number | null): string {
    if (ms === null) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  // Show all known functions, even if no run exists yet
  const allFunctions = Object.keys(FUNCTION_LABELS);
  const runMap = new Map(runs.map((r) => [r.function_name, r]));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          Pipeline functions and their latest run status.
        </p>
        <button
          onClick={onRefresh}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground hover:border-zinc-600 transition-colors"
        >
          Refresh
        </button>
      </div>

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface">
              <th className="px-4 py-2 text-left text-xs font-medium text-muted">Function</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted">Status</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted">Last Run</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted">Duration</th>
              <th className="px-4 py-2 text-right text-xs font-medium text-muted">Action</th>
            </tr>
          </thead>
          <tbody>
            {allFunctions.map((fn) => {
              const run = runMap.get(fn);
              const statusClass = run ? (STATUS_STYLES[run.status] || 'bg-zinc-800 text-zinc-400') : 'bg-zinc-800 text-zinc-600';
              const isTriggering = triggeringFn === fn;

              return (
                <tr key={fn} className="border-b border-border/50 last:border-0">
                  <td className="px-4 py-2.5 text-foreground text-xs font-medium">
                    {FUNCTION_LABELS[fn]}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${statusClass}`}>
                      {run?.status || 'No runs'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted">
                    {run ? formatDate(run.created_at) : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted font-mono">
                    {run ? formatDuration(run.duration_ms) : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => onTrigger(fn)}
                      disabled={isTriggering}
                      className="rounded-md bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors disabled:opacity-50"
                    >
                      {isTriggering ? 'Running...' : 'Run Now'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Show error details if any run has errors */}
      {runs.filter((r) => r.error_msg).length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-widest text-muted">Recent Errors</h3>
          {runs
            .filter((r) => r.error_msg)
            .map((r) => (
              <div key={r.id} className="rounded-lg border border-red-900/30 bg-red-900/10 p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-red-400">
                    {FUNCTION_LABELS[r.function_name] || r.function_name}
                  </span>
                  <span className="text-xs text-zinc-600">{formatDate(r.created_at)}</span>
                </div>
                <p className="text-xs text-red-300/80 font-mono">{r.error_msg}</p>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
