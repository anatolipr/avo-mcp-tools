import { Signal } from 'avosignals';
import { connectMcpBridge, registerProvider } from 'js-bridge-mcp/client';
import type { AnnotatorStore } from './store.js';
import { makeId } from './store.js';
import { flattenPage, shapeBounds } from './render.js';
import { listDrafts } from './persistence.js';
import type { Page, Shape, ShapeType } from './types.js';

/**
 * Exposes the open screenmarker document to an LLM through a locally
 * running js-bridge-mcp (`npx js-bridge-mcp`): tools to read pages (as data
 * and as images) and to annotate them. Tools appear in MCP clients as
 * `screenmarker__<tool>`. Edits go through the normal store, so they show
 * up live, autosave, and can be undone.
 *
 * The site is public, so it never probes localhost for every visitor: it
 * connects on load only when served from localhost (npx screenmarker) or
 * after the user connected once with the 🔌 MCP button.
 */

export type McpState = 'disconnected' | 'connecting' | 'connected';
export const $mcpState = new Signal<McpState>('disconnected');
export const $mcpChannel = new Signal<string>('screenmarker');

/** What the editor provides to the tools (things that also move the camera, re-render, etc.). */
export interface McpHost {
  store: AnnotatorStore;
  documentName(): string;
  switchPage(id: string): Promise<void>;
  addPage(): Promise<void>;
  openDraft(id: string): Promise<void>;
  newDocument(): void;
}

const ANNOTATION_TYPES: ShapeType[] = ['rect', 'ellipse', 'arrow', 'line', 'text', 'tag', 'step', 'pen', 'highlight', 'blur', 'magnifier'];
const TWO_POINTS: ShapeType[] = ['rect', 'ellipse', 'arrow', 'line', 'highlight', 'blur', 'magnifier'];
const EDITABLE_FIELDS = ['points', 'label', 'color', 'lineWidth', 'fontSize', 'fill', 'tagArrow', 'stepNumber', 'textStyle', 'width', 'height'] as const;

function pageAt(host: McpHost, page: number | undefined): Page {
  const pages = host.store.pages.value;
  if (page === undefined || page === null) return host.store.activePage;
  const p = pages[page - 1];
  if (!p) throw new Error(`no page ${page}: the document has pages 1–${pages.length}`);
  return p;
}

/** Makes `page` the open one (the store edits the active page). */
async function openPage(host: McpHost, page: number | undefined): Promise<Page> {
  const p = pageAt(host, page);
  if (p.id !== host.store.activePageId.value) await host.switchPage(p.id);
  return host.store.activePage;
}

function pageNumber(host: McpHost, id: string): number {
  return host.store.pages.value.findIndex((p) => p.id === id) + 1;
}

/** A shape as an LLM should see it: no image data, rounded numbers. */
function describeShape(s: Shape): Record<string, unknown> {
  const { src, ends, ...rest } = s;
  const out: Record<string, unknown> = { ...rest, points: s.points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })) };
  if (s.type === 'picture') {
    const b = shapeBounds(s);
    out.image = `${Math.round(b.width)}×${Math.round(b.height)}`;
    void src;
  }
  if (ends) out.attachedTo = ends.map((e) => e?.id ?? null);
  return out;
}

function parseList(value: unknown, what: string): unknown[] {
  const v = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(v)) throw new Error(`${what} must be an array`);
  return v;
}

/** Validates an LLM-authored shape and fills in the editor's defaults. */
function toShape(host: McpHost, raw: unknown): Shape {
  const r = (raw ?? {}) as Partial<Shape>;
  if (!r.type || !ANNOTATION_TYPES.includes(r.type)) throw new Error(`type must be one of ${ANNOTATION_TYPES.join(', ')}`);
  const points = (r.points ?? []).map((p) => ({ x: Number(p.x), y: Number(p.y) }));
  if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('points must be {x, y} numbers');
  const need = TWO_POINTS.includes(r.type) ? 2 : r.type === 'pen' ? 2 : 1;
  if (points.length < need) throw new Error(`${r.type} needs ${need} point${need > 1 ? 's' : ''}`);
  const store = host.store;
  const shape: Shape = {
    id: makeId(),
    type: r.type,
    color: typeof r.color === 'string' ? r.color : store.activeColor.value,
    lineWidth: typeof r.lineWidth === 'number' ? r.lineWidth : store.activeLineWidth.value,
    points: r.type === 'pen' ? points : points.slice(0, need),
  };
  if (r.type === 'text' || r.type === 'tag' || r.type === 'step') shape.fontSize = typeof r.fontSize === 'number' ? r.fontSize : store.activeFontSize.value;
  if (r.type === 'text' || r.type === 'tag') {
    if (!r.label) throw new Error(`${r.type} needs a label`);
    shape.label = String(r.label);
    if (r.textStyle) shape.textStyle = r.textStyle;
  }
  if (r.type === 'text' && typeof r.width === 'number') shape.width = r.width;
  if (r.type === 'tag') shape.tagArrow = r.tagArrow ?? 'bottom-center';
  if (r.type === 'step') {
    const steps = store.activePage.shapes.filter((s) => s.type === 'step').map((s) => s.stepNumber ?? 0);
    shape.stepNumber = typeof r.stepNumber === 'number' ? r.stepNumber : steps.length ? Math.max(...steps) + 1 : 1;
  }
  if ((r.type === 'rect' || r.type === 'ellipse' || r.type === 'text') && r.fill !== undefined) shape.fill = !!r.fill;
  if (r.type === 'magnifier') {
    shape.lensRadius = typeof r.lensRadius === 'number' ? r.lensRadius : 80;
    shape.magnify = typeof r.magnify === 'number' ? r.magnify : 2;
  }
  return shape;
}

