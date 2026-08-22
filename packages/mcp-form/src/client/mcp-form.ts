import { LitElement, html, css } from 'lit';
import { Signal, SignalWatcher } from 'avosignals';
import type { ServerMessage, ClientMessage } from 'mcp-tenant-lib';
import type { FieldDef, SubFieldDef, FormDef, FieldValues } from '../types.js';
import './html-output-block.js';

type FileStatus = 'idle' | 'uploading' | 'done' | 'error';
interface FileState {
  status: FileStatus;
  fileName: string;
}

export class McpForm extends LitElement {
  static styles = css`
    *, *::before, *::after { box-sizing: border-box; }

    :host {
      display: block;
      min-width: 0;
      width: 100%;

      --text-strong: #1a1a1a;
      --text-muted: #555;
      --text-faint: #888;
      --text-faint-2: #aaa;
      --border: #ddd;
      --border-soft: #e0e0e0;
      --border-softer: #ebebeb;
      --input-bg: #fff;
      --surface: #fafafa;
      --surface-hover: #f5f5f0;
      --chip-bg: #e0e0e0;
      --btn-bg: #1a1a1a;
      --btn-bg-hover: #333;
      --btn-text: #fff;
      --accent: #1a1a1a;
      --danger: #d32f2f;
      --danger-border: #f5c2c2;
      --danger-bg: #fffafa;
      --success: #4caf50;
      --success-bg: #f6fff6;
      --focus-border: #666;
      --dashed-border: #bbb;
    }

    @media (prefers-color-scheme: dark) {
      :host {
        --text-strong: #eee;
        --text-muted: #aaa;
        --text-faint: #888;
        --text-faint-2: #777;
        --border: #444;
        --border-soft: #3a3a3a;
        --border-softer: #333;
        --input-bg: #1c1d1f;
        --surface: #1e1f21;
        --surface-hover: #2a2b2d;
        --chip-bg: #3a3a3a;
        --btn-bg: #eee;
        --btn-bg-hover: #fff;
        --btn-text: #1a1a1a;
        --accent: #eee;
        --danger: #ef5350;
        --danger-border: #6b3333;
        --danger-bg: #2a1e1e;
        --success: #66bb6a;
        --success-bg: #1c2a1d;
        --focus-border: #999;
        --dashed-border: #555;
      }
    }

    .title {
      font-size: 1.1rem;
      font-weight: 600;
      color: var(--text-strong);
      margin: 0 0 1.5rem;
      line-height: 1.4;
    }

    .field { margin-bottom: 1.1rem; min-width: 0; width: 100%; box-sizing: border-box; }

    html-output-block { display: block; margin-bottom: 1.1rem; }

    label {
      display: block;
      font-size: 0.78rem;
      font-weight: 500;
      color: var(--text-muted);
      margin-bottom: 0.3rem;
      letter-spacing: 0.01em;
    }

    input[type="text"],
    input[type="number"],
    input[type="date"],
    input[type="datetime-local"],
    textarea,
    select {
      font-family: inherit;
      font-size: 0.95rem;
      padding: 0.5rem 0.7rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      width: 100%;
      outline: none;
      background: var(--input-bg);
      color: var(--text-strong);
      transition: border-color 0.15s;
    }
    input[type="text"]:focus,
    input[type="number"]:focus,
    input[type="date"]:focus,
    input[type="datetime-local"]:focus,
    textarea:focus,
    select:focus { border-color: var(--focus-border); }

    textarea { resize: vertical; min-height: 80px; }

    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 0.55rem;
      padding: 0.3rem 0;
    }
    .checkbox-row input[type="checkbox"] {
      width: 1.1rem;
      height: 1.1rem;
      margin: 0;
      cursor: pointer;
      accent-color: var(--accent);
      flex-shrink: 0;
    }
    .checkbox-row label {
      margin: 0;
      font-size: 0.9rem;
      font-weight: 400;
      color: var(--text-strong);
      cursor: pointer;
    }

    .radio-group {
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
      padding: 0.1rem 0;
    }
    .radio-row {
      display: flex;
      align-items: center;
      gap: 0.55rem;
    }
    .radio-row input[type="radio"] {
      width: 1rem;
      height: 1rem;
      margin: 0;
      cursor: pointer;
      accent-color: var(--accent);
      flex-shrink: 0;
    }
    .radio-row label {
      margin: 0;
      font-size: 0.9rem;
      font-weight: 400;
      color: var(--text-strong);
      cursor: pointer;
    }

    .range-wrap {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    input[type="range"] {
      flex: 1;
      accent-color: var(--accent);
      cursor: pointer;
    }
    .range-value {
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--text-strong);
      min-width: 2.5rem;
      text-align: right;
    }

    .multiselect-group {
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
      padding: 0.1rem 0;
    }
    .multiselect-row {
      display: flex;
      align-items: center;
      gap: 0.55rem;
    }
    .multiselect-row input[type="checkbox"] {
      width: 1rem;
      height: 1rem;
      margin: 0;
      cursor: pointer;
      accent-color: var(--accent);
      flex-shrink: 0;
    }
    .multiselect-row label {
      margin: 0;
      font-size: 0.9rem;
      font-weight: 400;
      color: var(--text-strong);
      cursor: pointer;
    }

    .list-rows {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      align-self: stretch;
      min-width: 0;
    }
    .list-card {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--border-soft);
      border-radius: 8px;
      background: var(--surface);
      min-width: 0;
    }
    .list-card__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.6rem 0.6rem 0.6rem 0.9rem;
      border-bottom: 1px solid var(--border-softer);
      min-height: 2.2rem;
    }
    .list-card__title {
      font-size: 0.72rem;
      font-weight: 600;
      color: var(--text-faint);
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .list-card__body {
      padding: 0.75rem 0.9rem;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .list-card .field:last-child { margin-bottom: 0; }
    .list-card__remove {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 1.5rem;
      height: 1.5rem;
      padding: 0;
      flex-shrink: 0;
      border-radius: 50%;
      font-size: 0.75rem;
      font-weight: 700;
      line-height: 1;
      background: var(--chip-bg);
      color: var(--text-muted);
      border: none;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .list-card__remove:hover:not(:disabled) { background: #e53e3e; color: #fff; }
    .list-card__remove:disabled { opacity: 0.35; cursor: not-allowed; }
    .list-add-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      background: transparent;
      border: 1.5px dashed var(--dashed-border);
      color: var(--text-muted);
      border-radius: 6px;
      padding: 0.4rem 0.85rem;
      font-size: 0.82rem;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: border-color 0.15s, color 0.15s, background 0.15s;
      width: 100%;
      justify-content: center;
    }
    .list-add-btn:hover:not(:disabled) { border-color: var(--text-faint); color: var(--text-strong); background: var(--surface-hover); }
    .list-add-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .color-wrap {
      display: flex;
      align-items: center;
      gap: 0.65rem;
    }
    input[type="color"] {
      width: 2.5rem;
      height: 2.5rem;
      padding: 0.15rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      background: var(--input-bg);
      flex-shrink: 0;
    }
    .color-hex {
      font-size: 0.9rem;
      font-family: monospace;
      color: var(--text-strong);
    }

    .file-drop {
      border: 2px dashed var(--border);
      border-radius: 8px;
      padding: 1.2rem 1rem;
      text-align: center;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
      position: relative;
    }
    .file-drop:hover:not(.file-drop--disabled) { border-color: var(--text-faint-2); background: var(--surface); }
    .file-drop--over { border-color: var(--accent); background: var(--surface-hover); }
    .file-drop--done { border-color: var(--success); background: var(--success-bg); cursor: default; }
    .file-drop--disabled { opacity: 0.5; cursor: not-allowed; }
    .file-drop input[type="file"] {
      position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%;
    }
    .file-drop--disabled input[type="file"] { pointer-events: none; }
    .file-drop__icon { font-size: 1.5rem; margin-bottom: 0.3rem; }
    .file-drop__prompt { font-size: 0.85rem; color: var(--text-muted); }
    .file-drop__name { font-size: 0.85rem; font-weight: 600; color: var(--text-strong); margin-top: 0.2rem; }
    .file-drop__uploading { font-size: 0.78rem; color: var(--text-faint-2); margin-top: 0.2rem; }

    .actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 1.5rem;
      gap: 1rem;
    }

    button {
      font-family: inherit;
      font-size: 0.9rem;
      font-weight: 600;
      padding: 0.55rem 1.4rem;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      background: var(--btn-bg);
      color: var(--btn-text);
      transition: opacity 0.15s, background 0.15s;
    }
    button:hover:not(:disabled) { background: var(--btn-bg-hover); }
    button:disabled { opacity: 0.4; cursor: not-allowed; }

    .btn-interrupt {
      background: transparent;
      border: 1.5px solid var(--dashed-border);
      color: var(--text-muted);
      font-size: 0.82rem;
      padding: 0.4rem 0.9rem;
    }
    .btn-interrupt:hover:not(:disabled) { border-color: var(--text-faint); color: var(--text-strong); background: var(--surface-hover); }

    .field-error {
      font-size: 0.75rem;
      color: var(--danger);
      margin-top: 0.25rem;
      font-weight: 500;
    }
    .input-error,
    .input-error:focus {
      border-color: var(--danger) !important;
    }
    .list-card.card-has-error {
      border-color: var(--danger-border);
      background: var(--danger-bg);
    }

    .submitted-note {
      font-size: 0.78rem;
      color: var(--success);
      font-weight: 500;
    }

    .status {
      font-size: 0.72rem;
      color: var(--text-faint-2);
    }
    .dot {
      display: inline-block;
      width: 7px; height: 7px;
      border-radius: 50%;
      margin-right: 4px;
      background: var(--chip-bg);
      vertical-align: middle;
    }
    .dot.live { background: var(--success); }
  `;

