import { flattenPage } from './render.js';
import type { Page, Shape } from './types.js';

// A step marker takes the text of the nearest tag/text label within this
// many image pixels (labels usually sit right next to their marker).
const STEP_LABEL_DISTANCE = 240;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * A page's annotations as list items: step markers in number order, each
 * with its nearest tag/text label, then any labels not used by a step, in
 * the order they were added.
 */
function pageItems(shapes: Shape[]): { numbered: string[]; bullets: string[] } {
  const labels = shapes.filter((s) => (s.type === 'tag' || s.type === 'text') && s.label?.trim());
  const used = new Set<string>();
  const steps = shapes.filter((s) => s.type === 'step').sort((a, b) => (a.stepNumber ?? 0) - (b.stepNumber ?? 0));
  const numbered = steps.map((step) => {
    const c = step.points[0]!;
    let best: Shape | null = null;
    let bestD = STEP_LABEL_DISTANCE;
    for (const l of labels) {
      if (used.has(l.id)) continue;
      const p = l.points[0]!;
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d < bestD) {
        best = l;
        bestD = d;
      }
    }
    if (best) used.add(best.id);
    return best ? best.label!.trim().replace(/\s+/g, ' ') : `Step ${step.stepNumber ?? ''}`.trim();
  });
  const bullets = labels.filter((l) => !used.has(l.id)).map((l) => l.label!.trim().replace(/\s+/g, ' '));
  return { numbered, bullets };
}

/**
 * Builds the clipboard payload for "Copy as Markdown": Markdown text (each
 * page's title and annotations as lists), plus HTML with the same content and
 * the flattened page images inline, for editors that accept rich paste.
 * Speaker notes are left out; they are for the presenter.
 */
export async function pagesToMarkdown(pages: Page[], background: string | null): Promise<{ markdown: string; html: string }> {
  const withImages = pages.filter((p) => p.shapes.length > 0);
  const dpr = window.devicePixelRatio || 1;
  const md: string[] = [];
  const html: string[] = [];
  for (const [i, p] of withImages.entries()) {
    const title = p.title?.trim() || (withImages.length > 1 ? `Page ${i + 1}` : '');
    const { numbered, bullets } = pageItems(p.shapes);
    const { canvas } = await flattenPage(p.shapes, { background });
    if (title) {
      md.push(`## ${title}`, '');
      html.push(`<h2>${escapeHtml(title)}</h2>`);
    }
    html.push(`<p><img src="${canvas.toDataURL('image/png')}" width="${Math.round(canvas.width / dpr)}" alt="${escapeHtml(title || 'Screenshot')}"></p>`);
    if (numbered.length) {
      md.push(...numbered.map((t, k) => `${k + 1}. ${t}`), '');
      html.push(`<ol>${numbered.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ol>`);
    }
    if (bullets.length) {
      md.push(...bullets.map((t) => `- ${t}`), '');
      html.push(`<ul>${bullets.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`);
    }
  }
  return { markdown: md.join('\n').trim() + '\n', html: html.join('\n') };
}
