'use client';

import { useState } from 'react';
import type { Keyword } from './settings.api';

const PLATFORM_OPTIONS = ['reddit', 'hn', 'twitter'] as const;
const CATEGORY_OPTIONS = ['ecosystem', 'enterprise'] as const;

interface Props {
  keywords: Keyword[];
  onAdd: (keyword: string, category: string, platforms: string[]) => Promise<void>;
  onUpdate: (id: number, updates: Partial<Pick<Keyword, 'keyword' | 'active' | 'category' | 'platforms'>>) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  isLoading: boolean;
}

export function KeywordsTab({ keywords, onAdd, onUpdate, onDelete, isLoading }: Props) {
  const [newKeyword, setNewKeyword] = useState('');
  const [newCategory, setNewCategory] = useState<'ecosystem' | 'enterprise'>('ecosystem');
  const [newPlatforms, setNewPlatforms] = useState<string[]>(['reddit', 'hn']);

  async function handleAdd() {
    if (!newKeyword.trim()) return;
    await onAdd(newKeyword.trim(), newCategory, newPlatforms);
    setNewKeyword('');
  }

  function toggleNewPlatform(p: string) {
    setNewPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );
  }

  function togglePlatform(kw: Keyword, platform: string) {
    const updated = kw.platforms.includes(platform)
      ? kw.platforms.filter((p) => p !== platform)
      : [...kw.platforms, platform];
    onUpdate(kw.id, { platforms: updated });
  }

  const active = keywords.filter((k) => k.active);
  const inactive = keywords.filter((k) => !k.active);

  return (
    <div className="space-y-6">
      {/* Add keyword form */}
      <div className="rounded-lg border border-border bg-surface p-4">
        <h3 className="text-sm font-medium text-foreground mb-3">Add Keyword</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-muted mb-1">Keyword</label>
            <input
              type="text"
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              placeholder="e.g. autonomous agents"
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-zinc-600 focus:border-aqua focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">Category</label>
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value as 'ecosystem' | 'enterprise')}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-aqua focus:outline-none"
            >
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">Platforms</label>
            <div className="flex gap-1">
              {PLATFORM_OPTIONS.map((p) => (
                <button
                  key={p}
                  onClick={() => toggleNewPlatform(p)}
                  className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                    newPlatforms.includes(p)
                      ? 'bg-aqua/15 text-aqua'
                      : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {p === 'hn' ? 'HN' : p === 'twitter' ? 'X' : 'Reddit'}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={handleAdd}
            disabled={isLoading || !newKeyword.trim()}
            className="rounded-md bg-aqua px-4 py-1.5 text-sm font-medium text-background hover:bg-aqua/90 transition-colors disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>

      {/* Active keywords */}
      <div>
        <h3 className="text-xs font-medium uppercase tracking-widest text-muted mb-2">
          Active Keywords ({active.length})
        </h3>
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface">
                <th className="px-4 py-2 text-left text-xs font-medium text-muted">Keyword</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted">Category</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted">Platforms</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {active.map((kw) => (
                <tr key={kw.id} className="border-b border-border/50 last:border-0">
                  <td className="px-4 py-2.5 text-foreground font-mono text-xs">{kw.keyword}</td>
                  <td className="px-4 py-2.5">
                    <select
                      value={kw.category}
                      onChange={(e) => onUpdate(kw.id, { category: e.target.value as 'ecosystem' | 'enterprise' })}
                      className="rounded border border-border bg-background px-2 py-0.5 text-xs text-foreground focus:border-aqua focus:outline-none"
                    >
                      {CATEGORY_OPTIONS.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex gap-1">
                      {PLATFORM_OPTIONS.map((p) => (
                        <button
                          key={p}
                          onClick={() => togglePlatform(kw, p)}
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                            kw.platforms?.includes(p)
                              ? 'bg-aqua/15 text-aqua'
                              : 'bg-zinc-800/50 text-zinc-600 hover:text-zinc-400'
                          }`}
                        >
                          {p === 'hn' ? 'HN' : p === 'twitter' ? 'X' : 'Reddit'}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => onDelete(kw.id)}
                      className="text-xs text-zinc-600 hover:text-red-400 transition-colors"
                    >
                      Deactivate
                    </button>
                  </td>
                </tr>
              ))}
              {active.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted">No active keywords.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Inactive keywords */}
      {inactive.length > 0 && (
        <div>
          <h3 className="text-xs font-medium uppercase tracking-widest text-muted mb-2">
            Inactive ({inactive.length})
          </h3>
          <div className="rounded-lg border border-border/50 overflow-hidden opacity-60">
            <table className="w-full text-sm">
              <tbody>
                {inactive.map((kw) => (
                  <tr key={kw.id} className="border-b border-border/30 last:border-0">
                    <td className="px-4 py-2 text-zinc-600 font-mono text-xs">{kw.keyword}</td>
                    <td className="px-4 py-2 text-xs text-zinc-600">{kw.category}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => onUpdate(kw.id, { active: true })}
                        className="text-xs text-zinc-600 hover:text-aqua transition-colors"
                      >
                        Reactivate
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
