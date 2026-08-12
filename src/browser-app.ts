import { THEME_STORAGE_KEY, renderBrowserAppClientScript } from './browser-app-client';

export function renderBrowserAppHtml(baseUrl: string): string {
	const config = JSON.stringify({ baseUrl });
	let serverLabel = baseUrl;
	try {
		serverLabel = new URL(baseUrl).host;
	} catch {
		// Keep the configured value visible if it is not a complete URL.
	}
	const sharedClientScript = renderBrowserAppClientScript();
	const themeBootstrapScript = renderBrowserAppThemeBootstrapScript();
	const runtimeScript = renderBrowserAppRuntimeScript();

	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pigeon</title>
    <script>${escapeScript(themeBootstrapScript)}</script>
    <style>
      :root {
        color-scheme: light;
        --page: #edf1f5;
        --surface: #ffffff;
        --surface-muted: #f7f8fa;
        --surface-subtle: #f2f5f8;
        --surface-emphasis: #e8edf3;
        --surface-strong: #eef2f7;
        --border: #d8dfe7;
        --border-strong: #c5cdd8;
        --text: #111827;
        --muted: #6b7280;
        --accent: #1d74f5;
        --accent-strong: #0f65ea;
        --accent-muted: #eaf3ff;
        --danger: #b42318;
        --frame: #ffffff;
        --shadow: 0 24px 64px rgba(15, 23, 42, 0.08);
      }

      html[data-theme="dark"] {
        color-scheme: dark;
        --page: #0b1220;
        --surface: #111827;
        --surface-muted: #0f172a;
        --surface-subtle: #162032;
        --surface-emphasis: #1e293b;
        --surface-strong: #202d41;
        --border: #334155;
        --border-strong: #475569;
        --text: #e5e7eb;
        --muted: #94a3b8;
        --accent: #60a5fa;
        --accent-strong: #3b82f6;
        --accent-muted: #16233d;
        --danger: #fca5a5;
        --frame: #0f172a;
        --shadow: 0 28px 72px rgba(2, 6, 23, 0.45);
      }

      html {
        background: var(--page);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: var(--text);
        background: var(--page);
      }

      button,
      input,
      select,
      textarea {
        font: inherit;
      }

      button {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface);
        color: var(--text);
        cursor: pointer;
        padding: 0.55rem 0.85rem;
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
      }

      button:hover {
        background: var(--surface-subtle);
        border-color: var(--border-strong);
      }

      button[disabled] {
        cursor: default;
        opacity: 0.72;
      }

      input {
        width: 100%;
        padding: 0.72rem 0.85rem;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: var(--surface);
        color: var(--text);
      }

      #app {
        min-height: 100vh;
        padding: 1rem;
      }

      .hidden {
        display: none !important;
      }

      .login-shell {
        min-height: calc(100vh - 2.5rem);
        display: grid;
        place-items: center;
      }

      .login-card {
        width: min(28rem, 100%);
        padding: 1.6rem;
        border: 1px solid var(--border);
        border-radius: 14px;
        background: var(--surface);
        box-shadow: var(--shadow);
      }

      .login-card h1,
      .reader-brand h1 {
        margin: 0 0 0.5rem;
        font-size: clamp(1.5rem, 2.5vw, 2rem);
        letter-spacing: 0;
      }

      .login-card p,
      .reader-brand p,
      .panel-note,
      .status-meta,
      .article-meta,
      .feed-meta {
        color: var(--muted);
      }

      #login-form {
        display: grid;
        gap: 0.75rem;
        margin-top: 1rem;
      }

      .login-server {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 0.75rem;
        align-items: center;
        padding: 0.7rem 0.8rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface-muted);
      }

      .login-server span,
      .login-help {
        color: var(--muted);
        font-size: 0.86rem;
      }

      .login-server strong {
        min-width: 0;
        overflow-wrap: anywhere;
        text-align: right;
      }

      .login-field {
        display: grid;
        gap: 0.4rem;
      }

      .login-field-label {
        font-size: 0.9rem;
        font-weight: 650;
      }

      .login-help {
        margin: 0;
        line-height: 1.45;
      }

      #login-button {
        background: var(--text);
        border-color: var(--text);
        color: #ffffff;
      }

      #login-button:hover {
        background: #000000;
        border-color: #000000;
      }

      #login-error {
        min-height: 1.2rem;
        color: var(--danger);
      }

      .session-recovery {
        display: grid;
        gap: 0.55rem;
        margin-top: 1rem;
        padding-top: 1rem;
        border-top: 1px solid var(--border);
      }

      #clear-session-button,
      #logout-button {
        border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
        color: var(--danger);
      }

      .reader-shell {
        width: min(100%, 100rem);
        margin: 0 auto;
      }

      .reader-window {
        border: 1px solid var(--border);
        border-radius: 16px;
        overflow: hidden;
        background: var(--surface);
        box-shadow: var(--shadow);
      }

      #reader-toolbar {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        align-items: center;
        padding: 0.8rem 1rem;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
      }

      .reader-brand {
        display: grid;
        gap: 0.2rem;
      }

      .reader-brand p {
        margin: 0;
        font-size: 0.75rem;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }

      .reader-brand h1 {
        margin-bottom: 0;
        font-size: 1.05rem;
      }

      .toolbar-actions,
      .reader-pane-actions {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        flex-wrap: wrap;
      }

      .icon-button {
        width: 2rem;
        height: 2rem;
        display: inline-grid;
        place-items: center;
        padding: 0;
        border-radius: 999px;
      }

      .icon-button svg {
        width: 1rem;
        height: 1rem;
        stroke: currentColor;
      }

      .toolbar-pill,
      .secondary-button {
        background: var(--surface);
        color: var(--text);
        border-color: var(--border);
      }

      .toolbar-pill:hover,
      .secondary-button:hover {
        background: var(--surface-subtle);
      }

      .toolbar-pill[data-presentational-control="true"] {
        color: var(--muted);
      }

      .toolbar-pill[data-control-tone="subtle"] {
        background: var(--surface-muted);
        color: var(--muted);
        border-color: var(--border);
      }

      #theme-toggle-button[aria-pressed="true"],
      #article-list-mode-button[aria-pressed="true"] {
        background: var(--accent-muted);
        border-color: var(--accent);
        color: var(--accent);
      }

      .toolbar-pill[data-control-tone="subtle"][disabled] {
        opacity: 0.72;
      }

      .toolbar-pill[data-control-tone="subtle"][disabled]:hover {
        background: var(--surface-muted);
        color: var(--muted);
        border-color: var(--border);
      }

      .reader-grid {
        display: grid;
        --sidebar-column-width: 26rem;
        --stream-column-width: 32.75rem;
        grid-template-columns:
          minmax(16rem, var(--sidebar-column-width))
          0.45rem
          minmax(24rem, var(--stream-column-width))
          0.45rem
          minmax(0, 1fr);
        grid-template-areas: "sidebar sidebar-resizer stream stream-resizer reader";
        min-height: calc(100vh - 8.1rem);
      }

      .panel {
        min-height: 18rem;
        display: flex;
        flex-direction: column;
        padding: 0;
        border: 0;
        border-right: 1px solid var(--border);
        background: var(--surface);
      }

      #feeds-panel {
        grid-area: sidebar;
      }

      #articles-panel {
        grid-area: stream;
      }

      #reader-panel {
        grid-area: reader;
        border-right: 0;
      }

      .column-resizer {
        position: relative;
        z-index: 3;
        border: 0;
        border-radius: 0;
        padding: 0;
        background: var(--surface);
        color: transparent;
        cursor: col-resize;
        touch-action: none;
      }

      .column-resizer::before {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 50%;
        width: 1px;
        transform: translateX(-50%);
        background: var(--border);
      }

      .column-resizer:hover::before,
      .column-resizer.is-dragging::before {
        width: 3px;
        background: var(--accent);
      }

      .column-resizer:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
      }

      .column-resizer[data-resizer="sidebar"] {
        grid-area: sidebar-resizer;
      }

      .column-resizer[data-resizer="stream"] {
        grid-area: stream-resizer;
      }

      .panel h2,
      .reader-copy h2 {
        margin: 0 0 0.25rem;
        font-size: 0.78rem;
        color: var(--muted);
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }

      .section-kicker {
        display: inline-flex;
        margin: 0 0 0.35rem;
        padding: 0;
        color: var(--muted);
        font-size: 0.72rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .sidebar-section,
      .pane-header {
        display: grid;
        gap: 0.25rem;
      }

      .sidebar-top {
        display: grid;
        gap: 0.8rem;
        padding: 1rem;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
      }

      .sidebar-top-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 0.75rem;
      }

      .sidebar-app-title {
        font-size: 1.05rem;
        font-weight: 700;
        letter-spacing: 0;
      }

      .sidebar-current {
        display: grid;
        gap: 0.25rem;
      }

      .sidebar-current strong {
        font-size: 1.05rem;
        line-height: 1.25;
      }

      .sidebar-current p {
        margin: 0;
        color: var(--muted);
        font-size: 0.84rem;
      }

      .sidebar-section {
        padding: 0.9rem 0 0.25rem;
      }

      .sidebar-divider {
        height: 1px;
        margin: 0;
        background: var(--border);
      }

      .list-shell {
        flex: 1;
        display: grid;
        overflow: auto;
      }

      .list-reset {
        display: grid;
        gap: 0;
        padding: 0;
        margin: 0;
        list-style: none;
      }

      .list-button {
        width: 100%;
        border: 0;
        border-radius: 0;
        border-bottom: 1px solid var(--surface-emphasis);
        background: transparent;
        color: var(--text);
        padding: 0.72rem 1rem;
        text-align: left;
      }

      .list-button:hover {
        background: var(--surface-subtle);
        color: var(--text);
      }

      .list-button.is-active {
        background: var(--accent);
        color: #ffffff;
      }

      .list-button.is-active:hover {
        background: var(--accent-strong);
        color: #ffffff;
      }

      .list-button.is-child {
        padding-left: 1.95rem;
      }

      .list-button.is-child .feed-title {
        font-size: 0.88rem;
      }

      .feed-row {
        display: flex;
        justify-content: space-between;
        gap: 0.75rem;
        align-items: center;
      }

      .feed-title-line {
        display: inline-flex;
        gap: 0.55rem;
        align-items: center;
        min-width: 0;
      }

      .feed-title,
      .article-title {
        display: block;
        font-weight: 700;
        letter-spacing: -0.01em;
      }

      .feed-title {
        font-size: 0.9rem;
      }

      .feed-count {
        min-width: 2rem;
        color: var(--muted);
        font-size: 0.78rem;
        font-weight: 600;
        text-align: center;
      }

      .list-button.is-active .feed-count,
      .list-button.is-active .feed-meta,
      .list-button.is-active .article-meta,
      .list-button.is-active .article-preview {
        color: rgba(255, 255, 255, 0.82);
      }

      .feed-meta,
      .article-preview,
      .article-meta {
        display: block;
        margin-top: 0.25rem;
      }

      .feed-meta {
        color: var(--muted);
        font-size: 0.78rem;
      }

      .article-card {
        width: 100%;
        display: grid;
        gap: 0.45rem;
        border: 0;
        border-radius: 0;
        border-bottom: 1px solid var(--surface-emphasis);
        background: var(--surface);
        color: var(--text);
        padding: 0.85rem 1rem;
        text-align: left;
      }

      .article-card:hover {
        background: var(--surface-subtle);
        color: var(--text);
      }

      .article-card.is-active {
        background: var(--accent);
        color: #ffffff;
      }

      .article-card-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 0.85rem;
        align-items: start;
      }

      .article-card.has-hero-image .article-card-grid {
        grid-template-columns: minmax(0, 1fr) 8rem;
      }

      .article-card-copy {
        display: grid;
        gap: 0.35rem;
        min-width: 0;
      }

      .article-title {
        font-size: 0.98rem;
        line-height: 1.3;
        letter-spacing: 0;
      }

      .article-preview {
        margin-top: 0;
        color: var(--muted);
        font-size: 0.84rem;
        line-height: 1.45;
      }

      .article-meta {
        margin-top: 0;
        color: var(--muted);
        font-size: 0.74rem;
        letter-spacing: 0.02em;
      }

      .article-hero {
        width: 100%;
        aspect-ratio: 4 / 3;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: var(--surface-subtle);
        object-fit: cover;
      }

      #reader-panel {
        display: flex;
      }

      .reader-pane-surface {
        display: grid;
        grid-template-rows: auto auto minmax(0, 1fr);
        gap: 0;
        min-height: 100%;
        width: 100%;
        background: var(--surface);
      }

      #reader-pane-toolbar {
        display: flex;
        justify-content: space-between;
        gap: 0.75rem;
        align-items: center;
        padding: 0.8rem 1.1rem;
        border-bottom: 1px solid var(--border);
        background: var(--surface-muted);
      }

      .reader-pane-toolbar-copy {
        display: grid;
        gap: 0.2rem;
      }

      .reader-pane-label {
        margin: 0;
        font-size: 0.74rem;
        color: var(--muted);
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .reader-pane-note {
        margin: 0;
        color: var(--muted);
        font-size: 0.84rem;
        line-height: 1.4;
      }

      .reader-copy {
        display: grid;
        gap: 0.55rem;
        padding: 1.1rem 1.25rem 0;
      }

      .reader-copy strong {
        font-size: clamp(1.55rem, 2.2vw, 2rem);
        line-height: 1.2;
        letter-spacing: 0;
      }

      .reader-copy h2 {
        margin-bottom: 0;
      }

      #reader-meta {
        margin: 0;
        font-size: 0.92rem;
        line-height: 1.55;
        letter-spacing: 0.01em;
      }

      .reader-frame-shell {
        flex: 1;
        padding: 1rem 1.25rem 1.25rem;
      }

      #reader-frame {
        width: 100%;
        min-height: 60vh;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--frame);
      }

      #settings-panel {
        position: fixed;
        top: 1.5rem;
        right: 1.5rem;
        width: min(24rem, calc(100vw - 3rem));
        min-height: auto;
        max-height: calc(100vh - 3rem);
        overflow: auto;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface);
        z-index: 20;
        box-shadow: var(--shadow);
      }

      #settings-panel h2 {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 0.75rem;
      }

      #settings-content dl {
        display: grid;
        gap: 0.5rem;
        margin: 0;
      }

      #settings-content dt {
        font-weight: 700;
      }

      #settings-content dd {
        margin: 0;
        color: var(--muted);
      }

      /* Feedbin-inspired density and spacing. Keep these late in the cascade so they tune the existing reader components. */
      #app {
        padding: 1.25rem;
      }

      .reader-shell {
        width: min(100%, 118rem);
      }

      .reader-grid {
        --sidebar-column-width: 26rem;
        --stream-column-width: 32.75rem;
      }

      .reader-brand p {
        display: none;
      }

      .reader-brand h1,
      .sidebar-app-title {
        font-size: 1rem;
        font-weight: 700;
      }

      .sidebar-top {
        padding: 1.35rem 1.4rem 1rem;
        border-bottom: 0;
      }

      #feeds-panel .sidebar-top {
        padding-top: 2.6rem;
      }

      .sidebar-current strong,
      #articles-heading {
        font-size: 1.86rem;
        line-height: 1.05;
        letter-spacing: -0.035em;
      }

      .sidebar-current p,
      .status-meta {
        font-size: 0.98rem;
        line-height: 1.35;
      }

      .pane-header {
        padding: 0 1.4rem 0.35rem;
      }

      .pane-header h2,
      .panel h2 {
        margin: 0;
        font-size: 0.86rem;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: none;
      }

      .sidebar-section {
        padding: 0.8rem 0 0.2rem;
      }

      .list-button {
        border-bottom: 0;
        border-radius: 4px;
        margin: 0 0.55rem;
        width: calc(100% - 1.1rem);
        padding: 0.45rem 0.75rem;
      }

      .list-button.is-child {
        padding-left: 2.2rem;
      }

      .folder-list-item {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: start;
        gap: 0.35rem;
        padding: 0 0.55rem;
      }

      .folder-list-item > .list-button {
        width: 100%;
        margin: 0;
      }

      .feed-title {
        font-size: 1rem;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .feed-count {
        font-size: 1rem;
        font-weight: 400;
        text-align: right;
      }

      .feed-meta {
        margin-top: 0.12rem;
        font-size: 0.72rem;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      .feed-disclosure {
        width: 1rem;
        color: currentColor;
        font-size: 1rem;
        line-height: 1;
        display: inline-grid;
        place-items: center;
      }

      .folder-toggle {
        width: 1.8rem;
        height: 2.35rem;
        padding: 0;
        border-radius: 4px;
      }

      .folder-toggle .feed-disclosure {
        width: 100%;
      }

      .feed-icon {
        border-radius: 3px;
      }

      .article-card {
        padding: 0.78rem 0.72rem 0.78rem 1.55rem;
      }

      .article-card.has-hero-image .article-card-grid {
        grid-template-columns: minmax(0, 1fr);
      }

      .article-title {
        font-size: 1.05rem;
        line-height: 1.25;
      }

      .article-preview {
        font-size: 1rem;
        line-height: 1.36;
      }

      .article-meta {
        font-size: 0.96rem;
      }

      .article-hero {
        aspect-ratio: 16 / 9;
        border: 0;
      }

      .article-card.is-active .article-preview,
      .article-card.is-active .article-meta {
        color: rgba(255, 255, 255, 0.82);
      }

      #reader-pane-toolbar {
        padding: 0.75rem 1.35rem;
        background: var(--surface);
      }

      .reader-pane-label {
        font-size: 1rem;
        color: var(--text);
        letter-spacing: 0;
        text-transform: none;
      }

      .reader-copy {
        padding: 2.85rem min(5vw, 4.15rem) 0;
      }

      .reader-copy strong {
        font-size: clamp(2.05rem, 3.1vw, 2.75rem);
        line-height: 1.08;
        letter-spacing: -0.035em;
      }

      #reader-meta {
        color: var(--muted);
        font-size: 1.13rem;
        line-height: 1.38;
      }

      .reader-frame-shell {
        padding: 1.55rem min(5vw, 4.15rem) 1.25rem;
      }

      #reader-frame {
        border: 0;
        border-radius: 0;
      }

      @media (max-width: 1100px) {
        #app {
          padding: 0.9rem;
        }

        #reader-toolbar {
          padding: 0.85rem;
        }

        .reader-grid {
          --sidebar-column-width: 16rem;
          --stream-column-width: 23rem;
          grid-template-columns:
            minmax(14rem, var(--sidebar-column-width))
            0.45rem
            minmax(21rem, var(--stream-column-width))
            0.45rem
            minmax(0, 1fr);
        }
      }

      @media (max-width: 900px) {
        #app {
          padding: 0.75rem;
        }

        .reader-window {
          border-radius: 12px;
        }

        #reader-toolbar {
          flex-direction: column;
          align-items: stretch;
          gap: 0.75rem;
          padding: 0.8rem 0.85rem;
        }

        .toolbar-actions {
          width: 100%;
          justify-content: flex-start;
        }

        .toolbar-actions button {
          flex: 1 1 auto;
          min-width: 0;
        }

        #reader-pane-toolbar {
          flex-direction: column;
          align-items: stretch;
          gap: 0.75rem;
          padding: 0.75rem 0.85rem;
        }

        .reader-pane-actions {
          width: 100%;
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 0.5rem;
        }

        .toolbar-pill {
          padding: 0.6rem 0.75rem;
        }

        .reader-grid {
          grid-template-columns: 1fr;
          grid-template-areas: "sidebar" "stream" "reader";
        }

        .column-resizer {
          display: none;
        }

        .article-card.has-hero-image .article-card-grid {
          grid-template-columns: 1fr;
        }

        .reader-copy {
          padding: 0.9rem 1rem 0;
          gap: 0.45rem;
        }

        .reader-copy strong {
          font-size: clamp(1.25rem, 5vw, 1.65rem);
        }

        #reader-meta {
          font-size: 0.88rem;
        }

        .reader-frame-shell {
          padding: 0.9rem 1rem 1rem;
        }

        #reader-frame {
          min-height: 50vh;
        }

        .panel {
          border-right: 0;
          border-bottom: 1px solid var(--border);
        }

        #reader-panel {
          border-bottom: 0;
        }

        #settings-panel {
          top: auto;
          right: 0.75rem;
          bottom: 0.75rem;
          left: 0.75rem;
          width: auto;
          max-height: min(28rem, calc(100vh - 1.5rem));
          border-radius: 8px;
        }
      }

      @media (max-width: 640px) {
        #app {
          padding: 0.5rem;
        }

        .reader-window {
          border-radius: 6px;
        }

        .reader-brand h1 {
          font-size: 1.1rem;
        }

        .reader-pane-actions {
          grid-template-columns: 1fr;
        }

        .toolbar-actions button,
        .toolbar-pill {
          padding: 0.6rem 0.75rem;
        }

        #reader-frame {
          min-height: 54vh;
        }
      }
    </style>
  </head>
  <body>
    <script>
      window.__PIGEON_CONFIG__ = ${escapeScript(config)};
    </script>
    <script>
      ${sharedClientScript}
    </script>
    <div id="app" data-base-url="${escapeHtml(baseUrl)}">
      <section class="login-shell" id="login-screen">
        <div class="login-card">
          <h1>Sign in to Pigeon</h1>
          <p>Enter the same Pigeon password you use in your reader apps.</p>
          <div class="login-server">
            <span>Server</span>
            <strong>${escapeHtml(serverLabel)}</strong>
          </div>
          <form id="login-form">
            <input name="Email" type="text" autocomplete="username" value="pigeon" hidden />
            <label class="login-field" for="password-input">
              <span class="login-field-label">Pigeon password</span>
              <input id="password-input" name="Passwd" type="password" autocomplete="current-password" placeholder="Enter your Pigeon password" />
            </label>
            <p class="login-help"><strong>Reeder Classic:</strong> use username <strong>pigeon</strong> and this same password.</p>
            <button id="login-button" type="submit">Sign In</button>
            <div id="login-error" aria-live="polite"></div>
          </form>
          <div class="session-recovery">
            <p class="login-help">If the reader is stuck or showing errors, clear its saved session and sign in again.</p>
            <button class="secondary-button" id="clear-session-button" type="button">Clear Saved Session</button>
          </div>
        </div>
      </section>

      <section class="reader-shell hidden" id="reader-shell" tabindex="-1">
        <div class="reader-window">
          <header id="reader-toolbar">
            <div class="reader-brand">
              <p>Private reader</p>
              <h1>Pigeon</h1>
            </div>
            <div class="toolbar-actions">
              <button class="toolbar-pill" id="theme-toggle-button" type="button" aria-pressed="false">Dark mode: Off</button>
              <button class="toolbar-pill" id="article-list-mode-button" type="button" aria-pressed="false">Title-only list: Off</button>
              <button class="secondary-button" id="settings-button" type="button">Settings</button>
              <button id="logout-button" type="button">Sign Out</button>
            </div>
          </header>

          <div class="reader-grid" id="reader-grid">
            <aside class="panel" id="feeds-panel">
              <div class="sidebar-top">
                <div class="sidebar-top-row">
                  <span class="sidebar-app-title">Reader</span>
                  <button
                    class="icon-button toolbar-pill"
                    id="search-button"
                    type="button"
                    aria-label="Search"
                    data-presentational-control="true"
                    data-control-tone="subtle"
                    disabled
                  >
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <circle cx="11" cy="11" r="7" stroke-width="1.8"></circle>
                      <path d="M20 20l-3.5-3.5" stroke-width="1.8" stroke-linecap="round"></path>
                    </svg>
                  </button>
                </div>
                <div class="sidebar-current">
                  <strong id="sidebar-current-title">All items</strong>
                  <p id="sidebar-current-meta">Choose a stream to load article previews.</p>
                </div>
              </div>

              <section class="sidebar-section" id="real-views-section">
                <div class="pane-header">
                  <h2>Unread / Recently Read</h2>
                </div>
                <div class="list-shell">
                  <ul class="list-reset" id="views-list"></ul>
                </div>
              </section>

              <div class="sidebar-divider" aria-hidden="true"></div>

              <section class="sidebar-section" id="folder-views-section">
                <div class="pane-header">
                  <h2>Tags / Folders</h2>
                  <p class="status-meta" id="folders-status">Tagged feeds appear here.</p>
                </div>
                <div class="list-shell">
                  <ul class="list-reset" id="folders-list"></ul>
                </div>
              </section>

              <div class="sidebar-divider" aria-hidden="true"></div>

              <section class="sidebar-section" id="real-feeds-section">
                <div class="pane-header">
                  <h2>Feeds</h2>
                  <p class="status-meta" id="feeds-status">Uncategorized feeds appear here after login.</p>
                </div>
                <div class="list-shell">
                  <ul class="list-reset" id="feeds-list"></ul>
                </div>
              </section>
            </aside>

            <button
              class="column-resizer"
              id="sidebar-column-resizer"
              type="button"
              aria-label="Resize feeds column"
              aria-controls="feeds-panel"
              aria-orientation="vertical"
              aria-valuemin="224"
              aria-valuemax="520"
              aria-valuenow="416"
              role="separator"
              data-resizer="sidebar"
            ></button>

            <section class="panel" id="articles-panel">
              <div class="sidebar-top">
                <div class="sidebar-current">
                  <strong id="articles-heading">All items</strong>
                  <p class="status-meta" id="articles-status">Choose a feed to load article previews.</p>
                </div>
              </div>
              <div class="list-shell">
                <ul class="list-reset" id="articles-list"></ul>
                <button class="secondary-button hidden" id="load-more-button" type="button">Load More</button>
              </div>
            </section>

            <button
              class="column-resizer"
              id="stream-column-resizer"
              type="button"
              aria-label="Resize articles column"
              aria-controls="articles-panel"
              aria-orientation="vertical"
              aria-valuemin="288"
              aria-valuemax="640"
              aria-valuenow="524"
              role="separator"
              data-resizer="stream"
            ></button>

            <article class="panel" id="reader-panel">
              <div class="reader-pane-surface">
                <div id="reader-pane-toolbar">
                  <div class="reader-pane-toolbar-copy">
                    <p class="reader-pane-label" id="reader-source-label">Source</p>
                    <p class="reader-pane-note" id="reader-source-note">A plain article view with preserved links.</p>
                  </div>
                  <div class="reader-pane-actions" aria-label="Reader future actions">
                    <button class="toolbar-pill" id="open-original-button" type="button" data-control-tone="subtle" disabled>Open original</button>
                  </div>
                </div>
                <div class="reader-copy">
                  <span class="section-kicker">Reading Pane</span>
                  <h2>Selected article</h2>
                  <strong id="reader-title">Select an article</strong>
                  <p class="panel-note" id="reader-meta">Full article content stays isolated inside the reader frame.</p>
                </div>
                <div class="reader-frame-shell">
                  <iframe id="reader-frame" title="Article content" sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin" srcdoc=""></iframe>
                </div>
              </div>
            </article>
          </div>
        </div>
      </section>

      <aside class="panel hidden" id="settings-panel">
        <h2>
          <span>Settings</span>
          <button class="secondary-button" id="close-settings-button" type="button">Close</button>
        </h2>
        <div class="status-meta" id="settings-content">Open settings to load status.</div>
      </aside>
    </div>
    <script>
      ${runtimeScript}
    </script>
  </body>
