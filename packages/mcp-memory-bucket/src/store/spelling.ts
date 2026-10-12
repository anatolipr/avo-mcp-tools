import type Database from 'better-sqlite3';
import { distance } from 'fastest-levenshtein';
import { getChunksVersion } from './chunks.js';

let vocabulary: { version: number; db: Database.Database; terms: Array<{ term: string; docs: number }>; known: Set<string> } | undefined;

/** Every distinct (unstemmed) word in the corpus with how many chunks contain it — from term_vocab, reloaded when chunks change. */
function loadVocabulary(db: Database.Database) {
  const version = getChunksVersion();
  if (!vocabulary || vocabulary.version !== version || vocabulary.db !== db) {
    const terms = db.prepare(`SELECT term, doc AS docs FROM term_vocab`).all() as Array<{ term: string; docs: number }>;
    vocabulary = { version, db, terms, known: new Set(terms.map((t) => t.term)) };
  }
  return vocabulary;
}

/**
 * The corpus word a misspelled query word most likely meant, or undefined when the word is fine
 * (it, or a stemmed form of it, occurs somewhere) or nothing is close enough. Short words and
 * anything with a digit are left alone — an edit away from a 3-letter word or a ticket number is
 * usually a different word, not a typo. Ties go to the word found in more chunks.
 */
export function suggestCorrection(db: Database.Database, word: string): string | undefined {
  const lower = word.toLowerCase();
  if (lower.length < 4 || !/^\p{L}+$/u.test(lower)) return undefined;
  const { terms, known } = loadVocabulary(db);
  if (known.has(lower)) return undefined;
  // Not in the unstemmed vocabulary, but the porter-stemmed indexes may still match it ("deploying" → "deploy").
  const phrase = `"${lower}"`;
  if (db.prepare(`SELECT 1 FROM chunk_fts WHERE chunk_fts MATCH ? LIMIT 1`).get(phrase)) return undefined;
  if (db.prepare(`SELECT 1 FROM search_index WHERE search_index MATCH ? LIMIT 1`).get(phrase)) return undefined;

  const maxDistance = lower.length <= 5 ? 1 : 2;
  let best: { term: string; docs: number; distance: number } | undefined;
  for (const { term, docs } of terms) {
    if (Math.abs(term.length - lower.length) > maxDistance) continue;
    const d = distance(lower, term);
    if (d > maxDistance) continue;
    if (!best || d < best.distance || (d === best.distance && docs > best.docs)) best = { term, docs, distance: d };
  }
  return best?.term;
}

/** Misspelled word → correction, for each of `words` that has one. */
export function correctWords(db: Database.Database, words: string[]): Map<string, string> {
  const corrections = new Map<string, string>();
  for (const word of words) {
    const correction = suggestCorrection(db, word);
    if (correction) corrections.set(word, correction);
  }
  return corrections;
}
