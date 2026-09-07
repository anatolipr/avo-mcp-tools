import { LitElement, html, css } from 'lit';
import { toast } from './toast.js';
import type { DashboardPendingApproval } from './types.js';

/**
 * Renders one popup per pending register_page_tool_by_code approval
 * request, across ALL channels (not scoped to one connection/channel row —
 * an agent could be requesting approval on any channel, so this always
 * shows regardless of scroll position). `approvals` is passed down as
 * {channel, approval} pairs by dashboard-app.ts, which flattens its
 * per-channel pendingApprovals arrays from the SSE snapshot.
 *
 * This is the ONLY place a register_page_tool_by_code request is approved
 * or declined — the bridged page itself never shows its own confirmation
 * for this (see js-bridge-mcp's main.ts, and manifest-tools.ts's
 * register_page_tool_by_code handler for the server-side requestApproval/
 * resolveApproval flow this posts back into).
 */
export class ApprovalPopup extends LitElement {
  static styles = css`
    :host { display: block; }
    .backdrop {
      position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); z-index: 2000;
      display: flex; align-items: center; justify-content: center;
    }
    .popup {
      background: var(--bg); border: 1px solid var(--border-strong); border-radius: 10px;
      width: min(560px, 92vw); max-height: 85vh; display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 20px 60px var(--shadow);
    }
    .popup-header {
      padding: 14px 18px; border-bottom: 1px solid var(--border);
      font-size: 13px; font-weight: 700;
    }
    .popup-body { overflow-y: auto; padding: 14px 18px; flex: 1; }
    .field { font-size: 12px; margin-bottom: 10px; }
    .field .label { opacity: 0.6; margin-bottom: 3px; }
    .field .value { font-family: ui-monospace, monospace; }
    pre {
      background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 8px;
      padding: 10px 12px; font-size: 12px; overflow-x: auto; margin: 0; white-space: pre-wrap; word-break: break-word;
    }
    .actions { display: flex; gap: 10px; padding: 12px 18px; border-top: 1px solid var(--border); justify-content: flex-end; }
    .btn { font-size: 12px; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--border-strong); cursor: pointer; }
    .btn.decline { background: var(--bg); color: inherit; }
    .btn.decline:hover { background: var(--hover); }
    .btn.approve { background: var(--accent); color: var(--accent-fg, #fff); border-color: var(--accent); }
    .btn.approve:hover { opacity: 0.9; }
  `;

  approvals: { channel: string; approval: DashboardPendingApproval }[] = [];

  async #respond(channel: string, approvalId: string, approved: boolean) {
    try {
      const res = await fetch(`/api/dashboard/channels/${encodeURIComponent(channel)}/approvals/${encodeURIComponent(approvalId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error('This request is no longer pending (it may have already timed out).');
      toast[approved ? 'success' : 'default'](approved ? 'Registration approved' : 'Registration declined');
    } catch (err) {
      toast.danger((err as Error).message);
    }
  }

  render() {
    if (this.approvals.length === 0) return html``;
    // Show one at a time, oldest first — a second/third pending approval
    // (rare: would need multiple in-flight register_page_tool_by_code
    // calls at once) just queues behind the first, same UX as a normal
    // modal stack.
    const { channel, approval } = this.approvals[0]!;
    return html`
      <div class="backdrop">
        <div class="popup">
          <div class="popup-header">New tool registration requires your approval</div>
          <div class="popup-body">
            <div class="field">
              <div class="label">Channel</div>
              <div class="value">${channel}</div>
            </div>
            <div class="field">
              <div class="label">Tool name</div>
              <div class="value">${approval.name}</div>
            </div>
            <div class="field">
              <div class="label">Description</div>
              <div class="value">${approval.description}</div>
            </div>
            <div class="field">
              <div class="label">Code</div>
              <pre>${approval.code}</pre>
            </div>
          </div>
          <div class="actions">
            <button class="btn decline" @click=${() => this.#respond(channel, approval.id, false)}>Decline</button>
            <button class="btn approve" @click=${() => this.#respond(channel, approval.id, true)}>Approve</button>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('approval-popup', ApprovalPopup);
