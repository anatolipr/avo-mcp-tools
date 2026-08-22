import { distance } from 'fastest-levenshtein';

export interface ChannelMatch {
  name: string;
  score: number;
}

/**
 * Mirrors mcp-tenant-lib's channel-search.ts — duplicated rather than
 * imported since this package has no other dependency on mcp-tenant-lib.
 * See that file for the full design rationale behind the stem/typo split.
 */

function words(name: string): string[] {
  return name.split(/[_-]+/).filter(Boolean);
}

function typoScore(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - distance(a, b) / maxLen;
}

function stemScore(a: string, b: string): number {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 3 || !longer.startsWith(shorter)) return 0;
  return shorter.length / longer.length;
}

function wordScore(query: string, word: string): number {
  const stem = stemScore(query, word);
  if (Math.abs(query.length - word.length) > 2) return stem;
  return Math.max(stem, typoScore(query, word));
}

export function scoreChannelMatch(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const whole = Math.max(typoScore(q, c), stemScore(q, c));
  const perWord = words(c).map((w) => wordScore(q, w));
  return Math.max(whole, ...perWord, 0);
}

export function findChannelMatches(query: string, candidates: string[], minScore = 0.5): ChannelMatch[] {
  return candidates
    .map((name) => ({ name, score: scoreChannelMatch(query, name) }))
    .filter((m) => m.score >= minScore)
    .sort((a, b) => b.score - a.score);
}
