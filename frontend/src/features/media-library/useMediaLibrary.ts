'use client';

import { useRouter } from 'next/navigation';
import { useState, useCallback } from 'react';
import type { Episode, MediaAsset, AssetType } from '@/lib/api';
import { api } from '@/lib/api';

import { getApiUrl } from '@/lib/apiUrl';

const API_URL = getApiUrl();

export function useMediaLibrary(initialEpisodes: Episode[]) {
  const router = useRouter();

  // Tab state
  const [activeTab, setActiveTab] = useState<'episodes' | 'assets'>('episodes');

  // Episode state
  const [episodes, setEpisodes] = useState<Episode[]>(initialEpisodes);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [editingEpisode, setEditingEpisode] = useState<Episode | null>(null);

  // Asset state
  const [episodeAssets, setEpisodeAssets] = useState<Record<string, MediaAsset[]>>({});
  const [showAssetForm, setShowAssetForm] = useState(false);
  const [allAssets, setAllAssets] = useState<{ asset: MediaAsset; episodeName: string }[]>([]);
  const [allAssetsLoaded, setAllAssetsLoaded] = useState(false);
  const [assetTypeFilter, setAssetTypeFilter] = useState<AssetType | ''>('');

  // Shared state
  const [isLoading, setIsLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const selectedEpisode = episodes.find((e) => e.id === selectedEpisodeId) ?? null;

  // ── Episode handlers ──

  async function refreshEpisodes() {
    try {
      const fresh = await api.media.episodes();
      setEpisodes(fresh);
    } catch {
      // SSR data stays as fallback
    }
  }

  async function handleCreateEpisode(data: {
    title: string;
    guest_name?: string;
    episode_number?: number;
    publish_date?: string;
    status?: string;
  }) {
    setIsLoading(true);
    setActionError(null);
    try {
      await api.media.createEpisode(data);
      await refreshEpisodes();
      setShowNewForm(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create episode');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleUpdateEpisode(id: string, data: Partial<{
    title: string;
    guest_name: string | null;
    episode_number: number | null;
    publish_date: string | null;
    status: string;
  }>) {
    setIsLoading(true);
    setActionError(null);
    try {
      await api.media.updateEpisode(id, data);
      await refreshEpisodes();
      setEditingEpisode(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update episode');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDeleteEpisode(id: string) {
    setIsLoading(true);
    setActionError(null);
    try {
      await api.media.deleteEpisode(id);
      if (selectedEpisodeId === id) {
        setSelectedEpisodeId(null);
        setShowAssetForm(false);
      }
      await refreshEpisodes();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete episode');
    } finally {
      setIsLoading(false);
    }
  }

  // ── Episode expand (loads assets) ──

  const handleSelectEpisode = useCallback(async (id: string | null) => {
    if (id === selectedEpisodeId) {
      setSelectedEpisodeId(null);
      setShowAssetForm(false);
      return;
    }
    setSelectedEpisodeId(id);
    setShowAssetForm(false);
    setEditingEpisode(null);
    if (id && !episodeAssets[id]) {
      try {
        const assets = await api.media.assets(id);
        setEpisodeAssets((prev) => ({ ...prev, [id]: assets }));
      } catch {
        setEpisodeAssets((prev) => ({ ...prev, [id]: [] }));
      }
    }
  }, [selectedEpisodeId, episodeAssets]);

  // ── Asset handlers ──

  async function handleUploadAsset(episodeId: string, formData: FormData) {
    setIsLoading(true);
    setActionError(null);
    try {
      const res = await fetch(`${API_URL}/api/media/episodes/${episodeId}/assets`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error || 'Upload failed');
      }
      // Refresh assets for this episode
      const assets = await api.media.assets(episodeId);
      setEpisodeAssets((prev) => ({ ...prev, [episodeId]: assets }));
      setShowAssetForm(false);
      setAllAssetsLoaded(false); // invalidate All Assets cache
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to upload asset');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleAddExternalAsset(episodeId: string, body: {
    asset_type: AssetType;
    title?: string;
    external_url: string;
  }) {
    setIsLoading(true);
    setActionError(null);
    try {
      const res = await fetch(`${API_URL}/api/media/episodes/${episodeId}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errBody.error || 'Failed to add asset');
      }
      const assets = await api.media.assets(episodeId);
      setEpisodeAssets((prev) => ({ ...prev, [episodeId]: assets }));
      setShowAssetForm(false);
      setAllAssetsLoaded(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to add asset');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDeleteAsset(assetId: string, episodeId: string) {
    setIsLoading(true);
    setActionError(null);
    try {
      await api.media.deleteAsset(assetId);
      const assets = await api.media.assets(episodeId);
      setEpisodeAssets((prev) => ({ ...prev, [episodeId]: assets }));
      setAllAssetsLoaded(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete asset');
    } finally {
      setIsLoading(false);
    }
  }

  // ── Tab change + All Assets loading ──

  async function handleTabChange(tab: 'episodes' | 'assets') {
    setActiveTab(tab);
    if (tab === 'assets' && !allAssetsLoaded) {
      setIsLoading(true);
      try {
        const allEps = episodes.length > 0 ? episodes : await api.media.episodes();
        const epMap = new Map(allEps.map((e) => [e.id, e.title]));
        const assetArrays = await Promise.all(
          allEps.map((ep) => api.media.assets(ep.id)),
        );
        const flat = assetArrays.flatMap((assets, i) =>
          assets.map((a) => ({
            asset: a,
            episodeName: epMap.get(allEps[i].id) || 'Unknown',
          })),
        );
        setAllAssets(flat);
        setAllAssetsLoaded(true);
      } catch {
        setAllAssets([]);
      } finally {
        setIsLoading(false);
      }
    }
  }

  return {
    // Tab
    activeTab,
    handleTabChange,

    // Episodes
    episodes,
    selectedEpisode,
    selectedEpisodeId,
    showNewForm,
    setShowNewForm,
    editingEpisode,
    setEditingEpisode,
    handleSelectEpisode,
    handleCreateEpisode,
    handleUpdateEpisode,
    handleDeleteEpisode,

    // Assets
    episodeAssets,
    showAssetForm,
    setShowAssetForm,
    handleUploadAsset,
    handleAddExternalAsset,
    handleDeleteAsset,

    // All Assets tab
    allAssets,
    allAssetsLoaded,
    assetTypeFilter,
    setAssetTypeFilter,

    // Shared
    isLoading,
    actionError,
  };
}