  static properties = {
    _title:     { state: true },
    _fields:    { state: true },
    _connected: { state: true },
    _submitted: { state: true },
    _waiting:   { state: true },
    _errors:    { state: true },
  };

  declare _title: string;
  declare _fields: FieldDef[];
  declare _connected: boolean;
  declare _submitted: boolean;
  declare _waiting: boolean;
  declare _errors: Record<string, string>;

  private _signals = new Map<string, Signal<string>>();
  private _fileState = new Map<string, FileState>();
  private _ws: WebSocket | undefined;

  constructor() {
    super();
    new SignalWatcher(this);
    this._title     = '';
    this._fields    = [];
    this._connected = false;
    this._submitted = false;
    this._waiting   = false;
    this._errors    = {};
    this._connect();
  }

  private _connect() {
    const tenantId = location.pathname.startsWith('/t/')
      ? location.pathname.slice('/t/'.length).split('/')[0]
      : '';
    const wsPath = tenantId ? `/ws?tenant=${encodeURIComponent(tenantId)}` : '/ws';
    const wsUrl = `ws://${location.host}${wsPath}`;
    console.log(`[mcp-ws] connecting: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);
    this._ws = ws;
    ws.onopen  = () => {
      console.log('[mcp-ws] connected');
      this._connected = true;
    };
    ws.onclose = (event) => {
      console.log(`[mcp-ws] disconnected: code=${event.code} reason=${event.reason || '(none)'} wasClean=${event.wasClean}`);
      this._connected = false;
      if (event.code === 4404) {
        console.log('[mcp-ws] tenant unknown/expired (4404) — not retrying');
        return;
      }
      // simple reconnect after 2 s
      console.log('[mcp-ws] retrying in 2s');
      setTimeout(() => this._connect(), 2000);
    };
    ws.onerror = () => {
      console.log('[mcp-ws] socket error (see close event for details)');
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as ServerMessage<FormDef, FieldValues>;
      if (msg.type === 'init' || msg.type === 'reinit') {
        this._applyFormDef(msg.schema, msg.state, msg.submitted);
        this._waiting = msg.waiting;
      }
      if (msg.type === 'update') {
        const signal = this._signals.get(msg.field);
        if (signal) signal.set(msg.value as string);
      }
      if (msg.type === 'waiting') {
        this._waiting = msg.waiting;
      }
    };
  }

  private _send(msg: ClientMessage) {
    this._ws?.send(JSON.stringify(msg));
  }

  private _applyFormDef(formDef: FormDef, state: FieldValues, submitted: boolean) {
    this._title    = formDef.title ?? '';
    this._fields   = formDef.fields;
    this._submitted = submitted;
    this._errors   = {};
    this._signals  = new Map();
    this._fileState = new Map(); // name -> { status: 'idle'|'uploading'|'done'|'error', fileName }
    for (const f of this._fields) {
      if (f.type === 'html_output') continue;
      const signal = new Signal(state[f.name] ?? f.default ?? '');
      this._signals.set(f.name, signal);
      if (f.type === 'file') this._fileState.set(f.name, { status: 'idle', fileName: '' });
    }
    this.requestUpdate();
  }

  private _onInput(name: string, value: string, errorKey?: string) {
    this._signals.get(name)?.set(value);
    this._send({ type: 'set', field: name, value });
    const key = errorKey ?? name;
    if (this._errors[key]) {
      const next = { ...this._errors };
      delete next[key];
      this._errors = next;
    }
  }

  private _validateField(f: FieldDef | SubFieldDef, value: string): string | null {
    if (f.required) {
      if (f.type === 'checkbox' && value !== 'true') return 'This field is required.';
      if (f.type === 'multiselect') {
        let arr: unknown;
        try { arr = JSON.parse(value || '[]'); } catch { arr = []; }
        if (!Array.isArray(arr) || !arr.length) return 'Please select at least one option.';
      } else if (!value || value.trim() === '') {
        return 'This field is required.';
      }
    }
    if (value && f.pattern) {
      try {
        if (!new RegExp(f.pattern).test(value))
          return f.patternMessage || 'Invalid format.';
      } catch { /* bad regex — skip */ }
    }
    if (value && (f.type === 'text' || f.type === 'textarea')) {
      if (f.minLength != null && value.length < f.minLength)
        return `Must be at least ${f.minLength} characters.`;
      if (f.maxLength != null && value.length > f.maxLength)
        return `Must be at most ${f.maxLength} characters.`;
    }
    if (value && f.type === 'number') {
      const num = Number(value);
      if (f.min != null && num < f.min) return `Must be at least ${f.min}.`;
      if (f.max != null && num > f.max) return `Must be at most ${f.max}.`;
    }
    return null;
  }

  private _validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    for (const f of this._fields) {
      if (f.type === 'html_output') continue;
      const value = this._signals.get(f.name)?.get() ?? '';
      if (f.type === 'list') {
        let rows: Record<string, string>[];
        try { rows = JSON.parse(value || '[]'); } catch { rows = []; }
        if (f.required && !rows.some((r) => Object.values(r).some((v) => v && v.trim?.() !== '')))
          errors[f.name] = 'Please add at least one entry.';
        for (let i = 0; i < rows.length; i++) {
          for (const sf of (f.fields ?? [])) {
            const sv = rows[i]?.[sf.name] ?? '';
            const msg = this._validateField(sf, sv);
            if (msg) errors[`${f.name}[${i}].${sf.name}`] = msg;
          }
        }
      } else {
        const msg = this._validateField(f, value);
        if (msg) errors[f.name] = msg;
      }
    }
    return errors;
  }

  private async _uploadFile(name: string, file: File) {
    this._fileState.set(name, { status: 'uploading', fileName: file.name });
    this.requestUpdate();

    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/upload', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { path } = await res.json();
      this._fileState.set(name, { status: 'done', fileName: file.name });
      this._onInput(name, path);
    } catch {
      this._fileState.set(name, { status: 'error', fileName: file.name });
    }
    this.requestUpdate();
  }

  private _onSubmit() {
    const errors = this._validate();
    if (Object.keys(errors).length) {
      this._errors = errors;
      return;
    }
    this._submitted = true;
    this._send({ type: 'submit' });
  }

  private _onInterrupt() {
    this._send({ type: 'interrupt' });
  }

  private _errorMsg(key: string) {
    const msg = this._errors[key];
    return msg ? html`<p class="field-error">${msg}</p>` : '';
  }

  private _renderField(f: FieldDef, errorKey?: string) {
    const eKey = errorKey ?? f.name;
    const err = this._errors[eKey];
    const value = this._signals.get(f.name)?.get() ?? '';
    const onInput = (e: Event) => this._onInput(f.name, (e.target as HTMLInputElement).value, eKey);

    switch (f.type) {
      case 'textarea':
        return html`
          <div class="field">
            <label for=${f.name}>${f.label}</label>
            <textarea
              id=${f.name}
              class=${err ? 'input-error' : ''}
              placeholder=${f.placeholder ?? ''}
              .value=${value}
              @input=${onInput}
              ?disabled=${this._submitted}
            ></textarea>
            ${this._errorMsg(eKey)}
          </div>`;

      case 'number':
        return html`
          <div class="field">
            <label for=${f.name}>${f.label}</label>
            <input
              type="number"
              id=${f.name}
              class=${err ? 'input-error' : ''}
              placeholder=${f.placeholder ?? ''}
              .value=${value}
              @input=${onInput}
              ?disabled=${this._submitted}
            />
            ${this._errorMsg(eKey)}
          </div>`;

      case 'select':
        return html`
          <div class="field">
            <label for=${f.name}>${f.label}</label>
            <select
              id=${f.name}
              class=${err ? 'input-error' : ''}
              .value=${value}
              @change=${onInput}
              ?disabled=${this._submitted}
            >
              <option value="">— choose —</option>
              ${(f.options ?? []).map(
                (o) => html`<option value=${o} ?selected=${value === o}>${o}</option>`
              )}
            </select>
            ${this._errorMsg(eKey)}
          </div>`;

      case 'checkbox': {
        const checked = value === 'true';
        return html`
          <div class="field">
            <div class="checkbox-row">
              <input
                type="checkbox"
                id=${f.name}
                .checked=${checked}
                @change=${(e: Event) => this._onInput(f.name, String((e.target as HTMLInputElement).checked), eKey)}
                ?disabled=${this._submitted}
              />
              <label for=${f.name}>${f.label}</label>
            </div>
            ${this._errorMsg(eKey)}
          </div>`;
      }

      case 'radio':
        return html`
          <div class="field">
            <label>${f.label}</label>
            <div class="radio-group">
              ${(f.options ?? []).map((o) => html`
                <div class="radio-row">
                  <input
                    type="radio"
                    id=${`${f.name}_${o}`}
                    name=${f.name}
                    value=${o}
                    .checked=${value === o}
                    @change=${() => this._onInput(f.name, o, eKey)}
                    ?disabled=${this._submitted}
                  />
                  <label for=${`${f.name}_${o}`}>${o}</label>
                </div>
              `)}
            </div>
            ${this._errorMsg(eKey)}
          </div>`;

      case 'date':
        return html`
          <div class="field">
            <label for=${f.name}>${f.label}</label>
            <input
              type="date"
              id=${f.name}
              class=${err ? 'input-error' : ''}
              .value=${value}
              @change=${onInput}
              ?disabled=${this._submitted}
            />
            ${this._errorMsg(eKey)}
          </div>`;

      case 'datetime':
        return html`
          <div class="field">
            <label for=${f.name}>${f.label}</label>
            <input
              type="datetime-local"
              id=${f.name}
              class=${err ? 'input-error' : ''}
              .value=${value}
              @change=${onInput}
              ?disabled=${this._submitted}
            />
            ${this._errorMsg(eKey)}
          </div>`;

      case 'range': {
        const min = f.min ?? 0;
        const max = f.max ?? 100;
        const step = f.step ?? 1;
        const numVal = value !== '' ? value : String(min);
        return html`
          <div class="field">
            <label for=${f.name}>${f.label}</label>
            <div class="range-wrap">
              <input
                type="range"
                id=${f.name}
                min=${min}
                max=${max}
                step=${step}
                .value=${numVal}
                @input=${(e: Event) => this._onInput(f.name, (e.target as HTMLInputElement).value)}
                ?disabled=${this._submitted}
              />
              <span class="range-value">${numVal}</span>
            </div>
          </div>`;
      }

      case 'multiselect': {
        let selected: string[];
        try { selected = JSON.parse(value || '[]'); } catch { selected = []; }
        if (!Array.isArray(selected)) selected = [];
        const toggle = (o: string) => {
          const next = selected.includes(o)
            ? selected.filter((x) => x !== o)
            : [...selected, o];
          this._onInput(f.name, JSON.stringify(next), eKey);
        };
        return html`
          <div class="field">
            <label>${f.label}</label>
            <div class="multiselect-group">
              ${(f.options ?? []).map((o) => html`
                <div class="multiselect-row">
                  <input
                    type="checkbox"
                    id=${`${f.name}_${o}`}
                    .checked=${selected.includes(o)}
                    @change=${() => toggle(o)}
                    ?disabled=${this._submitted}
                  />
                  <label for=${`${f.name}_${o}`}>${o}</label>
                </div>
              `)}
            </div>
            ${this._errorMsg(eKey)}
          </div>`;
      }

      case 'file': {
        const fs = this._fileState?.get(f.name) ?? { status: 'idle' as FileStatus, fileName: '' };
        const isDone = fs.status === 'done';
        const isUploading = fs.status === 'uploading';
        const disabled = this._submitted || isUploading;
        const dropClass = [
          'file-drop',
          isDone ? 'file-drop--done' : '',
          disabled ? 'file-drop--disabled' : '',
        ].filter(Boolean).join(' ');

        const onFileChange = (e: Event) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (file) this._uploadFile(f.name, file);
        };
        const onDragOver = (e: DragEvent) => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add('file-drop--over'); };
        const onDragLeave = (e: DragEvent) => { (e.currentTarget as HTMLElement).classList.remove('file-drop--over'); };
        const onDrop = (e: DragEvent) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).classList.remove('file-drop--over');
          const file = e.dataTransfer?.files?.[0];
          if (file && !disabled) this._uploadFile(f.name, file);
        };

        return html`
          <div class="field">
            <label>${f.label}</label>
            <div
              class=${dropClass}
              @dragover=${onDragOver}
              @dragleave=${onDragLeave}
              @drop=${onDrop}
            >
              ${!disabled ? html`
                <input
                  type="file"
                  accept=${f.accept ?? ''}
                  @change=${onFileChange}
                />` : ''}
              <div class="file-drop__icon">${isDone ? '✓' : '📎'}</div>
              ${isDone
                ? html`<div class="file-drop__name">${fs.fileName}</div>`
                : isUploading
                  ? html`<div class="file-drop__uploading">Uploading ${fs.fileName}…</div>`
                  : html`<div class="file-drop__prompt">Click or drag a file here</div>`}
            </div>
          </div>`;
      }

      case 'list': {
        const subFields = f.fields ?? [];
        const emptyRow = () => Object.fromEntries(subFields.map((sf) => [sf.name, sf.default ?? '']));

        let rows: Record<string, string>[];
        try { rows = JSON.parse(value || '[]'); } catch { rows = []; }
        if (!Array.isArray(rows) || rows.length === 0) rows = [emptyRow()];

        const updateRow = (idx: number, fieldName: string, val: string, sfErrKey: string) => {
          const next = rows.map((r, i) => i === idx ? { ...r, [fieldName]: val } : r);
          this._onInput(f.name, JSON.stringify(next), sfErrKey);
        };
        const addRow = () => {
          this._onInput(f.name, JSON.stringify([...rows, emptyRow()]));
        };
        const removeRow = (idx: number) => {
          const next = rows.filter((_, i) => i !== idx);
          this._onInput(f.name, JSON.stringify(next.length ? next : [emptyRow()]));
          // clear all errors for this row
          const prefix = `${f.name}[${idx}].`;
          const cleaned = Object.fromEntries(Object.entries(this._errors).filter(([k]) => !k.startsWith(prefix)));
          this._errors = cleaned;
        };

        const renderSubField = (sf: SubFieldDef, rowIdx: number, rowVal: Record<string, string>) => {
          const sfErrKey = `${f.name}[${rowIdx}].${sf.name}`;
          const sfErr = this._errors[sfErrKey];
          const val = rowVal[sf.name] ?? sf.default ?? '';
          const upd = (v: string) => updateRow(rowIdx, sf.name, v, sfErrKey);
          const errMsg = sfErr ? html`<p class="field-error">${sfErr}</p>` : '';
          const ec = sfErr ? 'input-error' : '';

          switch (sf.type) {
            case 'textarea':
              return html`<div class="field">
                <label>${sf.label}</label>
                <textarea class=${ec} placeholder=${sf.placeholder ?? ''} .value=${val}
                  @input=${(e: Event) => upd((e.target as HTMLTextAreaElement).value)} ?disabled=${this._submitted}></textarea>
                ${errMsg}
              </div>`;
            case 'number':
              return html`<div class="field">
                <label>${sf.label}</label>
                <input type="number" class=${ec} placeholder=${sf.placeholder ?? ''} .value=${val}
                  @input=${(e: Event) => upd((e.target as HTMLInputElement).value)} ?disabled=${this._submitted} />
                ${errMsg}
              </div>`;
            case 'select':
              return html`<div class="field">
                <label>${sf.label}</label>
                <select class=${ec} .value=${val} @change=${(e: Event) => upd((e.target as HTMLSelectElement).value)} ?disabled=${this._submitted}>
                  <option value="">— choose —</option>
                  ${(sf.options ?? []).map((o) => html`<option value=${o} ?selected=${val === o}>${o}</option>`)}
                </select>
                ${errMsg}
              </div>`;
            case 'checkbox': {
              const checked = val === 'true';
              return html`<div class="field">
                <div class="checkbox-row">
                  <input type="checkbox" .checked=${checked}
                    @change=${(e: Event) => upd(String((e.target as HTMLInputElement).checked))} ?disabled=${this._submitted} />
                  <label>${sf.label}</label>
                </div>
                ${errMsg}
              </div>`;
            }
            case 'radio':
              return html`<div class="field">
                <label>${sf.label}</label>
                <div class="radio-group">
                  ${(sf.options ?? []).map((o) => html`
                    <div class="radio-row">
                      <input type="radio" name=${`${f.name}_${rowIdx}_${sf.name}`} value=${o}
                        .checked=${val === o} @change=${() => upd(o)} ?disabled=${this._submitted} />
                      <label>${o}</label>
                    </div>`)}
                </div>
                ${errMsg}
              </div>`;
            case 'date':
              return html`<div class="field">
                <label>${sf.label}</label>
                <input type="date" class=${ec} .value=${val} @change=${(e: Event) => upd((e.target as HTMLInputElement).value)} ?disabled=${this._submitted} />
                ${errMsg}
              </div>`;
            case 'datetime':
              return html`<div class="field">
                <label>${sf.label}</label>
                <input type="datetime-local" class=${ec} .value=${val} @change=${(e: Event) => upd((e.target as HTMLInputElement).value)} ?disabled=${this._submitted} />
                ${errMsg}
              </div>`;
            case 'range': {
              const min = sf.min ?? 0; const max = sf.max ?? 100; const step = sf.step ?? 1;
              const num = val !== '' ? val : String(min);
              return html`<div class="field">
                <label>${sf.label}</label>
                <div class="range-wrap">
                  <input type="range" min=${min} max=${max} step=${step} .value=${num}
                    @input=${(e: Event) => upd((e.target as HTMLInputElement).value)} ?disabled=${this._submitted} />
                  <span class="range-value">${num}</span>
                </div>
                ${errMsg}
              </div>`;
            }
            case 'multiselect': {
              let sel: string[];
              try { sel = JSON.parse(val || '[]'); } catch { sel = []; }
              if (!Array.isArray(sel)) sel = [];
              const toggle = (o: string) => {
                const next = sel.includes(o) ? sel.filter((x) => x !== o) : [...sel, o];
                upd(JSON.stringify(next));
              };
              return html`<div class="field">
                <label>${sf.label}</label>
                <div class="multiselect-group">
                  ${(sf.options ?? []).map((o) => html`
                    <div class="multiselect-row">
                      <input type="checkbox" .checked=${sel.includes(o)}
                        @change=${() => toggle(o)} ?disabled=${this._submitted} />
                      <label>${o}</label>
                    </div>`)}
                </div>
                ${errMsg}
              </div>`;
            }
            case 'color': {
              const cv = val || '#000000';
              return html`<div class="field">
                <label>${sf.label}</label>
                <div class="color-wrap">
                  <input type="color" .value=${cv}
                    @input=${(e: Event) => upd((e.target as HTMLInputElement).value)} ?disabled=${this._submitted} />
                  <span class="color-hex">${cv}</span>
                </div>
                ${errMsg}
              </div>`;
            }
            default: // text
              return html`<div class="field">
                <label>${sf.label}</label>
                <input type="text" class=${ec} placeholder=${sf.placeholder ?? ''} .value=${val}
                  @input=${(e: Event) => upd((e.target as HTMLInputElement).value)} ?disabled=${this._submitted} />
                ${errMsg}
              </div>`;
          }
        };

        const cardHasError = (idx: number) =>
          subFields.some((sf) => this._errors[`${f.name}[${idx}].${sf.name}`]);

        return html`
          <div class="field">
            <label>${f.label}</label>
            ${this._errorMsg(f.name)}
            <div class="list-rows">
              ${rows.map((rowVal, idx) => html`
                <div class="list-card ${cardHasError(idx) ? 'card-has-error' : ''}">
                  ${rows.length > 1 ? html`
                    <div class="list-card__header">
                      <span class="list-card__title">${f.itemLabel ?? `Item ${idx + 1}`}</span>
                      <button type="button" class="list-card__remove" title="Remove"
                        ?disabled=${this._submitted} @click=${() => removeRow(idx)}>✕</button>
                    </div>` : ''}
                  <div class="list-card__body">
                    ${subFields.map((sf) => renderSubField(sf, idx, rowVal))}
                  </div>
                </div>`)}
              ${!this._submitted ? html`
                <button type="button" class="list-add-btn" @click=${addRow}>
                  + Add another
                </button>` : ''}
            </div>
          </div>`;
      }

      case 'color': {
        const colorVal = value || '#000000';
        return html`
          <div class="field">
            <label for=${f.name}>${f.label}</label>
            <div class="color-wrap">
              <input
                type="color"
                id=${f.name}
                .value=${colorVal}
                @input=${(e: Event) => this._onInput(f.name, (e.target as HTMLInputElement).value, eKey)}
                ?disabled=${this._submitted}
              />
              <span class="color-hex">${colorVal}</span>
            </div>
            ${this._errorMsg(eKey)}
          </div>`;
      }

      case 'html_output':
        return html`
          <html-output-block
            .content=${f.html ?? ''}
            .scopedCss=${f.css ?? ''}
          ></html-output-block>`;

      default: // text
        return html`
          <div class="field">
            <label for=${f.name}>${f.label}</label>
            <input
              type="text"
              id=${f.name}
              class=${err ? 'input-error' : ''}
              placeholder=${f.placeholder ?? ''}
              .value=${value}
              @input=${onInput}
              ?disabled=${this._submitted}
            />
            ${this._errorMsg(eKey)}
          </div>`;
    }
  }

  render() {
    return html`
      ${this._title ? html`<p class="title">${this._title}</p>` : ''}

      ${this._fields.map((f) => this._renderField(f))}

      ${this._fields.length > 0 ? html`
        <div class="actions">
          <button @click=${this._onSubmit} ?disabled=${this._submitted}>
            ${this._submitted ? 'Submitted' : 'Submit'}
          </button>
          ${this._submitted
            ? html`<span class="submitted-note">
                ${this._waiting ? 'Sent — agent is waiting for this' : 'Sent — the agent will pick this up when it checks back'}
              </span>`
            : (this._waiting
                ? html`<span class="submitted-note">Agent is waiting for your answers</span>`
                : '')}
        </div>
      ` : ''}

      <div class="status" style="margin-top: 1rem;">
        <span class="dot ${this._connected ? 'live' : ''}"></span>
        ${this._connected ? 'connected' : 'reconnecting…'}
      </div>
    `;
  }
}

customElements.define('mcp-form', McpForm);
