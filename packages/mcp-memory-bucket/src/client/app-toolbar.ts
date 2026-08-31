import { LitElement, html, css } from 'lit';

type ThemeMode = 'system' | 'light' | 'dark';

const THEME_ICON: Record<ThemeMode, string> = { system: '◐', light: '☀', dark: '☾' };
const THEME_LABEL: Record<ThemeMode, string> = { system: 'Auto', light: 'Light', dark: 'Dark' };

/**
 * The top-right button row (reindex, Channels, Folder View, theme, folderfoo profile circle).
 * Deliberately its own component with an explicit font reset on :host — mounting the SAME buttons
 * inside different parent layouts (the flat Filters view's .toolbar-bar vs folder-view.ts's
 * .mode-row) by slotting/relocating light-DOM markup let font-size drift depending on where the
 * markup ended up in the page, since font properties are inherited from actual DOM ancestry, not
 * from the shadow root that defined the class rule. A standalone element with its own `:host` font
 * declaration renders identically no matter which parent embeds it — no inheritance to fight.
 */
export class AppToolbar extends LitElement {
  static properties = {
    showReindex: { attribute: false },
    reindexing: { attribute: false },
    channelsActive: { attribute: false },
    folderViewActive: { attribute: false },
    showShared: { attribute: false },
    sharedActive: { attribute: false },
    theme: { attribute: false },
    onReindex: { attribute: false },
    onToggleChannels: { attribute: false },
    onToggleFolderView: { attribute: false },
    onToggleShared: { attribute: false },
    onCycleTheme: { attribute: false },
  };

  declare showReindex: boolean;
  declare reindexing: boolean;
  declare channelsActive: boolean;
  declare folderViewActive: boolean;
  declare showShared: boolean;
  declare sharedActive: boolean;
  declare theme: ThemeMode;
  declare onReindex: () => void;
  declare onToggleChannels: () => void;
  declare onToggleFolderView: () => void;
  declare onToggleShared: () => void;
  declare onCycleTheme: () => void;

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
      font-family: system-ui, sans-serif;
      font-size: 13px;
      line-height: normal;
      color: inherit;
    }
    .theme-toggle, .reindex-toggle {
      width: 28px;
      height: 28px;
      border: 1px solid var(--border-strong);
      border-radius: 50%;
      background: var(--bg);
      color: inherit;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.75;
      font-family: inherit;
    }
    .theme-toggle:hover, .reindex-toggle:hover { opacity: 1; background: var(--hover); }
    .folderfoo-slot { display: contents; }
    .reindex-toggle:disabled { cursor: default; opacity: 0.4; }
    .reindex-toggle.spinning { animation: reindex-spin 0.8s linear infinite; }
    @keyframes reindex-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .channels-toggle, .folder-view-toggle, .shared-toggle {
      height: 28px;
      padding: 0 12px;
      border: 1px solid var(--border-strong);
      border-radius: 14px;
      background: var(--bg);
      color: inherit;
      cursor: pointer;
      font-size: 12px;
      line-height: 1;
      display: flex;
      align-items: center;
      gap: 5px;
      opacity: 0.75;
      font-family: inherit;
    }
    .channels-toggle:hover, .folder-view-toggle:hover, .shared-toggle:hover { opacity: 1; background: var(--hover); }
    .channels-toggle.active, .folder-view-toggle.active, .shared-toggle.active {
      background: var(--accent); border-color: var(--accent); color: var(--accent-fg); opacity: 1;
    }
  `;

  #renderReindexToggle() {
    return html`
      <button
        class=${`reindex-toggle${this.reindexing ? ' spinning' : ''}`}
        title=${this.reindexing ? 'Reindexing…' : 'Rebuild cache from disk'}
        aria-label="Rebuild cache from disk"
        ?disabled=${this.reindexing}
        @click=${() => this.onReindex()}
      >
        ♻
      </button>
    `;
  }

  render() {
    return html`
      ${this.showReindex ? this.#renderReindexToggle() : ''}
      <button
        class="channels-toggle ${this.channelsActive ? 'active' : ''}"
        title="Live memory channels"
        @click=${() => this.onToggleChannels()}
      >
        ⛓ Channels
      </button>
      <button
        class="folder-view-toggle ${this.folderViewActive ? 'active' : ''}"
        title="Browse by folder"
        @click=${() => this.onToggleFolderView()}
      >
        🗂 Folder View
      </button>
      ${this.showShared
        ? html`
            <button
              class="shared-toggle ${this.sharedActive ? 'active' : ''}"
              title="Items shared with you"
              @click=${() => this.onToggleShared()}
            >
              🤝 Shared
            </button>
          `
        : ''}
      <button
        class="theme-toggle"
        title=${`Theme: ${THEME_LABEL[this.theme]} (click to change)`}
        aria-label="Toggle color theme"
        @click=${() => this.onCycleTheme()}
      >
        ${THEME_ICON[this.theme]}
      </button>
      <div class="folderfoo-slot"></div>
    `;
  }
}

customElements.define('app-toolbar', AppToolbar);