</html>`;
}

export function renderBrowserAppRuntimeScript(): string {
	return `
(() => {
  const config = window.__PIGEON_CONFIG__ || {};
  const client = window.__PIGEON_BROWSER_CLIENT__;
  const storageKey = client.AUTH_STORAGE_KEY;
  const themeStorageKey = client.THEME_STORAGE_KEY;
  const columnStorageKey = 'pigeon.browser.column-widths';
  const articleListModeStorageKey = 'pigeon.browser.article-list-mode';
  const loginScreen = document.getElementById('login-screen');
  const readerShell = document.getElementById('reader-shell');
  const readerGrid = document.getElementById('reader-grid');
  const sidebarColumnResizer = document.getElementById('sidebar-column-resizer');
  const streamColumnResizer = document.getElementById('stream-column-resizer');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const passwordInput = document.getElementById('password-input');
  const clearSessionButton = document.getElementById('clear-session-button');
  const logoutButton = document.getElementById('logout-button');
  const themeToggleButton = document.getElementById('theme-toggle-button');
  const articleListModeButton = document.getElementById('article-list-mode-button');
  const settingsButton = document.getElementById('settings-button');
  const settingsPanel = document.getElementById('settings-panel');
  const closeSettingsButton = document.getElementById('close-settings-button');
  const sidebarCurrentTitle = document.getElementById('sidebar-current-title');
  const sidebarCurrentMeta = document.getElementById('sidebar-current-meta');
  const viewsList = document.getElementById('views-list');
  const foldersStatus = document.getElementById('folders-status');
  const foldersList = document.getElementById('folders-list');
  const feedsStatus = document.getElementById('feeds-status');
  const feedsList = document.getElementById('feeds-list');
  const articlesHeading = document.getElementById('articles-heading');
  const articlesStatus = document.getElementById('articles-status');
  const articlesList = document.getElementById('articles-list');
  const loadMoreButton = document.getElementById('load-more-button');
  const readerSourceLabel = document.getElementById('reader-source-label');
  const readerSourceNote = document.getElementById('reader-source-note');
  const openOriginalButton = document.getElementById('open-original-button');
  const readerTitle = document.getElementById('reader-title');
  const readerMeta = document.getElementById('reader-meta');
  const readerFrame = document.getElementById('reader-frame');
  const settingsContent = document.getElementById('settings-content');
  const DEFAULT_COLUMN_WIDTHS = { sidebar: 416, stream: 524 };
  const COLUMN_WIDTH_LIMITS = {
    sidebar: { minimum: 224, maximum: 520 },
    stream: { minimum: 288, maximum: 640 },
    readerMinimum: 320,
    resizerTotal: 16,
  };
  let session = client.createLoggedOutSession();
  let activeValidationId = 0;
  let activeViewRequestId = 0;
  let activeStatusRequestId = 0;
  let activeContentRequestId = 0;
  let views = [];
  let activeViewId = 'all';
  let itemIds = [];
  let nextItemIdsContinuation = '';
  let isLoadingItemIdsPage = false;
  let loadedItemsById = {};
  let inFlightContentIds = [];
  let selectedItemId = null;
  let statusLoaded = false;
  let activeFrameDocument = null;
  let theme = client.normalizeBrowserTheme(null);
  let articleListMode = 'preview';
  let expandedFolderIds = new Set();
  let activeColumnResize = null;
  let appliedColumnWidths = { ...DEFAULT_COLUMN_WIDTHS };

  function getStoredToken() {
    return window.sessionStorage.getItem(storageKey);
  }

  function setStoredToken(token) {
    window.sessionStorage.setItem(storageKey, token);
  }

  function clearStoredToken() {
    window.sessionStorage.removeItem(storageKey);
  }

  function getStoredTheme() {
    try {
      return client.normalizeBrowserTheme(window.localStorage.getItem(themeStorageKey));
    } catch (_error) {
      return 'light';
    }
  }

  function setStoredTheme(nextTheme) {
    try {
      window.localStorage.setItem(themeStorageKey, nextTheme);
    } catch (_error) {
      // Ignore storage failures and keep the in-memory theme.
    }
  }

  function normalizeArticleListMode(value) {
    return value === 'titles' ? 'titles' : 'preview';
  }

  function getStoredArticleListMode() {
    try {
      return normalizeArticleListMode(window.localStorage.getItem(articleListModeStorageKey));
    } catch (_error) {
      return 'preview';
    }
  }

  function setStoredArticleListMode(nextMode) {
    try {
      window.localStorage.setItem(articleListModeStorageKey, normalizeArticleListMode(nextMode));
    } catch (_error) {
      // Ignore storage failures and keep the in-memory article list mode.
    }
  }

  function clampNumber(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }

  function getColumnWidthPropertyName(column) {
    return column === 'sidebar' ? '--sidebar-column-width' : '--stream-column-width';
  }

  function getStoredColumnWidths() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(columnStorageKey) || '{}');
      return {
        sidebar: Number.isFinite(parsed.sidebar) ? parsed.sidebar : null,
        stream: Number.isFinite(parsed.stream) ? parsed.stream : null,
      };
    } catch (_error) {
      return { sidebar: null, stream: null };
    }
  }

  function setStoredColumnWidths(widths) {
    try {
      window.localStorage.setItem(columnStorageKey, JSON.stringify(widths));
    } catch (_error) {
      // Ignore storage failures and keep the visible layout.
    }
  }

  function getReaderGridWidth() {
    if (!readerGrid || typeof readerGrid.getBoundingClientRect !== 'function') {
      return 0;
    }

    return readerGrid.getBoundingClientRect().width || 0;
  }

  function getColumnWidthBudget() {
    const gridWidth = getReaderGridWidth();
    if (!gridWidth) {
      return null;
    }

    return gridWidth - COLUMN_WIDTH_LIMITS.readerMinimum - COLUMN_WIDTH_LIMITS.resizerTotal;
  }

  function getCurrentColumnWidths() {
    const storedWidths = getStoredColumnWidths();
    const sidebarWidth = storedWidths.sidebar ?? DEFAULT_COLUMN_WIDTHS.sidebar;
    const streamWidth = storedWidths.stream ?? DEFAULT_COLUMN_WIDTHS.stream;
    return { sidebar: sidebarWidth, stream: streamWidth };
  }

  function getAppliedColumnWidth(column) {
    if (!readerGrid || !readerGrid.style || typeof readerGrid.style.getPropertyValue !== 'function') {
      return null;
    }

    const value = Number.parseFloat(readerGrid.style.getPropertyValue(getColumnWidthPropertyName(column)));
    return Number.isFinite(value) ? value : null;
  }

  function getVisibleColumnWidths() {
    return {
      sidebar: getAppliedColumnWidth('sidebar') ?? appliedColumnWidths.sidebar,
      stream: getAppliedColumnWidth('stream') ?? appliedColumnWidths.stream,
    };
  }

  function canApplyColumnWidths() {
    return isReaderVisible() && Boolean(getReaderGridWidth());
  }

  function normalizeColumnWidths(widths, preferredColumn) {
    const sidebarMinimum = COLUMN_WIDTH_LIMITS.sidebar.minimum;
    const streamMinimum = COLUMN_WIDTH_LIMITS.stream.minimum;
    const sidebarMaximum = COLUMN_WIDTH_LIMITS.sidebar.maximum;
    const streamMaximum = COLUMN_WIDTH_LIMITS.stream.maximum;
    const widthBudget = getColumnWidthBudget() ?? sidebarMaximum + streamMaximum;

    let sidebarWidth = clampNumber(
      widths.sidebar ?? DEFAULT_COLUMN_WIDTHS.sidebar,
      sidebarMinimum,
      Math.max(sidebarMinimum, Math.min(sidebarMaximum, widthBudget - streamMinimum)),
    );
    let streamWidth = clampNumber(
      widths.stream ?? DEFAULT_COLUMN_WIDTHS.stream,
      streamMinimum,
      Math.max(streamMinimum, Math.min(streamMaximum, widthBudget - sidebarMinimum)),
    );

    const overflow = sidebarWidth + streamWidth - widthBudget;
    if (overflow > 0) {
      if (preferredColumn === 'sidebar') {
        streamWidth = clampNumber(
          streamWidth - overflow,
          streamMinimum,
          Math.max(streamMinimum, Math.min(streamMaximum, widthBudget - sidebarWidth)),
        );
      } else {
        sidebarWidth = clampNumber(
          sidebarWidth - overflow,
          sidebarMinimum,
          Math.max(sidebarMinimum, Math.min(sidebarMaximum, widthBudget - streamWidth)),
        );
      }
    }

    return { sidebar: sidebarWidth, stream: streamWidth };
  }

  function getColumnValueBounds(column) {
    const widthBudget = getColumnWidthBudget();
    if (!widthBudget) {
      return column === 'sidebar'
        ? { minimum: COLUMN_WIDTH_LIMITS.sidebar.minimum, maximum: COLUMN_WIDTH_LIMITS.sidebar.maximum }
        : { minimum: COLUMN_WIDTH_LIMITS.stream.minimum, maximum: COLUMN_WIDTH_LIMITS.stream.maximum };
    }

    if (column === 'sidebar') {
      return {
        minimum: COLUMN_WIDTH_LIMITS.sidebar.minimum,
        maximum: Math.max(
          COLUMN_WIDTH_LIMITS.sidebar.minimum,
          Math.min(COLUMN_WIDTH_LIMITS.sidebar.maximum, widthBudget - COLUMN_WIDTH_LIMITS.stream.minimum),
        ),
      };
    }

    return {
      minimum: COLUMN_WIDTH_LIMITS.stream.minimum,
      maximum: Math.max(
        COLUMN_WIDTH_LIMITS.stream.minimum,
        Math.min(COLUMN_WIDTH_LIMITS.stream.maximum, widthBudget - COLUMN_WIDTH_LIMITS.sidebar.minimum),
      ),
    };
  }

  function updateColumnResizerState(widths) {
    const nextWidths = widths || getVisibleColumnWidths();
    const controls = [
      { column: 'sidebar', handle: sidebarColumnResizer },
      { column: 'stream', handle: streamColumnResizer },
    ];

    for (const control of controls) {
      if (!control.handle || typeof control.handle.setAttribute !== 'function') {
        continue;
      }

      const bounds = getColumnValueBounds(control.column);
      const width = Math.round(nextWidths[control.column]);
      control.handle.setAttribute('aria-valuemin', String(Math.round(bounds.minimum)));
      control.handle.setAttribute('aria-valuemax', String(Math.round(bounds.maximum)));
      control.handle.setAttribute('aria-valuenow', String(width));
      control.handle.setAttribute('aria-valuetext', width + ' pixels');
    }
  }

  function applyColumnWidth(column, width) {
    if (!readerGrid || !readerGrid.style || !Number.isFinite(width)) {
      return;
    }

    readerGrid.style.setProperty(getColumnWidthPropertyName(column), Math.round(width) + 'px');
  }

  function applyColumnWidths(widths, preferredColumn) {
    if (!canApplyColumnWidths()) {
      updateColumnResizerState(widths);
      return null;
    }

    const normalizedWidths = normalizeColumnWidths(widths, preferredColumn);
    applyColumnWidth('sidebar', normalizedWidths.sidebar);
    applyColumnWidth('stream', normalizedWidths.stream);
    appliedColumnWidths = normalizedWidths;
    updateColumnResizerState(normalizedWidths);
    return normalizedWidths;
  }

  function applyStoredColumnWidths() {
    return applyColumnWidths(getCurrentColumnWidths());
  }

  function persistColumnWidths(widths) {
    if (!widths) {
      return;
    }

    setStoredColumnWidths({
      sidebar: Math.round(widths.sidebar),
      stream: Math.round(widths.stream),
    });
  }

  function beginColumnResize(column, event) {
    if (!readerGrid || typeof event.clientX !== 'number' || !canApplyColumnWidths()) {
      return;
    }

    const target = event.currentTarget || event.target;
    const currentWidths = getVisibleColumnWidths();
    const startWidth = currentWidths[column];
    activeColumnResize = {
      column,
      startX: event.clientX,
      startWidth,
      widths: currentWidths,
      handle: target && typeof target.classList !== 'undefined' ? target : null,
    };

    if (activeColumnResize.handle) {
      activeColumnResize.handle.classList.add('is-dragging');
      if (typeof activeColumnResize.handle.setPointerCapture === 'function' && typeof event.pointerId === 'number') {
        activeColumnResize.handle.setPointerCapture(event.pointerId);
      }
    }

    if (typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
  }

  function updateColumnResize(event) {
    if (!activeColumnResize || typeof event.clientX !== 'number') {
      return;
    }

    const nextWidth = activeColumnResize.startWidth + event.clientX - activeColumnResize.startX;
    activeColumnResize.widths = applyColumnWidths(
      {
        ...activeColumnResize.widths,
        [activeColumnResize.column]: nextWidth,
      },
      activeColumnResize.column,
    );

    if (typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
  }

  function endColumnResize() {
    if (!activeColumnResize) {
      return;
    }

    if (activeColumnResize.handle) {
      activeColumnResize.handle.classList.remove('is-dragging');
    }
    persistColumnWidths(activeColumnResize.widths);
    activeColumnResize = null;
  }

  function resizeColumnFromKeyboard(column, event) {
    if (!canApplyColumnWidths()) {
      return;
    }

    const key = event && typeof event.key === 'string' ? event.key : '';
    const direction = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
    const currentWidths = getVisibleColumnWidths();
    const bounds = getColumnValueBounds(column);
    const step = event && event.shiftKey ? 48 : 16;
    let nextWidth = currentWidths[column];

    if (direction) {
      nextWidth += direction * step;
    } else if (key === 'Home') {
      nextWidth = bounds.minimum;
    } else if (key === 'End') {
      nextWidth = bounds.maximum;
    } else {
      return;
    }

    const nextWidths = applyColumnWidths(
      {
        ...currentWidths,
        [column]: nextWidth,
      },
      column,
    );
    persistColumnWidths(nextWidths);

    if (typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
  }

  function wireColumnResizer(handle, column) {
    if (!handle) {
      return;
    }

    handle.addEventListener('pointerdown', (event) => {
      beginColumnResize(column, event);
    });
    handle.addEventListener('keydown', (event) => {
      resizeColumnFromKeyboard(column, event);
    });
  }

  function renderThemeToggle() {
    themeToggleButton.textContent = theme === 'dark' ? 'Dark mode: On' : 'Dark mode: Off';
    themeToggleButton.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
  }

  function renderArticleListModeToggle() {
    articleListModeButton.textContent = articleListMode === 'titles' ? 'Title-only list: On' : 'Title-only list: Off';
    articleListModeButton.setAttribute('aria-pressed', articleListMode === 'titles' ? 'true' : 'false');
  }

  function applyTheme(nextTheme) {
    theme = client.normalizeBrowserTheme(nextTheme);
    document.documentElement.setAttribute('data-theme', theme);
    renderThemeToggle();
  }

  function applyArticleListMode(nextMode) {
    articleListMode = normalizeArticleListMode(nextMode);
    renderArticleListModeToggle();
    renderArticles();
  }

  function startValidation() {
    activeValidationId += 1;
    return activeValidationId;
  }

  function cancelPendingValidation() {
    activeValidationId += 1;
  }

  function isActiveValidation(validationId) {
    return validationId === activeValidationId;
  }

  function cancelViewLoads() {
    activeViewRequestId += 1;
  }

  function cancelContentLoads() {
    activeContentRequestId += 1;
    inFlightContentIds = [];
  }

  function startStatusRequest() {
    activeStatusRequestId += 1;
    return activeStatusRequestId;
  }

  function cancelStatusLoads() {
    activeStatusRequestId += 1;
  }

  function getAuthorizationHeader() {
    return session.token ? { Authorization: 'GoogleLogin auth=pigeon/' + session.token } : {};
  }

  async function authenticatedFetch(input, init) {
    if (!session.token) {
      setLoggedOut('Session expired.');
      throw new Error('Missing session token');
    }

    const response = await fetch(input, {
      ...init,
      headers: {
        ...(init && init.headers ? init.headers : {}),
        ...getAuthorizationHeader(),
      },
    });

    if (response.status === 401) {
      setLoggedOut('Session expired.');
      throw new Error('Unauthorized');
    }

    return response;
  }

  async function authenticatedJson(input, init) {
    const response = await authenticatedFetch(input, init);
    return response.json();
  }

  function addClassNames(element, classNames) {
    for (const className of classNames) {
      if (className) {
        element.classList.add(className);
      }
    }
  }

  function clearElement(element) {
    element.replaceChildren();
  }

  function createNode(tagName, options) {
    const element = document.createElement(tagName);
    if (options && options.classNames) {
      addClassNames(element, options.classNames);
    }
    if (options && Object.prototype.hasOwnProperty.call(options, 'text')) {
      element.textContent = options.text;
    }
    if (options && options.attributes) {
      for (const [name, value] of Object.entries(options.attributes)) {
        element.setAttribute(name, String(value));
      }
    }
    return element;
  }

  function formatTimestamp(timestampSeconds) {
    if (!timestampSeconds) {
      return '';
    }

    return new Date(timestampSeconds * 1000).toLocaleString();
  }

  function getActiveView() {
    return views.find((view) => view.id === activeViewId) || views[0] || null;
  }

  function getFolderViews() {
    return views.filter((view) => view.kind === 'folder');
  }

  function getFeedViews() {
    return views.filter((view) => view.kind === 'feed');
  }

  function getChildFeedViews(folderId) {
    return getFeedViews().filter((view) => view.parentId === folderId);
  }

  function isUnreadFilterActive() {
    const activeView = getActiveView();
    return activeView && activeView.kind === 'unread';
  }

  function isTodayView() {
    const activeView = getActiveView();
    return activeView && activeView.kind === 'today';
  }

  function getVisibleItemIds() {
    return isTodayView()
      ? client.filterItemIdsForLocalDay(itemIds, loadedItemsById)
      : itemIds;
  }

  function hasReachedTodayBoundary() {
    if (!isTodayView()) {
      return false;
    }

    const bounds = client.getLocalDayBounds();
    return Object.values(loadedItemsById).some((item) => {
      const published = item && item.published;
      return typeof published === 'number' && Number.isFinite(published) && published < bounds.startSeconds;
    });
  }

  function shouldShowFeedInSidebar(view) {
    return !isUnreadFilterActive() || view.unreadCount > 0;
  }

  function getVisibleChildFeedViews(folderId) {
    return getChildFeedViews(folderId).filter(shouldShowFeedInSidebar);
  }

  function getParentFolderView(view) {
    const parentId = view && view.parentId;
    if (!parentId) {
      return null;
    }

    return views.find((candidate) => candidate.id === parentId) || null;
  }

  function pruneExpandedFolders() {
    const activeFolderIds = new Set(getFolderViews().map((view) => view.id));
    expandedFolderIds = new Set([...expandedFolderIds].filter((folderId) => activeFolderIds.has(folderId)));
  }

  function formatUnreadCount(unreadCount) {
    return unreadCount >= 0 ? String(unreadCount) : '';
  }

  function isReaderVisible() {
    return session.status === 'authenticated' && !readerShell.classList.contains('hidden');
  }

  function restoreReaderKeyboardFocus() {
    if (!isReaderVisible() || typeof readerShell.focus !== 'function') {
      return;
    }

    readerShell.focus();
  }

  function getNavigationDirectionFromKeyEvent(event) {
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (key !== 'j' && key !== 'k') {
      return 0;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) {
      return 0;
    }

    return key === 'j' ? 1 : -1;
  }

  function isEditableTarget(target) {
    let current = target;
    while (current) {
      const tagName = typeof current.tagName === 'string' ? current.tagName.toLowerCase() : '';
      if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
        return true;
      }

      if (current.isContentEditable) {
        return true;
      }

      if (typeof current.getAttribute === 'function') {
        const contentEditable = current.getAttribute('contenteditable');
        if (contentEditable && contentEditable.toLowerCase() !== 'false') {
          return true;
        }
      }

      current = current.parentElement || null;
    }

    return false;
  }

  function getSelectedItemIndex() {
    const visibleItemIds = getVisibleItemIds();
    return selectedItemId ? visibleItemIds.indexOf(selectedItemId) : -1;
  }

  function moveArticleSelection(direction) {
    if (!isReaderVisible()) {
      return false;
    }

    const selectedIndex = getSelectedItemIndex();
    if (selectedIndex === -1) {
      return false;
    }

    const nextIndex = selectedIndex + direction;
    const visibleItemIds = getVisibleItemIds();
    if (nextIndex < 0 || nextIndex >= visibleItemIds.length) {
      return false;
    }

    void selectArticle(visibleItemIds[nextIndex]);
    return true;
  }

  function handleArticleNavigationKeydown(event) {
    const direction = getNavigationDirectionFromKeyEvent(event);
    if (!direction) {
      return false;
    }

    if (!isReaderVisible() || isEditableTarget(event.target)) {
      return false;
    }

    const moved = moveArticleSelection(direction);
    if (moved && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }

    return moved;
  }

  function detachFrameNavigationListener() {
    if (!activeFrameDocument || typeof activeFrameDocument.removeEventListener !== 'function') {
      activeFrameDocument = null;
      return;
    }

    activeFrameDocument.removeEventListener('keydown', handleArticleNavigationKeydown);
    activeFrameDocument = null;
  }

  function attachFrameNavigationListener() {
    const frameDocument = readerFrame.contentDocument;
    if (!frameDocument || typeof frameDocument.addEventListener !== 'function') {
      return;
    }

    if (frameDocument === activeFrameDocument) {
      if (typeof frameDocument.removeEventListener === 'function') {
        frameDocument.removeEventListener('keydown', handleArticleNavigationKeydown);
      }
    } else {
      detachFrameNavigationListener();
    }
    frameDocument.addEventListener('keydown', handleArticleNavigationKeydown);
    activeFrameDocument = frameDocument;
  }

  function createPendingContentPlan(preferredItemId) {
    if (isTodayView() && hasReachedTodayBoundary()) {
      return [];
    }

    const loadedIds = new Set(Object.keys(loadedItemsById));
    const inFlightIds = new Set(inFlightContentIds);
    const plannedIds = [];
    const targetItemId = preferredItemId || selectedItemId;

    const addId = (itemId) => {
      if (!itemId || loadedIds.has(itemId) || inFlightIds.has(itemId) || plannedIds.includes(itemId) || !itemIds.includes(itemId)) {
        return;
      }
      plannedIds.push(itemId);
    };

    addId(targetItemId);

    for (const itemId of itemIds) {
      addId(itemId);
      if (plannedIds.length >= client.CONTENT_CHUNK_SIZE) {
        break;
      }
    }

    return plannedIds;
  }

  function resetReaderState() {
    cancelViewLoads();
    cancelContentLoads();
    itemIds = [];
    nextItemIdsContinuation = '';
    isLoadingItemIdsPage = false;
    loadedItemsById = {};
    selectedItemId = null;
    clearElement(articlesList);
    loadMoreButton.disabled = false;
    loadMoreButton.classList.add('hidden');
    renderArticles();
    renderReader();
  }

  function setLoggedOut(message) {
    session = client.applyUnauthorizedState(session);
    clearStoredToken();
    cancelPendingValidation();
    resetReaderState();
    detachFrameNavigationListener();
    cancelStatusLoads();
    views = [];
    expandedFolderIds = new Set();
    clearElement(viewsList);
    clearElement(foldersList);
    clearElement(feedsList);
    foldersStatus.textContent = 'Tagged feeds appear here.';
    feedsStatus.textContent = 'Uncategorized feeds appear here after login.';
    sidebarCurrentTitle.textContent = 'All items';
    sidebarCurrentMeta.textContent = 'Choose a stream to load article previews.';
    articlesHeading.textContent = 'All items';
    settingsPanel.classList.add('hidden');
    settingsContent.textContent = 'Open settings to load status.';
    statusLoaded = false;
    loginScreen.classList.remove('hidden');
    readerShell.classList.add('hidden');
    loginError.textContent = message || '';
  }

  function setLoggedIn() {
    loginError.textContent = '';
    loginScreen.classList.add('hidden');
    readerShell.classList.remove('hidden');
    applyStoredColumnWidths();
    restoreReaderKeyboardFocus();
  }

  async function validateToken(token) {
    const response = await fetch('/app/status', {
      headers: {
        Authorization: 'GoogleLogin auth=pigeon/' + token,
      },
    });

    return response.status === 200;
  }

  function createViewButton(view, extraClassNames) {
    const button = createNode('button', {
      classNames: ['list-button', view.id === activeViewId ? 'is-active' : ''].concat(extraClassNames || []),
      attributes: {
        type: 'button',
        'data-view-id': view.id,
      },
    });
    button.addEventListener('click', () => {
      void selectView(view.id);
    });

    const row = createNode('span', { classNames: ['feed-row'] });
    const titleGroup = createNode('span', { classNames: ['feed-title-line'] });
    if (view.iconUrl) {
      const icon = createNode('img', {
        classNames: ['feed-icon'],
        attributes: {
          src: view.iconUrl,
          alt: '',
          width: '16',
          height: '16',
        },
      });
      titleGroup.appendChild(icon);
    }
    titleGroup.appendChild(createNode('span', { classNames: ['feed-title'], text: view.title }));
    row.appendChild(titleGroup);
    row.appendChild(createNode('span', { classNames: ['feed-count'], text: formatUnreadCount(view.unreadCount) }));
    button.appendChild(row);

    if (view.kind === 'folder') {
      const childViews = isUnreadFilterActive() ? getVisibleChildFeedViews(view.id) : getChildFeedViews(view.id);
      button.appendChild(
        createNode('span', {
          classNames: ['feed-meta'],
          text: childViews.length + ' feed' + (childViews.length === 1 ? '' : 's'),
        }),
      );
    }

    return button;
  }

  function createFolderToggleButton(folderView) {
    const isExpanded = expandedFolderIds.has(folderView.id);
    const button = createNode('button', {
      classNames: ['folder-toggle'],
      attributes: {
        type: 'button',
        'aria-expanded': isExpanded ? 'true' : 'false',
        'aria-label': (isExpanded ? 'Collapse ' : 'Expand ') + folderView.title,
        'data-folder-toggle-id': folderView.id,
      },
    });
    button.appendChild(createNode('span', { classNames: ['feed-disclosure'], text: isExpanded ? 'v' : '>' }));
    button.addEventListener('click', () => {
      const nextExpanded = !expandedFolderIds.has(folderView.id);
      if (nextExpanded) {
        expandedFolderIds.add(folderView.id);
        renderFeeds();
        return;
      }

      expandedFolderIds.delete(folderView.id);
      const activeView = getActiveView();
      if (activeView && activeView.parentId === folderView.id) {
        void selectView(folderView.id);
        return;
      }
      renderFeeds();
    });
    return button;
  }

  function renderViewList(targetList, availableViews, options) {
    clearElement(targetList);

    for (const view of availableViews) {
      const listItem = createNode('li');
      listItem.appendChild(createViewButton(view, options && options.child ? ['is-child'] : []));
      targetList.appendChild(listItem);
    }
  }

  function renderFolderList(targetList, folderViews) {
    clearElement(targetList);

    for (const folderView of folderViews) {
      const folderItem = createNode('li', { classNames: ['folder-list-item'] });
      folderItem.appendChild(createFolderToggleButton(folderView));
      folderItem.appendChild(createViewButton(folderView));
      targetList.appendChild(folderItem);

      if (!expandedFolderIds.has(folderView.id)) {
        continue;
      }

      for (const childView of getVisibleChildFeedViews(folderView.id)) {
        const childItem = createNode('li');
        childItem.appendChild(createViewButton(childView, ['is-child']));
        targetList.appendChild(childItem);
      }
    }
  }

  function renderSidebarSummary() {
    const activeView = getActiveView();
    if (!activeView) {
      sidebarCurrentTitle.textContent = 'All items';
      sidebarCurrentMeta.textContent = 'Choose a stream to load article previews.';
      articlesHeading.textContent = 'All items';
      return;
    }

    const parentFolderView = getParentFolderView(activeView);
    const summaryParts = [];
    if (activeView.kind === 'folder') {
      summaryParts.push(getChildFeedViews(activeView.id).length + ' feeds');
    } else if (parentFolderView) {
      summaryParts.push(parentFolderView.title);
    }
    if (activeView.kind === 'unread') {
      summaryParts.push('Unread only');
    } else if (activeView.kind === 'today') {
      summaryParts.push('Received today');
    } else if (activeView.kind === 'recent') {
      summaryParts.push('Read items');
    } else if (activeView.kind === 'all') {
      summaryParts.push('Everything');
    }

    sidebarCurrentTitle.textContent = activeView.title;
    sidebarCurrentMeta.textContent = summaryParts.join(' · ') || 'Choose a stream to load article previews.';
    articlesHeading.textContent = activeView.title;
  }

  function renderFeeds() {
    clearElement(viewsList);
    clearElement(foldersList);
    clearElement(feedsList);
    renderSidebarSummary();

    if (views.length === 0) {
      foldersStatus.textContent = 'Tagged feeds appear here.';
      feedsStatus.textContent = 'Uncategorized feeds appear here after login.';
      return;
    }

    const builtInViews = views.filter((view) => view.section === 'views');
    const unreadOnly = isUnreadFilterActive();
    const folderViews = getFolderViews().filter((view) => !unreadOnly || view.unreadCount > 0);
    const uncategorizedFeedViews = getFeedViews().filter((view) => view.section === 'feeds' && shouldShowFeedInSidebar(view));
    const activeView = getActiveView();
    const activeFolderView =
      activeView?.kind === 'folder' ? activeView : getParentFolderView(activeView);

    renderViewList(viewsList, builtInViews);
    renderFolderList(foldersList, folderViews);
    renderViewList(feedsList, uncategorizedFeedViews);

    if (activeFolderView) {
      foldersStatus.textContent = getVisibleChildFeedViews(activeFolderView.id).length + ' feeds in ' + activeFolderView.title;
    } else {
      foldersStatus.textContent = folderViews.length > 0 ? 'Choose a folder.' : unreadOnly ? 'No tagged feeds with unread items.' : 'No tagged feeds yet.';
    }

    feedsStatus.textContent =
      uncategorizedFeedViews.length > 0 ? 'Uncategorized feeds' : unreadOnly ? 'No uncategorized feeds with unread items.' : 'No uncategorized feeds.';
  }

  function renderArticles() {
    const visibleItemIds = getVisibleItemIds();
    const entries = client.buildArticleListEntries({
      itemIds: visibleItemIds,
      loadedItemsById,
    });

    clearElement(articlesList);

    if (entries.length === 0) {
      const activeView = getActiveView();
      articlesStatus.textContent =
        isTodayView() && (inFlightContentIds.length > 0 || isLoadingItemIdsPage)
          ? 'Loading articles…'
          : activeView
            ? 'No articles in ' + activeView.title + '.'
            : 'Choose a feed to load article previews.';
      loadMoreButton.classList.add('hidden');
      return;
    }

    articlesStatus.textContent = entries.length + ' article' + (entries.length === 1 ? '' : 's');
    for (const entry of entries) {
      const listItem = createNode('li');
      const button = createNode('button', {
        classNames: [
          'article-card',
          entry.id === selectedItemId ? 'is-active' : '',
          articleListMode !== 'titles' && entry.heroImageUrl ? 'has-hero-image' : 'is-text-only',
        ],
        attributes: {
          type: 'button',
          'data-item-id': entry.id,
        },
      });
      button.addEventListener('click', () => {
        void selectArticle(entry.id);
      });

      const cardGrid = createNode('span', { classNames: ['article-card-grid'] });
      const copy = createNode('span', { classNames: ['article-card-copy'] });
      copy.appendChild(createNode('span', { classNames: ['article-title'], text: entry.title }));
      if (articleListMode !== 'titles' && entry.preview) {
        copy.appendChild(createNode('span', { classNames: ['article-preview'], text: entry.preview }));
      }
      if (articleListMode !== 'titles') {
        const metaParts = [entry.feedTitle, formatTimestamp(entry.published)].filter(Boolean);
        if (metaParts.length > 0) {
          copy.appendChild(createNode('span', { classNames: ['article-meta'], text: metaParts.join(' · ') }));
        }
      }
      cardGrid.appendChild(copy);
      if (articleListMode !== 'titles' && entry.heroImageUrl) {
        cardGrid.appendChild(
          createNode('img', {
            classNames: ['article-hero'],
            attributes: {
              src: entry.heroImageUrl,
              alt: '',
              loading: 'lazy',
              'data-card-hero': 'true',
            },
          }),
        );
      }
      button.appendChild(cardGrid);
      listItem.appendChild(button);
      articlesList.appendChild(listItem);
    }

    const pendingPlan = createPendingContentPlan(selectedItemId);
    loadMoreButton.disabled = inFlightContentIds.length > 0 || isLoadingItemIdsPage;
    const todayCanLoadMore = !isTodayView() || !hasReachedTodayBoundary();
    loadMoreButton.classList.toggle(
      'hidden',
      !todayCanLoadMore || (pendingPlan.length === 0 && !nextItemIdsContinuation),
    );
  }

  function renderReader() {
    if (!selectedItemId) {
      readerSourceLabel.textContent = 'Source';
      readerSourceNote.textContent = 'A plain article view with preserved links.';
      openOriginalButton.disabled = true;
      openOriginalButton.setAttribute('data-href', '');
      readerTitle.textContent = 'Select an article';
      readerMeta.textContent = 'Full article content stays isolated inside the reader frame.';
      readerFrame.srcdoc = client.createArticleFrameDocument('', theme);
      return;
    }

    const item = loadedItemsById[selectedItemId];
    if (!item) {
      readerSourceLabel.textContent = 'Source';
      readerSourceNote.textContent = 'Loading article details.';
      openOriginalButton.disabled = true;
      openOriginalButton.setAttribute('data-href', '');
      readerTitle.textContent = 'Loading article…';
      readerMeta.textContent = 'Loading the full article body.';
      readerFrame.srcdoc = client.createArticleFrameDocument('<p class="pigeon-empty">Loading article content…</p>', theme);
      return;
    }

    const articleHref =
      item.alternate && item.alternate[0] && item.alternate[0].href ? item.alternate[0].href : '';
    const activeView = getActiveView();
    const sourceTitle = item.origin && item.origin.title ? item.origin.title : 'Source';
    const sourceNoteParts = [
      activeView && activeView.kind === 'folder' ? activeView.title : '',
      formatTimestamp(item.published),
    ].filter(Boolean);

    readerSourceLabel.textContent = sourceTitle;
    readerSourceNote.textContent = sourceNoteParts.join(' · ') || 'A plain article view with preserved links.';
    openOriginalButton.disabled = !articleHref;
    openOriginalButton.setAttribute('data-href', articleHref);
    readerTitle.textContent = item.title || 'Untitled article';
    readerMeta.textContent = [item.origin && item.origin.title ? item.origin.title : '', formatTimestamp(item.published)]
      .filter(Boolean)
      .join(' · ');
    readerFrame.srcdoc = client.createArticleFrameDocument(
      item.content && item.content.content ? item.content.content : '',
      theme,
    );
    attachFrameNavigationListener();
  }

  async function loadStatus() {
    const requestId = startStatusRequest();
    const requestToken = session.token;
    settingsContent.textContent = 'Loading status…';
    try {
      const status = await authenticatedJson('/app/status');
      if (requestId !== activeStatusRequestId || session.token !== requestToken || session.status !== 'authenticated') {
        return;
      }

      statusLoaded = true;
      const definitionList = createNode('dl');
      const appendStatusRow = (label, value) => {
        definitionList.appendChild(createNode('dt', { text: label }));
        definitionList.appendChild(createNode('dd', { text: value == null || value === '' ? 'Unknown' : String(value) }));
      };

      appendStatusRow('Configured BASE_URL', status.configuredBaseUrl);
      appendStatusRow('Current origin', status.currentOrigin);
      appendStatusRow('Health URL', status.healthUrl);
      appendStatusRow('Schema version', status.schemaVersion);
      appendStatusRow('Active feeds', status.feeds.activeCount);
      appendStatusRow('Email feeds', status.feeds.emailCount);
      appendStatusRow('RSS feeds', status.feeds.rssCount);
      appendStatusRow('Failing RSS feed count', status.feeds.failingRssCount);
      appendStatusRow('Total items', status.items.totalCount);
      appendStatusRow('Unread items', status.items.unreadCount);
      appendStatusRow('Starred items', status.items.starredCount);
      appendStatusRow('Newest item', status.items.newestAt);
      appendStatusRow('Newest email item', status.items.newestEmailAt);
      appendStatusRow('Newest RSS item', status.items.newestRssAt);
      appendStatusRow('Latest RSS fetch', status.rss.latestFetchAttemptAt);
      appendStatusRow(
        'Failing RSS feeds',
        status.feeds.failing.length > 0
          ? status.feeds.failing.map((feed) => feed.title + ': ' + feed.error).join(' | ')
          : 'None',
      );

      settingsContent.replaceChildren(definitionList);
    } catch (_error) {
      if (requestId === activeStatusRequestId && session.token === requestToken && session.status === 'authenticated') {
        settingsContent.textContent = 'Could not load status.';
      }
    }
  }

  function buildStreamIdsUrl(view, continuation) {
    const params = new URLSearchParams();
    params.set('s', view.streamId);
    params.set('n', String(client.INITIAL_ITEM_ID_LIMIT));
    if (view.kind === 'unread') {
      params.set('xt', 'user/-/state/com.google/read');
    }
    if (continuation) {
      params.set('c', continuation);
    }
    return '/reader/api/0/stream/items/ids?' + params.toString();
  }

  function shouldContinueLoadingToday() {
    if (!isTodayView() || hasReachedTodayBoundary()) {
      return false;
    }

    return createPendingContentPlan(null).length > 0 || Boolean(nextItemIdsContinuation);
  }

  async function continueLoadingToday(requestId) {
    if (requestId !== activeViewRequestId || !shouldContinueLoadingToday()) {
      return;
    }

    const pendingPlan = createPendingContentPlan(null);
    if (pendingPlan.length > 0) {
      await loadContentChunk(pendingPlan[0], requestId);
      return;
    }

    await loadNextItemIdsPage(requestId);
  }

  async function loadContentChunk(preferredItemId, requestId) {
    const plan = createPendingContentPlan(preferredItemId);

    if (plan.length === 0) {
      renderArticles();
      renderReader();
      return;
    }

    const contentRequestId = activeContentRequestId + 1;
    activeContentRequestId = contentRequestId;
    inFlightContentIds = plan;
    renderArticles();

    const form = new FormData();
    for (const itemId of plan) {
      form.append('i', itemId);
    }

    const loadedItemCountBefore = Object.keys(loadedItemsById).length;
    try {
      const payload = await authenticatedJson('/reader/api/0/stream/items/contents', {
        method: 'POST',
        body: form,
      });
      if (requestId !== activeViewRequestId || contentRequestId !== activeContentRequestId) {
        return;
      }

      for (const item of payload.items || []) {
        loadedItemsById[client.normalizeBrowserItemId(item.id)] = item;
      }

      inFlightContentIds = [];
      const visibleItemIds = getVisibleItemIds();
      if (isTodayView() && (!selectedItemId || !visibleItemIds.includes(selectedItemId))) {
        selectedItemId = visibleItemIds[0] || null;
      }
      renderArticles();
      renderReader();
      if (
        isTodayView() &&
        Object.keys(loadedItemsById).length > loadedItemCountBefore &&
        shouldContinueLoadingToday()
      ) {
        await continueLoadingToday(requestId);
      }
    } catch (_error) {
      if (requestId === activeViewRequestId && contentRequestId === activeContentRequestId) {
        inFlightContentIds = [];
      }
      if (requestId === activeViewRequestId && contentRequestId === activeContentRequestId && session.token) {
        articlesStatus.textContent = 'Could not load article bodies.';
      }
      renderArticles();
    }
  }

  async function loadNextItemIdsPage(requestId) {
    const activeView = getActiveView();
    const continuation = nextItemIdsContinuation;
    if (!activeView || !continuation || isLoadingItemIdsPage || (isTodayView() && hasReachedTodayBoundary())) {
      return;
    }

    isLoadingItemIdsPage = true;
    renderArticles();

    try {
      const payload = await authenticatedJson(buildStreamIdsUrl(activeView, continuation));
      if (requestId !== activeViewRequestId) {
        return;
      }

      const knownIds = new Set(itemIds);
      const appendedIds = [];
      for (const itemRef of payload.itemRefs || []) {
        const itemId = String(itemRef.id);
        if (!knownIds.has(itemId)) {
          knownIds.add(itemId);
          appendedIds.push(itemId);
        }
      }

      itemIds.push(...appendedIds);
      const returnedContinuation = payload.continuation ? String(payload.continuation) : '';
      nextItemIdsContinuation =
        returnedContinuation && (appendedIds.length > 0 || returnedContinuation !== continuation)
          ? returnedContinuation
          : '';
      isLoadingItemIdsPage = false;
      renderArticles();

      if (appendedIds.length > 0) {
        await loadContentChunk(appendedIds[0], requestId);
      } else if (isTodayView()) {
        await continueLoadingToday(requestId);
      }
    } catch (_error) {
      if (requestId !== activeViewRequestId) {
        return;
      }
      isLoadingItemIdsPage = false;
      renderArticles();
      if (session.token) {
        articlesStatus.textContent = 'Could not load more articles.';
      }
    }
  }

  async function loadActiveView() {
    const activeView = getActiveView();
    if (!activeView) {
      resetReaderState();
      return;
    }

    const requestId = activeViewRequestId + 1;
    activeViewRequestId = requestId;
    cancelContentLoads();
    itemIds = [];
    nextItemIdsContinuation = '';
    isLoadingItemIdsPage = false;
    loadedItemsById = {};
    selectedItemId = null;
    articlesStatus.textContent = 'Loading articles…';
    clearElement(articlesList);
    loadMoreButton.classList.add('hidden');
    renderFeeds();
    renderReader();

    try {
      const payload = await authenticatedJson(buildStreamIdsUrl(activeView, ''));
      if (requestId !== activeViewRequestId) {
        return;
      }

      itemIds = [...new Set((payload.itemRefs || []).map((itemRef) => String(itemRef.id)))];
      nextItemIdsContinuation = payload.continuation ? String(payload.continuation) : '';
      selectedItemId = isTodayView() ? null : itemIds[0] || null;
      renderArticles();
      renderReader();

      if (itemIds.length > 0) {
        await loadContentChunk(isTodayView() ? null : selectedItemId, requestId);
      }
    } catch (_error) {
      if (requestId === activeViewRequestId && session.token) {
        articlesStatus.textContent = 'Could not load this view.';
      }
    }
  }

  async function loadSubscriptionsAndUnreadCounts() {
    feedsStatus.textContent = 'Loading feeds…';

    try {
      const [subscriptionPayload, unreadPayload] = await Promise.all([
        authenticatedJson('/reader/api/0/subscription/list'),
        authenticatedJson('/reader/api/0/unread-count'),
      ]);
      views = client.buildFeedViews(subscriptionPayload.subscriptions || [], unreadPayload.unreadcounts || []);
      pruneExpandedFolders();
      if (!views.some((view) => view.id === activeViewId)) {
        activeViewId = 'all';
      }
      renderFeeds();
      await loadActiveView();
    } catch (_error) {
      if (session.token) {
        feedsStatus.textContent = 'Could not load feeds.';
      }
    }
  }

  async function selectView(viewId) {
    if (viewId === activeViewId) {
      return;
    }

    const nextView = views.find((view) => view.id === viewId) || null;
    if (nextView && nextView.parentId) {
      expandedFolderIds.add(nextView.parentId);
    }

    activeViewId = viewId;
    await loadActiveView();
  }

  async function selectArticle(itemId) {
    if (!getVisibleItemIds().includes(itemId)) {
      return;
    }

    selectedItemId = itemId;
    renderArticles();
    renderReader();
    if (!loadedItemsById[itemId]) {
      await loadContentChunk(itemId, activeViewRequestId);
    }
  }

  async function restoreOrBootstrapReader() {
    renderFeeds();
    renderArticles();
    renderReader();
    await loadSubscriptionsAndUnreadCounts();
  }

  async function login(password) {
    const form = new FormData();
    form.set('Passwd', password);

    let response;
    try {
      response = await fetch('/accounts/ClientLogin', {
        method: 'POST',
        body: form,
      });
    } catch (_error) {
      setLoggedOut('Could not reach the server.');
      return false;
    }

    if (!response.ok) {
      setLoggedOut('Incorrect password.');
      return false;
    }

    const text = await response.text();
    const token = client.extractAuthToken(text);
    if (!token) {
      setLoggedOut('Could not start a session.');
      return false;
    }

    session = client.createSessionFromToken(token);
    cancelPendingValidation();
    setStoredToken(token);
    setLoggedIn();
    void restoreOrBootstrapReader();
    return true;
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const ok = await login(passwordInput.value);
    if (ok) {
      passwordInput.value = '';
    }
  });

  logoutButton.addEventListener('click', () => {
    setLoggedOut('');
  });

  clearSessionButton.addEventListener('click', () => {
    setLoggedOut('Saved session cleared. Sign in again.');
    passwordInput.focus();
  });

  themeToggleButton.addEventListener('click', () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(nextTheme);
    setStoredTheme(nextTheme);
    renderReader();
  });

  articleListModeButton.addEventListener('click', () => {
    const nextMode = articleListMode === 'titles' ? 'preview' : 'titles';
    applyArticleListMode(nextMode);
    setStoredArticleListMode(nextMode);
  });

  settingsButton.addEventListener('click', () => {
    const isHidden = settingsPanel.classList.toggle('hidden');
    if (!isHidden && !statusLoaded) {
      void loadStatus();
    }
  });

  closeSettingsButton.addEventListener('click', () => {
    settingsPanel.classList.add('hidden');
  });

  openOriginalButton.addEventListener('click', () => {
    const href = openOriginalButton.getAttribute('data-href');
    if (!href || openOriginalButton.disabled || typeof window.open !== 'function') {
      return;
    }
    window.open(href, '_blank', 'noopener');
  });

  loadMoreButton.addEventListener('click', () => {
    if (inFlightContentIds.length > 0 || isLoadingItemIdsPage) {
      return;
    }
    if (createPendingContentPlan(selectedItemId).length > 0) {
      void loadContentChunk(selectedItemId, activeViewRequestId);
      return;
    }
    void loadNextItemIdsPage(activeViewRequestId);
  });

  readerFrame.addEventListener('load', () => {
    attachFrameNavigationListener();
  });

  document.addEventListener('keydown', (event) => {
    handleArticleNavigationKeydown(event);
  });

  document.addEventListener('pointermove', (event) => {
    updateColumnResize(event);
  });

  document.addEventListener('pointerup', () => {
    endColumnResize();
  });

  document.addEventListener('pointercancel', () => {
    endColumnResize();
  });

  wireColumnResizer(sidebarColumnResizer, 'sidebar');
  wireColumnResizer(streamColumnResizer, 'stream');
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('resize', () => {
      if (isReaderVisible()) {
        applyStoredColumnWidths();
      }
    });
  }

  if (config.baseUrl) {
    document.documentElement.setAttribute('data-base-url', config.baseUrl);
  }

  applyTheme(getStoredTheme());
  applyArticleListMode(getStoredArticleListMode());
  updateColumnResizerState();

  const existingToken = getStoredToken();
  if (existingToken) {
    session = client.createSessionFromToken(existingToken);
    const validationId = startValidation();
    validateToken(existingToken).then((isValid) => {
      if (!isActiveValidation(validationId)) {
        return;
      }

      if (isValid) {
        setLoggedIn();
        void restoreOrBootstrapReader();
      } else if (loginError.textContent === '') {
        setLoggedOut('');
      }
    }).catch(() => {
      if (!isActiveValidation(validationId)) {
        return;
      }

      setLoggedOut('Could not restore session.');
    });
  } else {
    setLoggedOut('');
  }
})();
`.trim();
}

function renderBrowserAppThemeBootstrapScript(): string {
	return `
(() => {
  try {
    const storedTheme = window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    document.documentElement.setAttribute('data-theme', storedTheme === 'dark' ? 'dark' : 'light');
  } catch (_error) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
`.trim();
}


function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function escapeScript(value: string): string {
	return value.replace(/</g, '\\u003c');
}
