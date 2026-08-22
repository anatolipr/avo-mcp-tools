import { distance } from 'fastest-levenshtein';

export interface ChannelMatch {
  name: string;
  score: number;
}

/**
 * Splits a channel name into its underscore/hyphen-delimited words, e.g.
 * "pet_food_memory" -> ["pet", "food", "memory"]. Used so a query like
 * "pets" can match "pet_food_memory" via the shared word "pet" even though
 * the two full strings have a large edit distance overall.
 */
function words(name: string): string[] {
  return name.split(/[_-]+/).filter(Boolean);
}

/**
 * Typo-tolerance score for two strings of similar length/spelling — 1 for
 * identical, decreasing with edit distance relative to length. This is
 * deliberately NOT used to compare unrelated short words against each other
 * (see stemScore) — two coincidentally-similar-length words like "pets" and
 * "prefs" have a small edit distance purely by chance, which this alone
 * cannot tell apart from an actual typo of the same word.
 */
function typoScore(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - distance(a, b) / maxLen;
}

/**
 * Stem/prefix match score: how much of the shorter string is a literal
 * prefix of the longer one, e.g. "pet" is a full-length prefix of "pets" ->
 * strong match. Zero if neither is a prefix of the other at all — this is
 * an intentionally strict, high-precision signal (no edit-distance fuzz),
 * so it doesn't fire on coincidences the way typoScore can.
 */
function stemScore(a: string, b: string): number {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 3 || !longer.startsWith(shorter)) return 0;
  return shorter.length / longer.length;
}

/**
 * Per-word score: the best of a strict stem match (see stemScore) and a
 * typo-tolerant match that only kicks in when the query and word are close
 * enough in length that a real typo is plausible (within 2 characters) —
 * this catches "pests" -> "pets" (one transposed letter, same length).
 * Known limitation: two short, unrelated, similar-length words (e.g.
 * "pets" vs "prefs") can still score moderately via this path — there's no
 * algorithmic way to distinguish "typo of the same word" from "coincidence"
 * at that length. In practice this only surfaces as a low-ranked also-ran
 * behind any genuine stem match, and callers (see channel-tools.ts's
 * channel_find description) are told to disambiguate on close scores
 * rather than blindly trust the top result.
 */
function wordScore(query: string, word: string): number {
  const stem = stemScore(query, word);
  if (Math.abs(query.length - word.length) > 2) return stem;
  return Math.max(stem, typoScore(query, word));
}

/**
 * Scores one candidate channel name against a query, case-insensitively:
 * the best of (a) whole-string typo tolerance, (b) whole-string stem match,
 * and (c) the best per-word score against the candidate's underscore/
 * hyphen-split words (catches "pets" -> "pet_food_memory" via "pet", and
 * "pests" -> "pets_discussion" via a length-gated typo match on "pets").
 */
export function scoreChannelMatch(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const whole = Math.max(typoScore(q, c), stemScore(q, c));
  const perWord = words(c).map((w) => wordScore(q, w));
  return Math.max(whole, ...perWord, 0);
}

/**
 * Ranks every candidate against the query, highest score first, keeping
 * only matches above `minScore` (default 0.5).
 */
export function findChannelMatches(query: string, candidates: string[], minScore = 0.5): ChannelMatch[] {
  return candidates
    .map((name) => ({ name, score: scoreChannelMatch(query, name) }))
    .filter((m) => m.score >= minScore)
    .sort((a, b) => b.score - a.score);
}
