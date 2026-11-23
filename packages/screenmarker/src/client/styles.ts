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
    .search-bar {
      position: absolute;
      top: 8px;
      right: 16px;
      z-index: 5;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
      max-width: calc(100% - 32px);
      flex-wrap: wrap;
    }
    .search-bar input {
      font: inherit;
      font-size: 13px;
      width: 180px;
      padding: 4px 6px;
      color: inherit;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    .search-bar button {
      padding: 4px 8px;
      font-size: 12px;
    }
    .search-count {
      font-size: 12px;
      opacity: 0.75;
      min-width: 40px;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }
    .export-bg {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      opacity: 0.85;
    }
    .export-bg select {
      font: inherit;
      color: inherit;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 3px 4px;
    }
    .export-bg input[type='color'] {
      width: 24px;
      height: 22px;
      padding: 0;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: none;
    }
    .spacer {
      flex: 1;
    }
    /* A camera, not a scroll box: the wheel pans and the canvas is placed by the camera (see #canvasWrapStyle). */
    .stage {
      flex: 1;
      position: relative;
      overflow: hidden;
      overscroll-behavior: none;
      touch-action: none;
      background: var(--scene-bg, transparent);
    }
    .canvas-wrap {
      position: absolute;
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
    .step-editor {
      border: none;
      border-radius: 50%;
      text-align: center;
      padding: 0;
      field-sizing: fixed;
      box-sizing: border-box;
    }
    .next-step {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 13px;
    }
    .next-step input {
      width: 56px;
      font: inherit;
      padding: 5px 6px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--panel);
      color: var(--text);
    }
    .tag-panel {
      position: absolute;
      z-index: 4;
      padding: 6px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.25);
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .tag-panel-title {
      font-size: 11px;
      opacity: 0.6;
      padding: 0 2px 2px;
    }
    .tag-grid-row {
      display: flex;
      gap: 3px;
    }
    .tag-cell {
      display: flex;
      width: 26px;
      height: 24px;
      padding: 1px 3px;
      font-size: 12px;
      line-height: 1;
    }
    .tag-none {
      padding: 3px 6px;
      font-size: 11px;
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

    .titlebar {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 44px;
      padding: 0 104px 0 14px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      font-size: 13px;
      user-select: none;
    }
    .titlebar .app-name {
      font-weight: 600;
      opacity: 0.85;
    }
    .titlebar .cloud-name {
      margin: 0;
      padding: 0;
      max-width: 36vw;
    }
    .titlebar button {
      padding: 3px 8px;
      font-size: 12px;
    }
    .save-state {
      font-size: 12px;
      opacity: 0.6;
    }
    .save-state.dirty,
    .save-state.saving {
      opacity: 0.8;
    }
    .save-state.error,
    .save-state.conflict,
    .save-state.remote {
      opacity: 1;
      color: #e5484d;
    }
    .peers {
      font-size: 12px;
      opacity: 0.75;
    }
    .workspace {
      flex: 1;
      min-height: 0;
      display: flex;
    }
    .main {
      position: relative;
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .page-strip {
      flex: none;
      width: 104px;
      overflow-y: auto;
      padding: 8px 6px;
      background: var(--panel);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 6px;
      user-select: none;
    }
    .page-item {
      position: relative;
      padding: 3px 3px 3px 15px;
      border-radius: 8px;
      border: 2px solid transparent;
      cursor: pointer;
    }
    .page-item:hover {
      background: rgba(128, 128, 128, 0.1);
    }
    .page-item.active {
      border-color: var(--accent);
    }
    .page-item.just-moved {
      animation: tab-flash 1.5s ease-out;
    }
    .page-item.drag-over-before::before,
    .page-item.drag-over-after::after {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      height: 3px;
      background: var(--accent);
      border-radius: 2px;
    }
    .page-item.drag-over-before::before {
      top: -7px;
    }
    .page-item.drag-over-after::after {
      bottom: -7px;
    }
    .page-num {
      position: absolute;
      left: 2px;
      top: 3px;
      font-size: 10px;
      opacity: 0.6;
    }
    .page-thumb {
      aspect-ratio: 4 / 3;
      display: grid;
      place-items: center;
      background: rgba(128, 128, 128, 0.12);
      border-radius: 4px;
      overflow: hidden;
      font-size: 11px;
      opacity: 0.95;
    }
    .page-thumb img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      display: block;
    }
    .page-thumb span {
      opacity: 0.5;
    }
    .page-title {
      margin-top: 2px;
      font-size: 10px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .page-actions {
      position: absolute;
      top: 4px;
      right: 4px;
      display: none;
      gap: 2px;
    }
    .page-item:hover .page-actions {
      display: flex;
    }
    .page-actions button {
      padding: 0 4px;
      font-size: 11px;
      line-height: 16px;
      background: var(--panel);
    }
    .page-add {
      font-size: 11px;
      padding: 4px 6px;
      opacity: 0.8;
    }
    .strip-toggle {
      padding: 2px 7px;
    }
    .tabs-inline {
      display: flex;
      align-items: center;
      gap: 2px;
      min-width: 0;
      overflow-x: auto;
      flex: 0 1 auto;
    }
    .tabs-inline .tab {
      padding: 4px 6px 4px 10px;
      border-radius: 6px;
      white-space: nowrap;
      max-width: 160px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tabs-inline .tab.active {
      background: var(--bg);
      border-color: var(--border);
      margin-bottom: 0;
    }
    .slide-panel {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 14px;
      border-top: 1px solid var(--border);
      background: var(--panel);
      font-size: 13px;
    }
    .slide-title {
      flex: 1;
      min-width: 120px;
      max-width: 420px;
      font: inherit;
      padding: 5px 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
      color: var(--text);
    }
    .slide-reveal {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      cursor: pointer;
      white-space: nowrap;
    }
    .slide-notes {
      margin: 0;
      padding: 8px 14px;
      border: none;
      border-top: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      font: 13px/1.5 system-ui, sans-serif;
      resize: vertical;
      outline: none;
    }
    .empty {
      margin: auto;
      max-width: 760px;
    }
    .recent-heading {
      margin: 28px 0 10px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      opacity: 0.7;
    }
    .recent-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 12px;
      text-align: left;
    }
    .recent-card {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 6px;
      opacity: 1;
    }
    .recent-thumb {
      aspect-ratio: 4 / 3;
      display: grid;
      place-items: center;
      background: rgba(128, 128, 128, 0.12);
      border-radius: 4px;
      overflow: hidden;
      font-size: 22px;
    }
    .recent-thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .recent-name {
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .recent-when {
      font-size: 11px;
      opacity: 0.6;
    }
    .menu-backdrop {
      position: fixed;
      inset: 0;
      z-index: 150;
    }
    .menu {
      position: fixed;
      z-index: 151;
      min-width: 210px;
      padding: 4px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.3);
      display: flex;
      flex-direction: column;
    }
    .menu-item {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      border: none;
      background: none;
      text-align: left;
      padding: 6px 10px;
      border-radius: 5px;
    }
    .menu-item:hover:not(:disabled) {
      background: var(--accent);
      color: #fff;
    }
    .menu-item.danger {
      color: #e5484d;
    }
    .menu-item.danger:hover:not(:disabled) {
      background: #e5484d;
      color: #fff;
    }
    .menu-item kbd {
      font: inherit;
      opacity: 0.55;
    }
    .menu-sep {
      height: 1px;
      margin: 4px 6px;
      background: var(--border);
    }
    .menu-colors {
      display: flex;
      gap: 6px;
      padding: 4px 10px;
    }
    .empty-overlay {
      position: absolute;
      inset: 0;
      margin: 0;
      max-width: none;
      padding: 48px 24px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      overflow: auto;
    }
    .empty-overlay > div:first-child {
      max-width: 520px;
    }
    .empty-overlay .recent-grid {
      width: min(760px, 100%);
    }
    .empty-overlay button {
      pointer-events: auto;
    }
    .empty-text {
      margin: 0 4px;
      padding: 2px 8px;
      font-size: 13px;
    }
    .label-editor {
      resize: none;
      overflow: hidden;
      white-space: pre-wrap;
      overflow-wrap: break-word;
      box-sizing: border-box;
      field-sizing: fixed;
    }
    .text-style {
      align-items: center;
    }
    .text-style button {
      min-width: 28px;
    }
    .md-help {
      cursor: help;
      font-size: 12px;
      opacity: 0.6;
      padding: 0 4px;
    }
`;
