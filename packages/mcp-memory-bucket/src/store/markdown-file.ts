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

export function writeMarkdownFile(filePath: string, frontmatter: Record<string, unknown>, body: string): void {
  // js-yaml throws on `undefined` values rather than omitting them, so strip
  // optional-but-unset fields (e.g. skill license/compatibility) before dump.
  const cleaned = Object.fromEntries(Object.entries(frontmatter).filter(([, v]) => v !== undefined));
  const content = matter.stringify(`${body}\n`, cleaned);
  fs.writeFileSync(filePath, content, 'utf-8');
}
