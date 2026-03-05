export function getApiUrl(): string {
  // Explicit override always wins (local dev with separate processes)
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  // Browser: relative URL (same origin)
  if (typeof window !== 'undefined') return '';
  // Server: loopback to same process
  const port = process.env.PORT || '3001';
  return `http://localhost:${port}`;
}
