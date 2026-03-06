'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  settingsApi,
  type Keyword,
  type ApiConnection,
  type ConnectionTestResult,
  type PipelineRun,
  type AppConfig,
} from './settings.api';

export type SettingsTab = 'keywords' | 'connections' | 'pipeline' | 'notifications';

export function useSettings() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('keywords');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keywords state
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [keywordsLoaded, setKeywordsLoaded] = useState(false);

  // Connections state
  const [connections, setConnections] = useState<ApiConnection[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [testResults, setTestResults] = useState<ConnectionTestResult[] | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  // Pipeline state
  const [pipelineRuns, setPipelineRuns] = useState<PipelineRun[]>([]);
  const [pipelineLoaded, setPipelineLoaded] = useState(false);
  const [triggeringFn, setTriggeringFn] = useState<string | null>(null);

  // Config state
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);

  // Load data when tab changes
  useEffect(() => {
    if (activeTab === 'keywords' && !keywordsLoaded) {
      loadKeywords();
    } else if (activeTab === 'connections' && !connectionsLoaded) {
      loadConnections();
    } else if (activeTab === 'pipeline' && !pipelineLoaded) {
      loadPipeline();
    } else if (activeTab === 'notifications' && !configLoaded) {
      loadConfig();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // --- Keywords ---
  const loadKeywords = useCallback(async () => {
    try {
      const data = await settingsApi.fetchKeywords();
      setKeywords(data);
      setKeywordsLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load keywords');
    }
  }, []);

  async function addKeyword(keyword: string, category: string, platforms: string[]) {
    setIsLoading(true);
    setError(null);
    try {
      const created = await settingsApi.addKeyword(keyword, category, platforms);
      setKeywords((prev) => [...prev, created]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add keyword');
    } finally {
      setIsLoading(false);
    }
  }

  async function updateKeyword(id: number, updates: Partial<Pick<Keyword, 'keyword' | 'active' | 'category' | 'platforms'>>) {
    setError(null);
    try {
      const updated = await settingsApi.updateKeyword(id, updates);
      setKeywords((prev) => prev.map((k) => (k.id === id ? updated : k)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update keyword');
    }
  }

  async function deleteKeyword(id: number) {
    setError(null);
    try {
      await settingsApi.deleteKeyword(id);
      setKeywords((prev) => prev.map((k) => (k.id === id ? { ...k, active: false } : k)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete keyword');
    }
  }

  // --- Connections ---
  const loadConnections = useCallback(async () => {
    try {
      const data = await settingsApi.fetchConnections();
      setConnections(data);
      setConnectionsLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load connections');
    }
  }, []);

  async function testAllConnections() {
    setIsTesting(true);
    setError(null);
    try {
      const results = await settingsApi.testConnections();
      setTestResults(results);
      // Reload connections to get updated statuses
      await loadConnections();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection test failed');
    } finally {
      setIsTesting(false);
    }
  }

  // --- Pipeline ---
  const loadPipeline = useCallback(async () => {
    try {
      const data = await settingsApi.fetchPipelineStatus();
      setPipelineRuns(data);
      setPipelineLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pipeline status');
    }
  }, []);

  async function triggerPipeline(fn: string) {
    setTriggeringFn(fn);
    setError(null);
    try {
      await settingsApi.triggerPipeline(fn);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger pipeline');
    } finally {
      setTriggeringFn(null);
    }
  }

  // --- Config ---
  const loadConfig = useCallback(async () => {
    try {
      const data = await settingsApi.fetchConfig();
      setConfig(data);
      setConfigLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load config');
    }
  }, []);

  async function updateConfig(updates: Partial<AppConfig>) {
    setSavingConfig(true);
    setError(null);
    try {
      const updated = await settingsApi.updateConfig(updates);
      setConfig(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save config');
    } finally {
      setSavingConfig(false);
    }
  }

  return {
    activeTab,
    setActiveTab,
    isLoading,
    error,
    setError,
    // Keywords
    keywords,
    addKeyword,
    updateKeyword,
    deleteKeyword,
    // Connections
    connections,
    testResults,
    isTesting,
    testAllConnections,
    // Pipeline
    pipelineRuns,
    triggeringFn,
    triggerPipeline,
    loadPipeline,
    // Config
    config,
    savingConfig,
    updateConfig,
  };
}
