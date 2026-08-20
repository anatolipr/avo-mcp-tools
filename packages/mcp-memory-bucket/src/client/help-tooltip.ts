import { LitElement, html, css } from 'lit';

let _instanceCounter = 0;

export type HelpTooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

// One @position-try block per side (defined once in static styles below) plus the matching
// primary-position CSS declarations, keyed by placement so #primaryPositionStyle can pick the
// right primary and #fallbackNames can list the other three as fallbacks, in a fixed order.
const PRIMARY_POSITION: Record<HelpTooltipPlacement, string> = {
  top: 'top: auto; bottom: anchor(top); left: anchor(center); right: auto; translate: -50% 0; margin-top: 0; margin-bottom: 6px;',
  bottom: 'top: anchor(bottom); bottom: auto; left: anchor(center); right: auto; translate: -50% 0; margin-top: 6px; margin-bottom: 0;',
  left: 'top: anchor(center); bottom: auto; left: auto; right: anchor(left); translate: 0 -50%; margin-right: 6px;',
  right: 'top: anchor(center); bottom: auto; left: anchor(right); right: auto; translate: 0 -50%; margin-left: 6px;',
};

const ALL_PLACEMENTS: HelpTooltipPlacement[] = ['top', 'bottom', 'left', 'right'];

/**
 * Question-mark-in-circle icon that shows a hover tooltip with the given text — used next to
 * frontmatter field labels to explain what the field means. Built on the same Popover API + CSS
 * anchor positioning pattern as status-select.ts/tag-multiselect.ts (see the making-dropdowns
 * skill): top-layer promotion means it's never clipped by an ancestor's overflow, and
 * position-try-fallbacks flips to whichever other side actually has room if the preferred one
 * doesn't fit.
 *
 * `placement` picks the preferred side (default "top"); the other three sides are tried in turn
 * as fallbacks if that side doesn't fit the viewport.
 *
 * Hover-only (no click/focus toggle) since this is a passive explanation, not a menu: mouseenter
 * opens it, mouseleave closes it. popover="manual" because hover doesn't fit "auto" semantics
 * (light-dismiss is keyed to outside *clicks*, not pointer movement).
 */
export class HelpTooltip extends LitElement {
  static properties = {
    text: { attribute: false },
    placement: { attribute: false },
  };

  declare text: string;
  declare placement: HelpTooltipPlacement;

  #anchorName: string;
  #hideTimer: ReturnType<typeof setTimeout> | null = null;

  static styles = css`
    :host {
      display: inline-flex;
      position: relative;
      vertical-align: middle;
    }
    .icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      border: 1px solid var(--border-strong);
      background: transparent;
      color: inherit;
      opacity: 0.55;
      font-size: 10px;
      line-height: 1;
      cursor: help;
      padding: 0;
    }
    .icon:hover, .icon:focus-visible {
      opacity: 1;
      border-color: var(--accent);
      color: var(--accent);
    }

    .bubble {
      /* Primary position (top/bottom/left/right + translate + margin) and
         position-try-fallbacks are both set inline per-instance from the placement property —
         see PRIMARY_POSITION/#fallbackNames and the inline style in render() below. */
      position: fixed;
      inset: auto;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
      color: inherit;
      box-shadow: 0 6px 20px var(--shadow);
      padding: 6px 9px;
      max-width: 240px;
      width: max-content;
      font-size: 12px;
      line-height: 1.4;
      font-weight: 400;
      text-align: left;
    }
    .bubble[popover] { display: none; }
    .bubble:popover-open { display: block; }

    /* One @position-try block per side. Named per-side (not per-placement-order) so any
       placement's fallback list can reference the same four blocks in a different order. */
    @position-try --bubble-top {
      top: auto;
      bottom: anchor(top);
      left: anchor(center);
      right: auto;
      translate: -50% 0;
      margin: 0 0 6px;
    }
    @position-try --bubble-bottom {
      top: anchor(bottom);
      bottom: auto;
      left: anchor(center);
      right: auto;
      translate: -50% 0;
      margin: 6px 0 0;
    }
    @position-try --bubble-left {
      top: anchor(center);
      bottom: auto;
      left: auto;
      right: anchor(left);
      translate: 0 -50%;
      margin: 0 6px 0 0;
    }
    @position-try --bubble-right {
      top: anchor(center);
      bottom: auto;
      left: anchor(right);
      right: auto;
      translate: 0 -50%;
      margin: 0 0 0 6px;
    }
  `;

  constructor() {
    super();
    this.text = '';
    this.placement = 'top';
    // Per-instance anchor name — see making-dropdowns skill's "why per-instance names": a shared
    // anchor-name across many icons on one page (e.g. one per frontmatter field) hits the
    // Chromium bug where the popover computes a plausible rect but never paints/hit-tests.
    this.#anchorName = `--help-tooltip-${++_instanceCounter}`;
  }

  // The requested side first, then the other three (fixed relative order) as fallbacks for when
  // the preferred side doesn't fit the viewport.
  get #fallbackNames(): string {
    const rest = ALL_PLACEMENTS.filter((p) => p !== this.placement);
    return [this.placement, ...rest].map((p) => `--bubble-${p}`).join(', ');
  }

  disconnectedCallback() {
    if (this.#hideTimer) clearTimeout(this.#hideTimer);
    super.disconnectedCallback();
  }

  #show() {
    if (this.#hideTimer) {
      clearTimeout(this.#hideTimer);
      this.#hideTimer = null;
    }
    const bubble = this.renderRoot.querySelector('.bubble') as HTMLElement | null;
    if (bubble && !bubble.matches(':popover-open')) bubble.showPopover();
  }

  // Small delay so moving the pointer from the icon onto the bubble itself (e.g. to select its
  // text) doesn't immediately close it.
  #scheduleHide() {
    this.#hideTimer = setTimeout(() => {
      (this.renderRoot.querySelector('.bubble') as HTMLElement | null)?.hidePopover();
    }, 100);
  }

  render() {
    return html`
      <button
        type="button"
        class="icon"
        style=${`anchor-name: ${this.#anchorName}`}
        aria-describedby="bubble"
        @mouseenter=${() => this.#show()}
        @mouseleave=${() => this.#scheduleHide()}
        @focus=${() => this.#show()}
        @blur=${() => this.#scheduleHide()}
      >?</button>
      <div
        id="bubble"
        role="tooltip"
        class="bubble"
        popover="manual"
        style=${`position-anchor: ${this.#anchorName}; position-try-fallbacks: ${this.#fallbackNames}; ${PRIMARY_POSITION[this.placement]}`}
        @mouseenter=${() => this.#show()}
        @mouseleave=${() => this.#scheduleHide()}
      >
        ${this.text}
      </div>
    `;
  }
}

customElements.define('help-tooltip', HelpTooltip);
