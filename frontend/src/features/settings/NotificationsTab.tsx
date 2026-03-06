'use client';

import { useState, useEffect } from 'react';
import type { AppConfig } from './settings.api';

interface Props {
  config: AppConfig | null;
  saving: boolean;
  onUpdate: (updates: Partial<AppConfig>) => Promise<void>;
}

export function NotificationsTab({ config, saving, onUpdate }: Props) {
  const [email, setEmail] = useState(config?.notification_email || '');

  useEffect(() => {
    if (config?.notification_email) {
      setEmail(config.notification_email);
    }
  }, [config?.notification_email]);

  if (!config) {
    return <p className="text-sm text-muted py-8 text-center">Loading configuration...</p>;
  }

  function handleToggle(field: keyof AppConfig, value: boolean) {
    onUpdate({ [field]: value });
  }

  function handleSaveEmail() {
    onUpdate({ notification_email: email || null });
  }

  return (
    <div className="space-y-6 max-w-xl">
      <p className="text-sm text-muted">
        Configure when and how you receive notifications about pipeline activity.
      </p>

      {/* Toggle switches */}
      <div className="space-y-4">
        <ToggleRow
          label="Alert on failure"
          description="Send a notification when a pipeline function fails."
          checked={config.alert_on_failure}
          disabled={saving}
          onChange={(v) => handleToggle('alert_on_failure', v)}
        />
        <ToggleRow
          label="Alert when no posts collected"
          description="Send a notification when collectors return zero results."
          checked={config.alert_on_no_posts}
          disabled={saving}
          onChange={(v) => handleToggle('alert_on_no_posts', v)}
        />
        <ToggleRow
          label="Daily summary"
          description="Receive a daily digest of pipeline activity and post stats."
          checked={config.daily_summary_enabled}
          disabled={saving}
          onChange={(v) => handleToggle('daily_summary_enabled', v)}
        />
      </div>

      {/* Email input */}
      <div className="rounded-lg border border-border bg-surface p-4">
        <label className="block text-sm font-medium text-foreground mb-1">
          Notification Email
        </label>
        <p className="text-xs text-muted mb-3">
          Where to send email notifications (leave blank to disable email).
        </p>
        <div className="flex gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="matt@prefactor.ai"
            className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-zinc-600 focus:border-aqua focus:outline-none"
          />
          <button
            onClick={handleSaveEmail}
            disabled={saving}
            className="rounded-md bg-aqua px-4 py-1.5 text-sm font-medium text-background hover:bg-aqua/90 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-surface p-4">
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted mt-0.5">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50 ${
          checked ? 'bg-aqua' : 'bg-zinc-700'
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}
