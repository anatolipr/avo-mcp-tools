export interface Chunk {
  ord: number;
  /** Enclosing headings joined with " › ", outermost first — '' for text above the first heading. */
  heading: string;
  text: string;
}

/** Upper bound per chunk — sized so heading + context + text stays inside a small embedding model's 512-token window. */
export const MAX_CHUNK_CHARS = 1400;
/** Sections shorter than this fold into the chunk before them rather than standing alone as a near-empty hit. */
const MIN_CHUNK_CHARS = 200;

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

interface Section {
  level: number;
  title: string;
  path: string;
  lines: string[];
}

/**
 * Splits a markdown body into retrieval-sized chunks along its heading structure, so a search hit
 * can return the one relevant section instead of the whole document. Fenced code blocks are never
 * split on a `#` line inside them, and an oversized section is cut at paragraph boundaries (never
 * mid-fence) rather than at an arbitrary character offset.
 */
export function chunkMarkdown(body: string): Chunk[] {
  const sections: Section[] = [{ level: 0, title: '', path: '', lines: [] }];
  const stack: Array<{ level: number; title: string }> = [];
  let fence: string | null = null;

  for (const line of body.split(/\r?\n/)) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1]!;
      else if (fenceMatch[1] === fence) fence = null;
    }
    const heading = fence ? null : HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title: heading[2]! });
      sections.push({ level, title: heading[2]!, path: stack.map((s) => s.title).join(' › '), lines: [] });
    } else {
      sections[sections.length - 1]!.lines.push(line);
    }
  }

  const chunks: Array<Omit<Chunk, 'ord'>> = [];
  for (const section of sections) {
    const text = section.lines.join('\n').trim();
    if (!text) continue;
    const previous = chunks[chunks.length - 1];
    if (previous && text.length < MIN_CHUNK_CHARS && previous.text.length + text.length <= MAX_CHUNK_CHARS) {
      // Keep the folded section's own heading inline — its text no longer has a heading path of its own.
      previous.text += `\n\n${'#'.repeat(section.level)} ${section.title}\n${text}`;
      continue;
    }
    for (const piece of splitOversized(text)) chunks.push({ heading: section.path, text: piece });
  }
  return chunks.map((chunk, ord) => ({ ord, ...chunk }));
}

/** Greedily packs paragraphs up to MAX_CHUNK_CHARS; a single paragraph over the limit is cut by lines. */
function splitOversized(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const pieces: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim()) pieces.push(current.trim());
    current = '';
  };
  for (const paragraph of splitParagraphs(text)) {
    if (paragraph.length > MAX_CHUNK_CHARS) {
      flush();
      for (const line of paragraph.split('\n')) {
        if (current.length + line.length + 1 > MAX_CHUNK_CHARS) flush();
        // A single line longer than the limit (minified JSON, a long URL list) still has to be cut somewhere.
        for (let i = 0; i < line.length; i += MAX_CHUNK_CHARS) {
          current += (current ? '\n' : '') + line.slice(i, i + MAX_CHUNK_CHARS);
          if (line.length > MAX_CHUNK_CHARS) flush();
        }
      }
      flush();
      continue;
    }
    if (current.length + paragraph.length + 2 > MAX_CHUNK_CHARS) flush();
    current += (current ? '\n\n' : '') + paragraph;
  }
  flush();
  return pieces;
}

/** Blank-line-separated paragraphs, treating a fenced code block (blank lines included) as one paragraph. */
function splitParagraphs(text: string): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1]!;
      else if (fenceMatch[1] === fence) fence = null;
    }
    if (!fence && line.trim() === '') {
      if (current.length > 0) paragraphs.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current.join('\n'));
  return paragraphs;
}
