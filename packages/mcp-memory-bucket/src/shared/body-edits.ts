import { z } from 'zod';

/**
 * Search/replace patch format for editing a doc body without round-tripping the whole
 * thing through the model — same shape as Claude Code's own Edit tool (old_string/new_string).
 * Line-anchored diffs (unified diff, @@ hunk headers) are what this deliberately avoids:
 * weaker models reliably botch line numbers and context-line counts, and a rejected hunk
 * gives no partial credit. Exact-text search/replace has no offsets for the model to get
 * wrong, and the host enforces uniqueness so a bad match fails loudly with context instead
 * of silently patching the wrong spot.
 */
export const bodyEditSchema = z.object({
  find: z.string().min(1).describe('exact existing text to locate in the body — must match exactly once unless replace_all is set'),
  replace: z.string().describe('text to substitute in place of the match'),
  replace_all: z.boolean().optional().describe('replace every occurrence instead of requiring exactly one match (default: false)'),
});

export type BodyEdit = z.infer<typeof bodyEditSchema>;

/** One applied edit, reported back so a caller can render a diff without re-fetching the pre-edit body. */
export interface AppliedBodyEdit {
  find: string;
  replace: string;
  replace_all: boolean;
  occurrences: number;
}

export const bodyEditsSchema = z
  .array(bodyEditSchema)
  .min(1)
  .describe(
    'Alternative to `body`: apply one or more find/replace patches to the existing body instead of rewriting it wholesale. ' +
      'Applied in order against the current body. Each `find` must match exactly once unless `replace_all` is set. ' +
      'Cannot be combined with `body` in the same call.'
  );

/**
 * Applies find/replace edits to `body` in order, matching Claude Code's Edit tool semantics:
 * each `find` must appear exactly once unless `replace_all` is set, and a zero/ambiguous match
 * throws immediately (with surrounding context) rather than guessing — so the caller can retry
 * with a more specific `find` in the same turn instead of silently corrupting the doc.
 *
 * Also returns the applied edits (with occurrence counts) so a caller can render a diff of what
 * changed without having to re-fetch and diff the pre-edit body itself.
 */
export function applyBodyEdits(body: string, edits: BodyEdit[]): { body: string; applied: AppliedBodyEdit[] } {
  let result = body;
  const applied: AppliedBodyEdit[] = [];
  for (const [i, edit] of edits.entries()) {
    const { find, replace, replace_all } = edit;
    const occurrences = countOccurrences(result, find);

    if (occurrences === 0) {
      throw new Error(`body_edits[${i}]: find text not found in body: ${JSON.stringify(truncate(find))}`);
    }
    if (occurrences > 1 && !replace_all) {
      throw new Error(
        `body_edits[${i}]: find text matches ${occurrences} times in body — narrow it to a unique match, or set replace_all: true. Text: ${JSON.stringify(truncate(find))}`
      );
    }

    result = replace_all ? result.split(find).join(replace) : replaceFirst(result, find, replace);
    applied.push({ find, replace, replace_all: !!replace_all, occurrences });
  }
  return { body: result, applied };
}

/**
 * Renders applied edits as a compact per-edit diff (`-`/`+` lines, aider/Claude-Code-Edit-tool
 * style) so a calling agent can show the user what changed without re-fetching the old body.
 * Not a true unified diff (no line numbers/hunk headers) — deliberately, since this is for
 * human-readable display, not for feeding back into another patch tool.
 */
export function formatBodyEditsDiff(applied: AppliedBodyEdit[]): string {
  return applied
    .map((edit, i) => {
      const suffix = edit.occurrences > 1 ? ` (${edit.occurrences} occurrences replaced)` : '';
      const removed = edit.find
        .split('\n')
        .map((line) => `-${line}`)
        .join('\n');
      const added = edit.replace
        .split('\n')
        .map((line) => `+${line}`)
        .join('\n');
      return `--- edit ${i + 1}${suffix} ---\n${removed}\n${added}`;
    })
    .join('\n');
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle);
  return idx === -1 ? haystack : haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}

function truncate(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
