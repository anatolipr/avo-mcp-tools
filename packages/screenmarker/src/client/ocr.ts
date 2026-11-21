import type { Rect } from './types.js';

/**
 * On-device text recognition for "Find text in image" (Cmd/Ctrl+F).
 * Tesseract.js is several MB (worker + WASM core + English data), so it is
 * loaded from a pinned CDN build the first time someone searches, never as
 * part of the app bundle. Recognition runs in a Web Worker; nothing leaves
 * the browser except those library downloads.
 */
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js';

interface OcrWord {
  text: string;
  box: Rect;
}

/** One recognized line: its words, in reading order. */
export type OcrLine = OcrWord[];

interface TesseractBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface TesseractWorker {
  recognize(image: string): Promise<{ data: { lines?: { words: { text: string; bbox: TesseractBbox }[] }[] } }>;
}

let workerPromise: Promise<TesseractWorker> | null = null;
const cache = new Map<string, Promise<OcrLine[]>>();

function getWorker(): Promise<TesseractWorker> {
  workerPromise ??= (async () => {
    const mod = await import(/* @vite-ignore */ TESSERACT_URL);
    const createWorker = mod.createWorker ?? mod.default?.createWorker;
    return createWorker('eng') as Promise<TesseractWorker>;
  })();
  // A failed load (offline, blocked CDN) can be retried by the next search.
  workerPromise.catch(() => (workerPromise = null));
  return workerPromise;
}

/** Recognized lines of an image (data URL), cached per image. */
export function recognizeLines(imageDataUrl: string): Promise<OcrLine[]> {
  let p = cache.get(imageDataUrl);
  if (!p) {
    p = (async () => {
      const worker = await getWorker();
      const { data } = await worker.recognize(imageDataUrl);
      return (data.lines ?? []).map((line) =>
        line.words
          .filter((w) => w.text.trim())
          .map((w) => ({
            text: w.text,
            box: { x: w.bbox.x0, y: w.bbox.y0, w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0 },
          }))
      );
    })();
    cache.set(imageDataUrl, p);
    p.catch(() => cache.delete(imageDataUrl));
  }
  return p;
}

// What looks like a secret in one recognized word: an email address, a
// well-known key/token prefix, a JWT, or a long run mixing letters and digits.
const SECRET_PATTERNS = [
  /[\w.+-]+@[\w-]+(\.[\w-]+)+/,
  /\b(sk|pk|rk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{12,}/,
  /\b(ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs])[-_][A-Za-z0-9_-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
];

function looksSecret(word: string): boolean {
  if (SECRET_PATTERNS.some((re) => re.test(word))) return true;
  // A long token of letters and digits (and - _ / + =) with both kinds in it: an API key, a hash, a session id.
  const t = word.replace(/^[^\w]+|[^\w=]+$/g, '');
  return t.length >= 24 && /^[A-Za-z0-9_\-/+=]+$/.test(t) && /[0-9]/.test(t) && /[A-Za-z]/.test(t);
}

/** Boxes of the words that look like secrets (emails, API keys, tokens), for "Redact secrets". */
export function findSecrets(lines: OcrLine[]): Rect[] {
  return lines.flatMap((words) => words.filter((w) => looksSecret(w.text)).map((w) => w.box));
}

/**
 * Boxes of every case-insensitive occurrence of `query` in the lines. A
 * match may span several words of one line; its box covers those words
 * (whole words, since Tesseract gives no per-letter boxes).
 */
export function findText(lines: OcrLine[], query: string): Rect[] {
  const q = query.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!q) return [];
  const hits: Rect[] = [];
  for (const words of lines) {
    let text = '';
    const spans: { start: number; end: number }[] = [];
    for (const w of words) {
      if (text) text += ' ';
      spans.push({ start: text.length, end: text.length + w.text.length });
      text += w.text;
    }
    const lower = text.toLowerCase();
    for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, at + 1)) {
      const end = at + q.length;
      const covered = words.filter((_, i) => spans[i]!.start < end && spans[i]!.end > at);
      if (!covered.length) continue;
      const x1 = Math.min(...covered.map((w) => w.box.x));
      const y1 = Math.min(...covered.map((w) => w.box.y));
      const x2 = Math.max(...covered.map((w) => w.box.x + w.box.w));
      const y2 = Math.max(...covered.map((w) => w.box.y + w.box.h));
      hits.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    }
  }
  return hits;
}
