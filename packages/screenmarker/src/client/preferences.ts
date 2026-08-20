const STORAGE_KEY = 'screenmarker_preferences';

export interface Preferences {
  color: string;
  lineWidth: number;
  fontSize: number;
}

const DEFAULTS: Preferences = { color: '#ff3b30', lineWidth: 3, fontSize: 18 };

/**
 * Last-used tool defaults (color, line width, font size), shared across all
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
