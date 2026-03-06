'use client';

import { useSettings, type SettingsTab } from './useSettings';
import { KeywordsTab } from './KeywordsTab';
import { ConnectionsTab } from './ConnectionsTab';
import { PipelineTab } from './PipelineTab';
import { NotificationsTab } from './NotificationsTab';

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'keywords', label: 'Keywords' },
  { key: 'connections', label: 'Connections' },
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'notifications', label: 'Notifications' },
];

export function Settings() {
  const {
    activeTab,
    setActiveTab,
    isLoading,
    error,
    setError,
    keywords,
    addKeyword,
    updateKeyword,
    deleteKeyword,
    connections,
    testResults,
    isTesting,
    testAllConnections,
    pipelineRuns,
    triggeringFn,
    triggerPipeline,
    loadPipeline,
    config,
    savingConfig,
    updateConfig,
  } = useSettings();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
        <p className="mt-1 text-sm text-muted">Manage keywords, connections, pipeline, and notifications.</p>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.key
                ? 'border-aqua text-aqua'
                : 'border-transparent text-muted hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center justify-between rounded-lg border border-red-900/30 bg-red-900/10 px-4 py-2">
          <p className="text-sm text-red-400">{error}</p>
          <button onClick={() => setError(null)} className="text-xs text-red-400 hover:text-red-300">
            Dismiss
          </button>
        </div>
      )}

      {/* Tab content */}
      <div>
        {activeTab === 'keywords' && (
          <KeywordsTab
            keywords={keywords}
            onAdd={addKeyword}
            onUpdate={updateKeyword}
            onDelete={deleteKeyword}
            isLoading={isLoading}
          />
        )}
        {activeTab === 'connections' && (
          <ConnectionsTab
            connections={connections}
            testResults={testResults}
            isTesting={isTesting}
            onTestAll={testAllConnections}
          />
        )}
        {activeTab === 'pipeline' && (
          <PipelineTab
            runs={pipelineRuns}
            triggeringFn={triggeringFn}
            onTrigger={triggerPipeline}
            onRefresh={loadPipeline}
          />
        )}
        {activeTab === 'notifications' && (
          <NotificationsTab
            config={config}
            saving={savingConfig}
            onUpdate={updateConfig}
          />
        )}
      </div>
    </div>
  );
}
