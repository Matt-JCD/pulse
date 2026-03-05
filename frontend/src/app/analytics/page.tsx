import { fetchSummary } from '@/features/analytics/Analytics.api';
import { Analytics } from '@/features/analytics/Analytics';

export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const summary = await fetchSummary();

  return <Analytics initialSummary={summary} />;
}
