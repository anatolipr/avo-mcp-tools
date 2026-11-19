import { css } from 'lit';

export const screenMarkerStyles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      font-family: system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .theme-toggle {
      position: fixed;
      top: 10px;
      right: 12px;
      z-index: 10;
      width: 28px;
      height: 28px;
      border: 1px solid var(--border);
      border-radius: 50%;
      background: var(--panel);
      color: inherit;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.75;
    }
    .theme-toggle:hover {
      opacity: 1;
    }
    .tabs {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px 8px 0;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      user-select: none;
    }
    .tab {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px 8px 14px;
      border-radius: 8px 8px 0 0;
      cursor: pointer;
      font-size: 13px;
      border: 1px solid transparent;
      user-select: none;
    }
    /* Vertical bar at the tab's edge showing exactly where a dragged page
       will be inserted — left edge = before this tab, right edge = after it. */
    .tab.drag-over-before::before,
    .tab.drag-over-after::after {
      content: '';
      position: absolute;
      top: -2px;
      bottom: -2px;
      width: 3px;
      background: var(--accent);
      border-radius: 2px;
    }
    .tab.drag-over-before::before {
      left: -2px;
    }
    .tab.drag-over-after::after {
      right: -2px;
    }
    .tab.just-moved {
      animation: tab-flash 1.5s ease-out;
    }
    @keyframes tab-flash {
      0% {
        background: #ffd60a;
      }
      100% {
        background: transparent;
      }
    }
    .tab-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 4px;
      font-size: 13px;
      line-height: 1;
      opacity: 0.5;
    }
    .tab-close:hover {
      opacity: 1;
      background: rgba(128, 128, 128, 0.25);
    }
    .tab.active {
      background: var(--bg);
      border-color: var(--border);
      border-bottom-color: var(--bg);
      margin-bottom: -1px;
    }
    .tab-add {
      padding: 6px 10px;
      cursor: pointer;
      font-size: 16px;
      opacity: 0.6;
    }
    .tab-add:hover {
      opacity: 1;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
      user-select: none;
    }
    button,
    select {
      font: inherit;
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 13px;
    }
    button.active {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }
    button.button-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }
    button.button-primary:hover:not(:disabled) {
      filter: brightness(1.1);
    }
    button:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .swatch {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 2px solid transparent;
      box-shadow: inset 0 0 0 1px var(--border);
      cursor: pointer;
      padding: 0;
    }
    .swatch.active {
      border-color: var(--text);
    }
    .spacer {
      flex: 1;
    }
    .stage {
      flex: 1;
      display: flex;
      overflow: auto;
      padding: 16px;
    }
    .canvas-wrap {
      position: relative;
      margin: auto;
      box-shadow: 0 2px 16px rgba(0, 0, 0, 0.15);
      background: var(--panel);
      flex: none;
      overflow: hidden;
    }
    canvas {
      display: block;
      transform-origin: 0 0;
    }
    .region-actions {
      position: absolute;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
      white-space: nowrap;
      z-index: 2;
    }
    .region-actions button {
      padding: 4px 8px;
      font-size: 12px;
    }
    .region-size {
      font-size: 11px;
      opacity: 0.7;
      padding: 0 4px;
      font-variant-numeric: tabular-nums;
    }
    .zoom-controls {
      display: inline-flex;
      align-items: center;
      gap: 2px;
    }
    .zoom-level {
      font-size: 12px;
      opacity: 0.7;
      min-width: 42px;
      text-align: center;
    }
    .empty {
      color: var(--text);
      opacity: 0.6;
      text-align: center;
      font-size: 14px;
      max-width: 320px;
      line-height: 1.6;
    }
    .status {
      padding: 4px 14px 8px;
      font-size: 12px;
      opacity: 0.6;
    }
    .preview-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: grid;
      place-items: center;
      padding: 32px;
      z-index: 100;
    }
    .preview-card {
      background: var(--panel);
      border-radius: 10px;
      box-shadow: 0 8px 40px rgba(0, 0, 0, 0.4);
      max-width: 90vw;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .preview-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
    }
    .preview-header-controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .preview-header button {
      padding: 2px 8px;
    }
    .preview-body {
      flex: 1;
      overflow: auto;
      padding: 16px;
      display: flex;
    }
    .preview-img-wrap {
      position: relative;
      margin: auto;
      flex: none;
      overflow: hidden;
    }
    .preview-img-wrap img {
      display: block;
      transform-origin: 0 0;
    }

    .canvas-wrap.panning,
    .canvas-wrap.panning canvas {
      cursor: grab;
    }
    .text-editor {
      position: absolute;
      z-index: 3;
      margin: 0;
      padding: 0;
      border: 1px dashed currentColor;
      border-radius: 2px;
      outline: none;
      background: transparent;
      font-family: system-ui, sans-serif;
      font-weight: bold;
      line-height: 1.2;
      min-width: 2ch;
      field-sizing: content;
    }
    .tag-editor {
      border: none;
      resize: none;
      overflow: hidden;
      white-space: pre-wrap;
      field-sizing: content;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
      box-sizing: border-box;
    }
    .cloud-name {
      margin-left: auto;
      margin-right: 84px;
      font-size: 12px;
      opacity: 0.7;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 40vw;
      padding-bottom: 6px;
    }
    .color-input {
      width: 26px;
      height: 26px;
      padding: 0;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: none;
      cursor: pointer;
    }
    .group {
      display: inline-flex;
      align-items: center;
      gap: 2px;
    }
    .group button {
      padding: 6px 8px;
    }
`;
