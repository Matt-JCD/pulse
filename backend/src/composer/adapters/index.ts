import type { Platform, PlatformResult, ComposerPost } from '../types.js';
import * as twitter from './twitter.js';
import * as linkedin from './linkedin.js';

export interface PlatformAdapter {
  publish(post: ComposerPost): Promise<PlatformResult>;
}

const adapters: Record<Platform, PlatformAdapter> = {
  twitter,
  linkedin,
};

/**
 * Returns the adapter for the given platform.
 * To add a new platform: create an adapter file, import it, add it to this map.
 */
export function getAdapter(platform: Platform): PlatformAdapter | undefined {
  return adapters[platform];
}
