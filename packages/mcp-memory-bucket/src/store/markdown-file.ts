import fs from 'node:fs';
import matter from 'gray-matter';

export interface ParsedMarkdownFile<TFrontmatter> {
  frontmatter: TFrontmatter;
  body: string;
  mtimeMs: number;
}

export function readMarkdownFile<TFrontmatter>(filePath: string): ParsedMarkdownFile<TFrontmatter> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = matter(raw);
  const stat = fs.statSync(filePath);
  return {
    frontmatter: parsed.data as TFrontmatter,
    body: parsed.content.trim(),
    mtimeMs: stat.mtimeMs,
  };
}

/**
 * Pure formatting step of writeMarkdownFile, split out so a caller can compute the exact bytes a
 * doc/skill write would produce WITHOUT touching disk — needed to push that same content to a
 * remote (folderfoo-backed) folder before writing locally, per the "remote is the source of truth"
 * ordering (see remote/write-order.ts): the remote call must go first, so it can't read the
 * content back off a local file that doesn't exist yet.
 */
export function formatMarkdownFile(frontmatter: Record<string, unknown>, body: string): string {
  // js-yaml throws on `undefined` values rather than omitting them, so strip
  // optional-but-unset fields (e.g. skill license/compatibility) before dump.
  const cleaned = Object.fromEntries(Object.entries(frontmatter).filter(([, v]) => v !== undefined));
  return matter.stringify(`${body}\n`, cleaned);
}

export function writeMarkdownFile(filePath: string, frontmatter: Record<string, unknown>, body: string): void {
  fs.writeFileSync(filePath, formatMarkdownFile(frontmatter, body), 'utf-8');
}
