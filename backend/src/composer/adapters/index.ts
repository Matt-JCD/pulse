import type { Platform, PlatformResult } from '../types.js';
import * as twitter from './twitter.js';
import * as linkedin from './linkedin.js';

export interface PlatformAdapter {
  publish(content: string): Promise<PlatformResult>;
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
