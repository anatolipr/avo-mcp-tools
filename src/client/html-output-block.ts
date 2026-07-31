import { LitElement, html, css } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

export class HtmlOutputBlock extends LitElement {
  static styles = css`
    :host {
      display: block;
      color: var(--text-strong, #1a1a1a);
      font-family: inherit;
      font-size: 0.9rem;
    }
  `;

  static properties = {
    content: { type: String },
    scopedCss: { type: String, attribute: 'scoped-css' },
  };

  declare content: string;
  declare scopedCss: string;

  constructor() {
    super();
    this.content = '';
    this.scopedCss = '';
  }

  render() {
    return html`
      ${this.scopedCss ? html`<style>${unsafeHTML(this.scopedCss)}</style>` : ''}
      ${unsafeHTML(this.content)}
    `;
  }
}

customElements.define('html-output-block', HtmlOutputBlock);
