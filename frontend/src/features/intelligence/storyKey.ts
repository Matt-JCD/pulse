import { similarityTokenSet } from './similarity';

const ENTITY_HINTS = [
  'anthropic', 'openai', 'claude', 'codex', 'gemini', 'mistral', 'meta', 'microsoft',
  'google', 'pentagon', 'trump', 'white', 'house', 'eu', 'senate', 'fcc', 'ftc',
];

const EVENT_HINTS = [
  'pressure', 'pressur', 'ban', 'designat', 'risk', 'lawsuit', 'sue', 'fund', 'valuation',
  'acquire', 'launch', 'release', 'outage', 'breach', 'exploit', 'vulnerab', 'attack',
  'policy', 'safety', 'military', 'classifi', 'contract',
];

function pickHints(tokens: Set<string>, hints: string[]): string[] {
  const matches = new Set<string>();
  for (const token of tokens) {
    for (const hint of hints) {
      if (token.includes(hint) || hint.includes(token)) {
        matches.add(hint);
      }
    }
  }
  return [...matches].sort();
}

export function deriveStoryKey(title: string, summary: string, keyword: string): string | null {
  const text = `${title} ${summary} ${keyword}`;
  const tokens = similarityTokenSet(text);

  const hasAnthropic = tokens.has('anthropic');
  const hasTrump = tokens.has('trump');
  const hasPentagon = tokens.has('pentagon');
  const hasGovConflict = tokens.has('military') || tokens.has('classifi') || tokens.has('designat') || tokens.has('ban');
  if (hasAnthropic && ((hasTrump && hasPentagon) || ((hasTrump || hasPentagon) && hasGovConflict))) {
    return 'story:anthropic-us-government-conflict';
  }

  const entities = pickHints(tokens, ENTITY_HINTS);
  const events = pickHints(tokens, EVENT_HINTS);

  if (entities.length >= 2 && events.length >= 1) {
    return `ent:${entities.slice(0, 4).join('+')}|evt:${events.slice(0, 3).join('+')}`;
  }
  if (entities.length >= 3) {
    return `ent:${entities.slice(0, 4).join('+')}`;
  }
  return null;
}

function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function capitalize(word: string): string {
  return word.length ? `${word[0].toUpperCase()}${word.slice(1)}` : word;
}

export function cloudEventLabel(title: string, keyword: string): string {
  const words = titleTokens(title);
  const keywordSet = new Set(titleTokens(keyword));
  const filtered = words.filter((w) => w.length > 2 && !keywordSet.has(w));
  const chosen = (filtered.length >= 2 ? filtered.slice(0, 2) : words.slice(0, 2)).map(capitalize);
  return chosen.join(' ');
}
