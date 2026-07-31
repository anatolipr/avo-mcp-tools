import { LitElement, html } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

export class HtmlOutputBlock extends LitElement {
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
