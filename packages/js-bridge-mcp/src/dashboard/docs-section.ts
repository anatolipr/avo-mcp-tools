import { LitElement, html, css } from 'lit';
import { toast } from './toast.js';

// registerTool's DevTools-pasteable example, kept in sync BY HAND with the
// same literal example in tool-bus.js's own header comment and README.md's
// "Multiple entrypoints" section — three copies of a 3-line string is
// cheaper than hoisting a shared constant across a vanilla-JS IIFE file, a
// bundled Lit file, and a markdown doc, so this is a deliberate manual-sync
// choice, not an oversight. If you change one, change all three.
const REGISTER_TOOL_EXAMPLE = `window.__mcpToolBus.registerTool('save_current_note', () => window.myApp.save(), {
  description: 'Saves the currently open note',
});`;

/**
 * Human + LLM-facing documentation for the tool-bus's live/ad-hoc
 * registration primitives, mounted below the channel list in
 * dashboard-app.ts. Written for both audiences: a human reads this as
 * "here's how to register a tool at runtime"; an LLM reading it (e.g. a
 * human pasting this text into a conversation) reads the "coming later"
 * note as "do not assume a tool-mapper tool/UI exists yet — it doesn't."
 */
export class DocsSection extends LitElement {
  static styles = css`
    :host { display: block; margin-top: 32px; }
    h2 { font-size: 14px; margin: 0 0 8px; }
    p { font-size: 13px; opacity: 0.85; line-height: 1.5; margin: 0 0 10px; }
    pre {
      background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 8px;
      padding: 12px 14px; font-size: 12px; overflow-x: auto; margin: 0 0 10px;
    }
    .copy-btn {
      font-size: 11px; padding: 4px 10px; border-radius: 6px;
      border: 1px solid var(--border-strong); background: var(--bg); color: inherit; cursor: pointer;
    }
    .copy-btn:hover { background: var(--hover); border-color: var(--accent); }
    .future { font-size: 12px; opacity: 0.65; font-style: italic; margin-top: 14px; }
  `;

  async #copyExample() {
    try {
      await navigator.clipboard.writeText(REGISTER_TOOL_EXAMPLE);
      toast.success('Example copied');
    } catch {
      toast.danger('Could not copy to clipboard');
    }
  }

  render() {
    return html`
      <h2>Registering a tool at runtime</h2>
      <p>
        Any page bridged into a channel can register one ad-hoc tool at any point during an
        already-connected session — no source changes to the host page required. Paste this into
        that page's DevTools console (mapping <code>window.myApp.save</code> or any other global
        function you want to expose):
      </p>
      <pre>${REGISTER_TOOL_EXAMPLE}</pre>
      <button class="copy-btn" @click=${() => this.#copyExample()}>Copy example</button>
      <p class="future">
        Coming later — a visual tool-mapper UI (browse <code>window.*</code> for candidate
        functions, map to a tool name via a click-through picker instead of hand-typing
        <code>registerTool</code> calls) is planned but not built yet. It will be its own
        separate, explicitly-triggered lazy load — nothing today auto-loads it, so don't assume it
        exists or try to invoke it.
      </p>
    `;
  }
}

customElements.define('docs-section', DocsSection);
