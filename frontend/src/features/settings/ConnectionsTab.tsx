'use client';

import type { ApiConnection, ConnectionTestResult } from './settings.api';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  scrapebadger: 'ScrapeBadger',
  linkedapi: 'LinkedAPI',
  x_api: 'X (Twitter) API',
  linkedin_api: 'LinkedIn API',
};

const STATUS_STYLES: Record<string, { dot: string; label: string }> = {
  connected: { dot: 'bg-emerald-400', label: 'Connected' },
  error: { dot: 'bg-red-400', label: 'Error' },
  unknown: { dot: 'bg-zinc-500', label: 'Not tested' },
};

interface Props {
  connections: ApiConnection[];
  testResults: ConnectionTestResult[] | null;
  isTesting: boolean;
  onTestAll: () => Promise<void>;
}

export function ConnectionsTab({ connections, testResults, isTesting, onTestAll }: Props) {
  function formatDate(iso: string | null): string {
    if (!iso) return 'Never';
    return new Date(iso).toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          API connection status for all integrated services.
        </p>
        <button
          onClick={onTestAll}
          disabled={isTesting}
          className="rounded-md bg-aqua px-4 py-1.5 text-sm font-medium text-background hover:bg-aqua/90 transition-colors disabled:opacity-50"
        >
          {isTesting ? 'Testing...' : 'Test All'}
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {connections.map((conn) => {
          const style = STATUS_STYLES[conn.status] || STATUS_STYLES.unknown;
          const testResult = testResults?.find((r) => r.provider === conn.provider);

          return (
            <div
              key={conn.id}
              className="rounded-lg border border-border bg-surface p-4"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-foreground">
                  {PROVIDER_LABELS[conn.provider] || conn.provider}
                </span>
                <div className="flex items-center gap-1.5">
                  <div className={`w-2 h-2 rounded-full ${style.dot}`} />
                  <span className="text-xs text-muted">{style.label}</span>
                </div>
              </div>

              {conn.error_message && (
                <p className="text-xs text-red-400 mb-1">{conn.error_message}</p>
              )}

              <p className="text-xs text-zinc-600">
                Last checked: {formatDate(conn.last_checked_at)}
              </p>

              {testResult && (
                <p className={`text-xs mt-1 ${testResult.connected ? 'text-emerald-400' : 'text-red-400'}`}>
                  {testResult.connected ? 'Test passed' : `Test failed: ${testResult.error}`}
                </p>
              )}
            </div>
          );
        })}

        {connections.length === 0 && (
          <p className="text-sm text-muted col-span-full py-8 text-center">
            No connections configured. Run the migration first.
          </p>
        )}
      </div>
    </div>
  );
}
