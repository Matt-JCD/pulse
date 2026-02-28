interface TopicLink {
  url: string;
  platform: string;
}

interface MergedTopic {
  topicTitle: string;
  summary: string;
  category: 'ecosystem' | 'enterprise';
  postCount: number;
  links: TopicLink[];
  platforms: string[];
}

const SOURCE_PRIORITY: Array<{ key: string; label: string }> = [
  { key: 'bbc.com', label: 'BBC' },
  { key: 'cnbc.com', label: 'CNBC' },
  { key: 'cnn.com', label: 'CNN' },
  { key: 'techcrunch.com', label: 'TechCrunch' },
  { key: 'reuters.com', label: 'Reuters' },
  { key: 'wired.com', label: 'Wired' },
  { key: 'cnet.com', label: 'CNET' },
  { key: 'theverge.com', label: 'The Verge' },
  { key: 'news.ycombinator.com', label: 'Hacker News' },
  { key: 'ycombinator.com', label: 'Hacker News' },
];

function sourceInfo(url: string): { label: string; priority: number } {
  try {
    const host = new URL(url).hostname.replace('www.', '').toLowerCase();
    const idx = SOURCE_PRIORITY.findIndex((src) => host.includes(src.key));
    if (idx >= 0) return { label: SOURCE_PRIORITY[idx].label, priority: idx };

    if (host.includes('reddit.com')) return { label: 'Reddit', priority: 100 };
    if (host.includes('twitter.com') || host.includes('x.com')) return { label: 'X', priority: 101 };

    const domain = host.split('.');
    if (domain.length >= 2) {
      return { label: domain[domain.length - 2].toUpperCase(), priority: 999 };
    }
    return { label: host.toUpperCase(), priority: 999 };
  } catch {
    return { label: 'Source', priority: 999 };
  }
}

function platformLabel(platform: string): string {
  const p = platform.toLowerCase();
  if (p === 'hackernews') return 'HN';
  if (p === 'reddit') return 'Reddit';
  if (p === 'twitter') return 'X';
  return platform;
}

function sortedLinks(links: TopicLink[]): TopicLink[] {
  const unique = new Map<string, TopicLink>();
  for (const link of links) {
    if (!link.url) continue;
    if (!unique.has(link.url)) unique.set(link.url, link);
  }

  return [...unique.values()].sort((a, b) => {
    const aInfo = sourceInfo(a.url);
    const bInfo = sourceInfo(b.url);
    if (aInfo.priority !== bInfo.priority) return aInfo.priority - bInfo.priority;
    if (aInfo.label !== bInfo.label) return aInfo.label.localeCompare(bInfo.label);
    return platformLabel(a.platform).localeCompare(platformLabel(b.platform));
  });
}

interface Props {
  topic: MergedTopic;
  rank: number;
}

export function TopicCard({ topic, rank }: Props) {
  const isEcosystem = topic.category === 'ecosystem';
  const links = sortedLinks(topic.links).slice(0, 20);

  return (
    <div className="bg-[#111113] rounded-lg p-4 border border-zinc-800/60">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-start gap-2">
          <span className="text-xs text-zinc-500 tabular-nums mt-0.5">#{rank}</span>
          <p className="text-sm font-semibold text-zinc-100 leading-snug">
            {topic.topicTitle}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
              isEcosystem ? 'bg-aqua/10 text-aqua' : 'bg-sage/10 text-sage'
            }`}
          >
            {topic.platforms.join(', ')}
          </span>
          <span className="text-[10px] text-zinc-600">
            {topic.postCount} posts
          </span>
        </div>
      </div>

      <p className="text-sm text-zinc-400 leading-relaxed mb-3">
        {topic.summary}
      </p>

      {links.length > 0 && (
        <div className="relative inline-block group">
          <span className="text-xs text-aqua cursor-default">
            Read thread/article ({links.length})
          </span>
          <div className="hidden group-hover:block group-focus-within:block absolute z-20 top-full left-0 mt-2 w-[340px] max-h-64 overflow-auto rounded-md border border-zinc-700 bg-[#0A0A0B] p-2">
            <div className="space-y-1.5">
              {links.map((link) => {
                const info = sourceInfo(link.url);
                return (
                  <a
                    key={`${link.url}-${link.platform}`}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-xs text-zinc-300 hover:text-aqua hover:underline"
                    title={link.url}
                  >
                    {info.label} · {platformLabel(link.platform)}
                  </a>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
