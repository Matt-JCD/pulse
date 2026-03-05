'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { getApiUrl } from '@/lib/apiUrl';

const API_URL = getApiUrl();

const POLL_INTERVAL_MS = 12_000;  // check every 12 seconds
const MAX_POLLS = 30;              // give up after ~6 minutes

interface RunLogEntry {
  id: number;
  created_at: string;
  function_name: string;
  status: string;
  error_msg: string | null;
}

async function fetchRunLog(): Promise<RunLogEntry[]> {
  try {
    const res = await fetch(`${API_URL}/api/intelligence/run-log`);
    if (!res.ok) return [];
    return await res.json() as RunLogEntry[];
  } catch {
    return [];
  }
}

export function useIntelligence() {
  const router = useRouter();
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const clearPollTimer = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPollTimer();
    };
  }, []);

  async function handleRunNow() {
    clearPollTimer();
    setIsRunning(true);
    setRunError(null);

    try {
      // Snapshot the full run_log before triggering so we can identify new entries afterwards
      const baselineLog = await fetchRunLog();
      const baselineIds = new Set(baselineLog.map((r) => r.id));
      const baselineSynthId = baselineLog.find((r) => r.function_name === 'synthesizer')?.id ?? null;

      // Trigger — send NO platform value so backend runs everything (!platform = true)
      const res = await fetch(`${API_URL}/api/intelligence/trigger-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`Trigger failed: ${res.status}`);

      // Poll until a new synthesizer entry appears — that means the full
      // pipeline (collectors → synthesizer) has finished (success or error).
      let polls = 0;
      const poll = async (): Promise<void> => {
        polls++;
        setPollCount(polls);
        const latestLog = await fetchRunLog();
        const latestSynthId = latestLog.find((r) => r.function_name === 'synthesizer')?.id ?? null;

        if (latestSynthId !== null && latestSynthId !== baselineSynthId) {
          // Synthesizer completed — check if any agent in this run failed
          const newEntries = latestLog.filter((r) => !baselineIds.has(r.id));
          const failed = newEntries.filter((r) => r.status === 'error');
          if (failed.length > 0) {
            const names = failed.map((r) => r.function_name).join(', ');
            if (mountedRef.current) {
              setRunError(`Run failed: ${names} — check the backend terminal.`);
            }
          }
          // Always refresh so whatever data was collected is visible
          router.refresh();
          if (mountedRef.current) {
            setIsRunning(false);
            setPollCount(0);
          }
          return;
        }

        if (polls >= MAX_POLLS) {
          if (mountedRef.current) {
            setRunError('Run timed out — check the backend logs.');
            setIsRunning(false);
            setPollCount(0);
          }
          return;
        }

        timeoutRef.current = setTimeout(poll, POLL_INTERVAL_MS);
      };

      timeoutRef.current = setTimeout(poll, POLL_INTERVAL_MS);
    } catch (err) {
      clearPollTimer();
      if (mountedRef.current) {
        setRunError(err instanceof Error ? err.message : 'Run failed');
        setIsRunning(false);
      }
    }
  }

  return { isRunning, runError, pollCount, handleRunNow };
}
