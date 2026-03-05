'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { getApiUrl } from '@/lib/apiUrl';

const API_URL = getApiUrl();

async function patch<T>(path: string, body?: object): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `PATCH ${path} returned ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function useComposer() {
  const router = useRouter();
  const [editingPostId, setEditingPostId] = useState<number | null>(null);
  const [rejectingPostId, setRejectingPostId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleApprove(id: number) {
    setIsLoading(true);
    setActionError(null);
    try {
      await patch(`/api/composer/${id}/approve`);
      router.refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Approve failed');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSubmit(id: number) {
    setIsLoading(true);
    setActionError(null);
    try {
      await patch(`/api/composer/${id}/submit`);
      router.refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Submit failed');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleReject(id: number) {
    setIsLoading(true);
    setActionError(null);
    try {
      await patch(`/api/composer/${id}/reject`);
      setRejectingPostId(null);
      router.refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Reject failed');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRevise(id: number, feedback: string) {
    setIsLoading(true);
    setActionError(null);
    try {
      await patch(`/api/composer/${id}/revise`, { feedback });
      setRejectingPostId(null);
      router.refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Revision failed');
    } finally {
      setIsLoading(false);
    }
  }

  async function handlePublishNow(id: number) {
    setIsLoading(true);
    setActionError(null);
    try {
      await patch(`/api/composer/${id}/publish`);
      router.refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Publish failed');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDelete(id: number) {
    setIsLoading(true);
    setActionError(null);
    try {
      const res = await fetch(`${API_URL}/api/composer/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `DELETE returned ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleEdit(id: number, content: string) {
    setIsLoading(true);
    setActionError(null);
    try {
      await patch(`/api/composer/${id}/edit`, { content });
      setEditingPostId(null);
      router.refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Edit failed');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleEditSchedule(id: number, scheduledAt: string) {
    setIsLoading(true);
    setActionError(null);
    try {
      await patch(`/api/composer/${id}/edit`, { scheduled_at: scheduledAt });
      router.refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Schedule update failed');
    } finally {
      setIsLoading(false);
    }
  }

  return {
    editingPostId,
    setEditingPostId,
    rejectingPostId,
    setRejectingPostId,
    isLoading,
    actionError,
    handleSubmit,
    handleApprove,
    handleReject,
    handleRevise,
    handlePublishNow,
    handleEdit,
    handleEditSchedule,
    handleDelete,
  };
}
