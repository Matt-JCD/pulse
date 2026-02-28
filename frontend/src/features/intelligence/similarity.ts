const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'to', 'with', 'will', 'after', 'amid',
  'this', 'these', 'those', 'over', 'under', 'its', 'their', 'than',
]);

function stemToken(token: string): string {
  if (token.length <= 4) return token;
  if (token.endsWith('ing')) return token.slice(0, -3);
  if (token.endsWith('ed')) return token.slice(0, -2);
  if (token.endsWith('es')) return token.slice(0, -2);
  if (token.endsWith('s')) return token.slice(0, -1);
  return token;
}

export function similarityTokenSet(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = normalized
    .split(' ')
    .map((token) => stemToken(token))
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));

  return new Set(tokens);
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  return intersection;
}

function normalizeForTextMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function charTrigrams(text: string): Set<string> {
  const compact = text.replace(/\s+/g, '');
  const grams = new Set<string>();
  if (compact.length < 3) return grams;
  for (let i = 0; i <= compact.length - 3; i++) {
    grams.add(compact.slice(i, i + 3));
  }
  return grams;
}

function trigramDice(a: string, b: string): number {
  const aTri = charTrigrams(a);
  const bTri = charTrigrams(b);
  if (aTri.size === 0 || bTri.size === 0) return 0;
  let overlap = 0;
  for (const g of aTri) {
    if (bTri.has(g)) overlap++;
  }
  return (2 * overlap) / (aTri.size + bTri.size);
}

export function isSimilarTopic(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;

  const intersection = intersectionSize(a, b);
  const union = a.size + b.size - intersection;
  const jaccard = union === 0 ? 0 : intersection / union;
  const containment = intersection / Math.min(a.size, b.size);

  if (intersection >= 3 && (jaccard >= 0.28 || containment >= 0.55)) return true;
  return intersection >= 2 && containment >= 0.72;
}

export function isSimilarTopicText(aText: string, bText: string): boolean {
  const a = normalizeForTextMatch(aText);
  const b = normalizeForTextMatch(bText);
  if (!a || !b) return false;

  if (a.length >= 24 && b.length >= 24 && (a.includes(b) || b.includes(a))) return true;
  return trigramDice(a, b) >= 0.72;
}
