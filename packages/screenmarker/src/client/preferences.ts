const STORAGE_KEY = 'screenmarker_preferences';

export interface Preferences {
  color: string;
  lineWidth: number;
  fontSize: number;
  fill: boolean;
  // Fill outside the page image in exports: 'theme' (the editor background),
  // 'transparent', or a #rrggbb color.
  exportBackground: string;
  // Editor (and slide) background around the page: 'system' (white in light
  // mode, black in dark), 'theme' (the app's panel background), or #rrggbb.
  sceneBackground: string;
  // Blur emails, keys, and tokens found in every newly added picture (opt-in: it runs text recognition).
  autoRedact: boolean;
  // Arrow and line ends snap to text, tags, and pictures, and follow them when they move.
  snapArrows: boolean;
}

const DEFAULTS: Preferences = { color: '#ff3b30', lineWidth: 3, fontSize: 18, fill: false, exportBackground: 'theme', sceneBackground: 'system', autoRedact: false, snapArrows: true };

/**
 * Last-used tool defaults (color, line width, font size, fill), shared across all
 * tabs/sessions via localStorage — unlike document content, which is kept
 * per-tab in IndexedDB (see persistence.ts). These are small, synchronous
 * reads/writes: no need for the async open-a-database dance.
 */
export function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      color: typeof parsed.color === 'string' ? parsed.color : DEFAULTS.color,
      lineWidth: typeof parsed.lineWidth === 'number' ? parsed.lineWidth : DEFAULTS.lineWidth,
      fontSize: typeof parsed.fontSize === 'number' ? parsed.fontSize : DEFAULTS.fontSize,
      fill: typeof parsed.fill === 'boolean' ? parsed.fill : DEFAULTS.fill,
      exportBackground: typeof parsed.exportBackground === 'string' ? parsed.exportBackground : DEFAULTS.exportBackground,
      sceneBackground: typeof parsed.sceneBackground === 'string' ? parsed.sceneBackground : DEFAULTS.sceneBackground,
      autoRedact: typeof parsed.autoRedact === 'boolean' ? parsed.autoRedact : DEFAULTS.autoRedact,
      snapArrows: typeof parsed.snapArrows === 'boolean' ? parsed.snapArrows : DEFAULTS.snapArrows,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePreferences(prefs: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // best-effort — e.g. private browsing mode may throw on write
  }
}