async function pageImage(page: Page, maxSide: number): Promise<{ data: string; mimeType: string; width: number; height: number; origin: { x: number; y: number } }> {
  const { canvas, origin } = await flattenPage(page.shapes, { background: '#ffffff' });
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(canvas.width * scale));
  out.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  const url = out.toDataURL('image/png');
  return { data: url.slice(url.indexOf(',') + 1), mimeType: 'image/png', width: canvas.width, height: canvas.height, origin };
}

const PAGE = { type: 'number', optional: true, description: 'Page number (1-based); default: the open page' } as const;

function tools(host: McpHost) {
  const store = host.store;
  return [
    {
      name: 'get_document',
      description:
        'Outline of the open screenmarker document: name, open page, and per page its number, title, speaker notes, shape counts, and the text of its labels/tags. ' +
        'Pages are screenshots (pictures) with annotations, or blank slides. Start here.',
      params: {},
      annotations: { readOnlyHint: true },
      fn: () => {
        const pages = store.pages.value;
        return {
          name: host.documentName(),
          openPage: pageNumber(host, store.activePageId.value),
          pages: pages.map((p, i) => {
            const counts: Record<string, number> = {};
            for (const s of p.shapes) counts[s.type] = (counts[s.type] ?? 0) + 1;
            return {
              page: i + 1,
              title: p.title ?? '',
              notes: p.notes ?? '',
              shapes: counts,
              text: p.shapes.filter((s) => s.label?.trim()).map((s) => s.label!.trim()),
            };
          }),
        };
      },
    },
    {
      name: 'get_page_image',
      description:
        'The page rendered as a PNG (pictures and annotations), to see what it shows. The text part gives the image size and the page coordinate of its top-left, for placing annotations.',
      params: { page: PAGE, maxSide: { type: 'number', optional: true, description: 'Longest side in pixels; default 1600' } },
      annotations: { readOnlyHint: true },
      fn: async ({ page, maxSide }: { page?: number; maxSide?: number }) => {
        const p = pageAt(host, page);
        if (!p.shapes.length) return `Page ${pageNumber(host, p.id)} is empty.`;
        const side = Math.max(200, Math.min(4000, maxSide ?? 1600));
        const img = await pageImage(p, side);
        const scale = Math.round(Math.min(1, side / Math.max(img.width, img.height)) * 1000) / 1000;
        return {
          content: [
            { type: 'image', data: img.data, mimeType: img.mimeType },
            {
              type: 'text',
              text: `Page ${pageNumber(host, p.id)}: ${img.width}×${img.height} page pixels, top-left at page (${-img.origin.x}, ${-img.origin.y}), shown at ${scale}× scale.`,
            },
          ],
        };
      },
    },
    {
      name: 'get_page_shapes',
      description: 'Every shape on a page with its id, type and page coordinates (pictures report their size, not their image data). Use the ids with update_shapes / delete_shapes.',
      params: { page: PAGE },
      annotations: { readOnlyHint: true },
      fn: ({ page }: { page?: number }) => {
        const p = pageAt(host, page);
        return { page: pageNumber(host, p.id), shapes: p.shapes.map(describeShape) };
      },
    },
    {
      name: 'add_shapes',
      description:
        'Adds annotations to a page (opens it). Coordinates are page pixels; a screenshot usually spans (0,0) to its size (see get_page_shapes). Each shape: ' +
        '{type, points:[{x,y}], color?:"#rrggbb", lineWidth?, label?, fontSize?, fill?, textStyle?, width?, tagArrow?, stepNumber?}. ' +
        'Types: rect/ellipse/highlight/blur (2 corners), arrow/line (from, to), magnifier (spot, lens center), pen (2+ points), ' +
        'text (top-left; label may be multi-line Markdown: **bold**, *italic*, # heading, - bullets; width wraps), ' +
        'tag (speech bubble; points[0] is the pointer tip; tagArrow: which side the pointer leaves, e.g. "bottom-center", "left-top", or "none"), step (numbered circle at the point). ' +
        'textStyle: {bold?, italic?, underline?, align?: left|center|right, font?: sans|serif|mono|hand}. Returns the new ids. One undo step.',
      params: { page: PAGE, shapes: { type: 'any', description: 'Array of shapes as above' } },
      fn: async ({ page, shapes }: { page?: number; shapes: unknown }) => {
        await openPage(host, page);
        const list = parseList(shapes, 'shapes').map((s) => toShape(host, s));
        store.addShapes(list);
        return { page: pageNumber(host, store.activePageId.value), ids: list.map((s) => s.id) };
      },
    },
    {
      name: 'update_shapes',
      description: `Changes shapes by id (opens the page): each item {id, ...fields} with fields from ${EDITABLE_FIELDS.join(', ')} (same meaning as in add_shapes). One undo step.`,
      params: { page: PAGE, updates: { type: 'any', description: 'Array of {id, ...fields}' } },
      fn: async ({ page, updates }: { page?: number; updates: unknown }) => {
        const p = await openPage(host, page);
        const byId = new Map(p.shapes.map((s) => [s.id, s]));
        const next = parseList(updates, 'updates').map((u) => {
          const { id, ...fields } = (u ?? {}) as Record<string, unknown>;
          const s = byId.get(String(id));
          if (!s) throw new Error(`no shape "${id}" on page ${pageNumber(host, p.id)}`);
          const merged: Shape = { ...s };
          for (const k of EDITABLE_FIELDS) if (k in fields) (merged as unknown as Record<string, unknown>)[k] = fields[k];
          return merged;
        });
        store.replaceShapes(next);
        return `updated ${next.length} shape(s)`;
      },
    },
    {
      name: 'delete_shapes',
      description: 'Deletes shapes by id (opens the page). Pictures are shapes too. One undo step.',
      params: { page: PAGE, ids: { type: 'array', items: { type: 'string' } } },
      annotations: { destructiveHint: true },
      fn: async ({ page, ids }: { page?: number; ids: string[] }) => {
        await openPage(host, page);
        store.deleteShapes(ids);
        return `deleted ${ids.length} shape(s)`;
      },
    },
    {
      name: 'set_page',
      description: 'Sets a page\'s slide title and/or speaker notes.',
      params: {
        page: PAGE,
        title: { type: 'string', optional: true },
        notes: { type: 'string', optional: true },
      },
      fn: ({ page, title, notes }: { page?: number; title?: string; notes?: string }) => {
        const p = pageAt(host, page);
        store.updatePageMeta(p.id, { ...(title !== undefined ? { title } : {}), ...(notes !== undefined ? { notes } : {}) });
        return 'ok';
      },
    },
    {
      name: 'add_page',
      description: 'Adds a blank page (a slide for text and shapes) at the end and opens it. Returns its number.',
      params: { title: { type: 'string', optional: true } },
      fn: async ({ title }: { title?: string }) => {
        await host.addPage();
        if (title) store.updatePageMeta(store.activePageId.value, { title });
        return { page: pageNumber(host, store.activePageId.value) };
      },
    },
    {
      name: 'go_to_page',
      description: 'Opens a page in the editor, so the user sees it.',
      params: { page: { type: 'number' } },
      fn: async ({ page }: { page: number }) => {
        await openPage(host, page);
        return 'ok';
      },
    },
    {
      name: 'list_drafts',
      description: 'Documents kept in this browser (drafts), most recent first: id, title, page count, last edit, and where else each is saved.',
      params: {},
      annotations: { readOnlyHint: true },
      fn: async () =>
        (await listDrafts()).map((d) => ({
          id: d.id,
          title: d.title,
          pages: d.pageCount,
          updated: new Date(d.updatedAt).toISOString(),
          open: d.id === store.draftId,
          cloud: d.cloudName ?? undefined,
          file: d.fileName ?? undefined,
        })),
    },
    {
      name: 'open_draft',
      description: 'Opens a draft from list_drafts in the editor (the current document stays in the drafts).',
      params: { id: { type: 'string' } },
      fn: async ({ id }: { id: string }) => {
        await host.openDraft(id);
        return get(host);
      },
    },
    {
      name: 'new_document',
      description: 'Starts a blank document (the current one stays in the drafts).',
      params: {},
      fn: () => {
        host.newDocument();
        return 'ok';
      },
    },
  ];
}

function get(host: McpHost) {
  return { name: host.documentName(), pages: host.store.pages.value.length };
}

let connector: ReturnType<typeof connectMcpBridge> | null = null;

const CHANNEL_KEY = 'screenmarker_mcp_channel';

/** Sets up the tools and the connection; connects now when that can't surprise anyone (see the module comment). */
export function setUpMcp(host: McpHost): void {
  connector = connectMcpBridge({
    appName: 'screenmarker',
    beforeConnect: async () => {
      await registerProvider('screenmarker', tools(host));
    },
    onStateChange: (state, channel) => {
      $mcpState.set(state);
      $mcpChannel.set(channel);
    },
  });
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  let connectedBefore = false;
  try {
    connectedBefore = !!localStorage.getItem(CHANNEL_KEY);
  } catch {
    // storage blocked: only connect on click
  }
  if (local || connectedBefore) void connector.init();
}

/** The 🔌 MCP button: connect, or (when connected) rename the connection. */
export function mcpConnectClick(): void {
  void connector?.handleConnectClick();
}
