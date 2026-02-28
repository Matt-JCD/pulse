export type Platform = 'linkedin' | 'twitter';

export type PostStatus = 'draft' | 'scheduled' | 'published' | 'rejected' | 'failed';

export interface ComposerPost {
  id: number;
  content: string;
  platform: Platform;
  status: PostStatus;
  scheduled_at: string | null;
  published_at: string | null;
  platform_post_id: string | null;
  source_topic: string | null;
  source_keyword: string | null;
  created_at: string;
  updated_at: string;
}

export interface DraftRequest {
  topicId: string;
  topicTitle: string;
  topicSummary: string;
  keywords: string[];
  sourceLinks?: string[];
  platform: Platform;
}

export interface PlatformResult {
  platform: Platform;
  success: boolean;
  postId?: string;
  url?: string;
  error?: string;
}
