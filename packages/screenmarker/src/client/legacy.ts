import type { Page, Shape } from './types.js';

/** A page as older versions saved it: one page image under the shapes, with the shapes in its pixels. */
type LegacyPage = Page & { imageDataUrl?: string | null };

let counter = 0;

/**
 * Older documents kept each page's screenshot apart from its shapes, as the
 * page's coordinate origin. Now every image is a `picture` shape; this turns
 * a legacy page image into a picture at (0, 0), at its own size, under
 * everything else — so the shapes, already in its pixels, stay where they
 * were. Pages without one come back unchanged.
 */
export async function upgradePages(pages: Page[]): Promise<Page[]> {
  return Promise.all(
    (pages as LegacyPage[]).map(async (p) => {
      if (!('imageDataUrl' in p)) return p;
      const { imageDataUrl, ...rest } = p;
      if (!imageDataUrl) return rest;
      let w = 0;
      let h = 0;
      try {
        const img = new Image();
        img.src = imageDataUrl;
        await img.decode();
        w = img.naturalWidth;
        h = img.naturalHeight;
      } catch {
        // Undecodable: keep it as an empty picture box rather than dropping data.
      }
      const picture: Shape = {
        id: `legacy-${Date.now().toString(36)}-${(counter++).toString(36)}`,
        type: 'picture',
        color: '#000000',
        lineWidth: 0,
        points: [
          { x: 0, y: 0 },
          { x: w, y: h },
        ],
        src: imageDataUrl,
      };
      return { ...rest, shapes: [picture, ...rest.shapes] };
    })
  );
}
