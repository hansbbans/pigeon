// Visual layer for the browser reader. Quiet, Reeder-style: three hairline-separated
// columns, icon-only toolbars, one muted accent, and a neutral graphite dark mode.

const ICON_PATHS: Record<string, string> = {
	search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
	check: '<circle cx="12" cy="12" r="8.5"/><path d="M8.2 12.4l2.6 2.6 5-5.4"/>',
	'check-filled': '<circle cx="12" cy="12" r="9" fill="black" stroke="none"/><path d="M8.2 12.4l2.6 2.6 5-5.4" stroke="white"/>',
	'check-all': '<path d="M3.5 12.5l4 4 8-9"/><path d="M12 15.5l1 1 8-9"/>',
	star: '<path d="M12 3.8l2.5 5.1 5.6.8-4.05 3.95.96 5.6L12 16.6l-5.01 2.65.96-5.6L3.9 9.7l5.6-.8z"/>',
	'star-filled': '<path fill="black" d="M12 3.8l2.5 5.1 5.6.8-4.05 3.95.96 5.6L12 16.6l-5.01 2.65.96-5.6L3.9 9.7l5.6-.8z"/>',
	share: '<path d="M12 14.5V4M8 7.8L12 4l4 3.8"/><path d="M6.5 11H5.5v9h13v-9h-1"/>',
	open: '<path d="M13.5 4.5h6v6M19.5 4.5l-8.5 8.5"/><path d="M17.5 14v5.5h-13v-13H10"/>',
	more: '<circle cx="5.5" cy="12" r="1.1" fill="black"/><circle cx="12" cy="12" r="1.1" fill="black"/><circle cx="18.5" cy="12" r="1.1" fill="black"/>',
	undo: '<path d="M9 7.5L5 11.5l4 4"/><path d="M5 11.5h9.5a4.5 4.5 0 010 9H12"/>',
	sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
	back: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
	chevron: '<path d="M9.5 6.5l5.5 5.5-5.5 5.5"/>',
	gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7.4 7.4 0 01-1.9 1.1L15 20.5h-4l-.3-2a7.4 7.4 0 01-1.9-1.1l-1.9.7-2-3.4 1.6-1.2a7.6 7.6 0 010-2.2L4.9 10.1l2-3.4 1.9.7a7.4 7.4 0 011.9-1.1l.3-2h4l.3 2a7.4 7.4 0 011.9 1.1l1.9-.7 2 3.4-1.6 1.2a7.6 7.6 0 010 2.2z"/>',
	library: '<path d="M4.5 4.5h4v15h-4zM10 4.5h4v15h-4z"/><path d="M15.6 5.3l3.7-.9 3 14.4-3.7.9z"/>',
	moon: '<path d="M19.5 14.6A7.5 7.5 0 019.4 4.5a7.5 7.5 0 1010.1 10.1z"/>',
	sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4"/>',
	logout: '<path d="M14 4.5H5.5v15H14"/><path d="M10.5 12h10M17 8.5l3.5 3.5-3.5 3.5"/>',
	refresh: '<path d="M19.5 12a7.5 7.5 0 11-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
	close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
	inbox: '<path d="M4.5 13l2.4-7.5h10.2L19.5 13v5.5h-15z"/><path d="M4.5 13h4.5l1 2h4l1-2h4.5"/>',
	unread: '<circle cx="12" cy="12" r="7.5"/>',
	today: '<rect x="4.5" y="5.5" width="15" height="14" rx="2"/><path d="M4.5 10h15M8.5 3.5v3M15.5 3.5v3"/>',
	recent: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
	sparkle: '<path d="M12 4l1.8 4.9L18.5 10.5l-4.7 1.7L12 17l-1.8-4.8-4.7-1.7 4.7-1.6z"/><path d="M18.5 16v4M16.5 18h4"/>',
	folder: '<path d="M3.5 7a1.5 1.5 0 011.5-1.5h4.2l2 2.2H19a1.5 1.5 0 011.5 1.5v8.3A1.5 1.5 0 0119 19H5a1.5 1.5 0 01-1.5-1.5z"/>',
};

function iconUrl(name: string): string {
	const svg =
		`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'>${ICON_PATHS[name].replace(/"/g, "'")}</svg>`;
	return `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, '%27')}")`;
}

function iconVariables(): string {
	return Object.keys(ICON_PATHS)
		.map((name) => `        --icon-${name}: ${iconUrl(name)};`)
		.join('\n');
}

export function renderBrowserAppStyles(): string {
	return `
      :root {
        color-scheme: light;
        --page: #ffffff;
        --sidebar: #f5f5f6;
        --list: #ffffff;
        --surface: #ffffff;
        --surface-raised: #ffffff;
        --hover: #f0f0f2;
        --selected: #ebebee;
        --sidebar-selected: #e3e3e7;
        --border: #e4e4e7;
        --hairline: #efeff1;
        --text: #1c1c1e;
        --text-secondary: #636366;
        --muted: #8e8e93;
        --accent: #3466b0;
        --accent-soft: rgba(52, 102, 176, 0.12);
        --star: #e3a008;
        --danger: #c4382b;
        --frame: #ffffff;
        --scrim: rgba(0, 0, 0, 0.18);
        --shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 12px 40px rgba(0, 0, 0, 0.12);
        --radius: 8px;
        --font: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'Helvetica Neue', sans-serif;
${iconVariables()}
      }

      html[data-theme="dark"] {
        color-scheme: dark;
        --page: #1f1f21;
        --sidebar: #19191b;
        --list: #1c1c1e;
        --surface: #1f1f21;
        --surface-raised: #2a2a2d;
        --hover: #262629;
        --selected: #2c2c2f;
        --sidebar-selected: #2e2e31;
        --border: #2e2e31;
        --hairline: #262628;
        --text: #e8e8ea;
        --text-secondary: #a1a1a6;
        --muted: #7c7c82;
        --accent: #8fb3e8;
        --accent-soft: rgba(143, 179, 232, 0.16);
        --star: #f0b429;
        --danger: #ff8a7a;
        --frame: #1f1f21;
        --scrim: rgba(0, 0, 0, 0.45);
        --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 16px 48px rgba(0, 0, 0, 0.5);
      }

      * { box-sizing: border-box; }

      html { background: var(--page); }

      body {
        margin: 0;
        min-height: 100vh;
        font: 14px/1.45 var(--font);
        color: var(--text);
        background: var(--page);
        -webkit-font-smoothing: antialiased;
      }

      button, input, select, textarea { font: inherit; color: inherit; }

      a { color: var(--accent); }

      .hidden { display: none !important; }

      /* Plain controls: quiet outlines, no fills. */
      button {
        border: 1px solid var(--border);
        border-radius: 7px;
        background: transparent;
        color: var(--text);
        cursor: pointer;
        padding: 0.4rem 0.8rem;
        font-size: 0.875rem;
        line-height: 1.3;
        transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
      }

      button:hover { background: var(--hover); }

      button[disabled] { cursor: default; opacity: 0.45; }
      button[disabled]:hover { background: transparent; }

      button:focus-visible, summary:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 1px;
      }

      button[type="submit"], .primary-button {
        background: var(--text);
        border-color: var(--text);
        color: var(--page);
      }

      button[type="submit"]:hover, .primary-button:hover {
        background: var(--text);
        opacity: 0.88;
      }

      input:not([type="checkbox"]):not([type="radio"]), select, textarea {
        width: 100%;
        padding: 0.45rem 0.65rem;
        border: 1px solid var(--border);
        border-radius: 7px;
        background: var(--surface);
        color: var(--text);
        font-size: 0.875rem;
      }

      select { width: auto; max-width: 100%; }

      input[type="checkbox"], input[type="radio"] { accent-color: var(--accent); }

      summary { cursor: pointer; }

      /* Icon buttons: the label stays in the DOM for assistive tech, the glyph is a mask. */
      .icon-button {
        width: 2rem;
        height: 2rem;
        flex: none;
        display: inline-grid;
        place-items: center;
        padding: 0;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: var(--muted);
        font-size: 0;
        line-height: 0;
        list-style: none;
      }

      .icon-button::-webkit-details-marker { display: none; }

      .icon-button::before {
        content: "";
        width: 1.15rem;
        height: 1.15rem;
        background: currentColor;
        -webkit-mask: var(--icon) center / contain no-repeat;
        mask: var(--icon) center / contain no-repeat;
      }

      .icon-button:hover { background: var(--hover); color: var(--text); }
      .icon-button[disabled]:hover { background: transparent; color: var(--muted); }
      .icon-button[aria-busy="true"] { animation: pigeon-pulse 900ms ease-in-out infinite alternate; }

      @keyframes pigeon-pulse { from { opacity: 1; } to { opacity: 0.35; } }

      [data-icon="search"] { --icon: var(--icon-search); }
      [data-icon="check"] { --icon: var(--icon-check); }
      [data-icon="check-all"] { --icon: var(--icon-check-all); }
      [data-icon="star"] { --icon: var(--icon-star); }
      [data-icon="share"] { --icon: var(--icon-share); }
      [data-icon="open"] { --icon: var(--icon-open); }
      [data-icon="more"] { --icon: var(--icon-more); }
      [data-icon="undo"] { --icon: var(--icon-undo); }
      [data-icon="sidebar"] { --icon: var(--icon-sidebar); }
      [data-icon="back"] { --icon: var(--icon-back); }
      [data-icon="gear"] { --icon: var(--icon-gear); }
      [data-icon="library"] { --icon: var(--icon-library); }
      [data-icon="logout"] { --icon: var(--icon-logout); }
      [data-icon="refresh"] { --icon: var(--icon-refresh); }
      [data-icon="close"] { --icon: var(--icon-close); }
      [data-icon="theme"] { --icon: var(--icon-moon); }
      [data-icon="theme"][aria-pressed="true"] { --icon: var(--icon-sun); }

      #mark-unread-button[data-read="true"] { --icon: var(--icon-check-filled); color: var(--text-secondary); }
      #star-article-button[aria-pressed="true"] { --icon: var(--icon-star-filled); color: var(--star); }

      /* Sign in */
      #app { min-height: 100vh; }

      .login-shell {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 2rem 1rem;
        background: var(--sidebar);
      }

      .login-card {
        width: min(22rem, 100%);
        padding: 2rem 1.75rem 1.5rem;
        border: 1px solid var(--border);
        border-radius: 14px;
        background: var(--surface);
        box-shadow: var(--shadow);
      }

      .login-card h1 { margin: 0 0 0.35rem; font-size: 1.35rem; font-weight: 650; letter-spacing: -0.01em; }
      .login-card > p { margin: 0; color: var(--text-secondary); }

      .login-server {
        display: flex;
        justify-content: space-between;
        gap: 0.75rem;
        margin-top: 1.25rem;
        color: var(--muted);
        font-size: 0.8rem;
      }

      .login-server strong { min-width: 0; overflow-wrap: anywhere; text-align: right; font-weight: 500; color: var(--text-secondary); }

      #login-form { display: grid; gap: 0.75rem; margin-top: 1rem; }
      .login-field { display: grid; gap: 0.35rem; }
      .login-field-label { font-size: 0.8rem; font-weight: 600; color: var(--text-secondary); }
      .login-help { margin: 0; color: var(--muted); font-size: 0.8rem; line-height: 1.45; }
      .login-help strong { font-weight: 600; color: var(--text-secondary); }
      #login-button { padding: 0.55rem; }
      #login-error { min-height: 1.1rem; color: var(--danger); font-size: 0.85rem; }

      .session-recovery { display: grid; gap: 0.5rem; margin-top: 0.5rem; padding-top: 1rem; border-top: 1px solid var(--hairline); }
      #clear-session-button { justify-self: start; border: 0; padding: 0; color: var(--muted); font-size: 0.8rem; text-decoration: underline; }
      #clear-session-button:hover { background: none; color: var(--text); }

      /* Reader shell: three columns that fill the window. */
      .reader-shell { height: 100dvh; }
      .reader-shell:focus { outline: none; }
      .reader-window { height: 100%; display: flex; flex-direction: column; }

      .reader-grid {
        --sidebar-column-width: 224px;
        --stream-column-width: 340px;
        flex: 1 1 auto;
        min-height: 0;
        display: grid;
        grid-template-columns:
          minmax(14rem, var(--sidebar-column-width))
          0
          minmax(18rem, var(--stream-column-width))
          0
          minmax(0, 1fr);
        grid-template-areas: "sidebar sidebar-resizer stream stream-resizer reader";
      }

      .reader-grid.is-sidebar-collapsed {
        grid-template-columns: 0 0 minmax(18rem, var(--stream-column-width)) 0 minmax(0, 1fr);
      }

      .reader-grid.is-sidebar-collapsed #feeds-panel,
      .reader-grid.is-sidebar-collapsed #sidebar-column-resizer { visibility: hidden; }

      .panel { min-width: 0; min-height: 0; display: flex; flex-direction: column; }

      #feeds-panel { grid-area: sidebar; background: var(--sidebar); border-right: 1px solid var(--border); overflow: hidden; }
      #articles-panel { grid-area: stream; background: var(--list); border-right: 1px solid var(--border); }
      #reader-panel { grid-area: reader; background: var(--page); }

      .column-resizer {
        position: relative;
        z-index: 3;
        width: 0;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: none;
        cursor: col-resize;
        touch-action: none;
      }

      .column-resizer::before {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: -4px;
        width: 8px;
      }

      .column-resizer:hover, .column-resizer.is-dragging { background: none; }
      .column-resizer:hover::before, .column-resizer.is-dragging::before { background: linear-gradient(90deg, transparent 3px, var(--accent) 3px, var(--accent) 5px, transparent 5px); }
      .column-resizer:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; }
      .column-resizer[data-resizer="sidebar"] { grid-area: sidebar-resizer; }
      .column-resizer[data-resizer="stream"] { grid-area: stream-resizer; }

      .list-reset { margin: 0; padding: 0; list-style: none; }

      /* Sidebar */
      .sidebar-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        padding: 0.9rem 0.75rem 0.5rem 1.1rem;
      }

      .sidebar-brand { margin: 0; font-size: 0.95rem; font-weight: 650; letter-spacing: -0.005em; }

      .sidebar-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 0 0.5rem 1rem; }

      .sidebar-current { display: none; }

      .sidebar-section + .sidebar-section { margin-top: 0.9rem; }

      .pane-header { padding: 0 0.6rem 0.25rem; }

      .pane-header h2 {
        margin: 0;
        color: var(--muted);
        font-size: 0.7rem;
        font-weight: 600;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }

      .pane-header .status-meta { display: none; }

      #real-views-section .pane-header { display: none; }

      .sidebar-section:has(> .list-shell > .list-reset:empty) { display: none; }

      .list-button {
        width: 100%;
        display: block;
        margin: 1px 0;
        padding: 0.32rem 0.6rem;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: var(--text);
        text-align: left;
        font-size: 0.85rem;
      }

      .list-button:hover { background: var(--hover); }
      .list-button.is-active, .list-button.is-active:hover { background: var(--sidebar-selected); }
      .list-button.is-child { padding-left: 1.85rem; }

      .feed-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
      .feed-title-line { display: flex; align-items: center; gap: 0.55rem; min-width: 0; }

      .feed-title {
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        font-weight: 400;
      }

      .list-button.is-active .feed-title { font-weight: 500; }

      .feed-icon { width: 16px; height: 16px; flex: none; border-radius: 4px; object-fit: cover; }

      .list-button[data-view-kind] .feed-title-line::before {
        content: "";
        width: 16px;
        height: 16px;
        flex: none;
        background: var(--text-secondary);
        -webkit-mask: var(--icon) center / contain no-repeat;
        mask: var(--icon) center / contain no-repeat;
      }

      .list-button[data-view-kind="feed"] .feed-title-line::before,
      .list-button[data-view-kind="folder"] .feed-title-line::before { display: none; }

      .list-button[data-view-kind="feed"] .feed-title-line:not(:has(.feed-icon))::before {
        display: block;
        border-radius: 4px;
        background: var(--border);
        -webkit-mask: none;
        mask: none;
      }

      .list-button[data-view-kind="all"] { --icon: var(--icon-inbox); }
      .list-button[data-view-kind="unread"] { --icon: var(--icon-unread); }
      .list-button[data-view-kind="today"] { --icon: var(--icon-today); }
      .list-button[data-view-kind="recent"] { --icon: var(--icon-recent); }
      .list-button[data-view-kind="starred"] { --icon: var(--icon-star); }
      .list-button[data-view-kind="recommended"] { --icon: var(--icon-sparkle); }

      .feed-count {
        flex: none;
        color: var(--muted);
        font-size: 0.75rem;
        font-variant-numeric: tabular-nums;
      }

      .feed-meta { display: none; }

      .folder-list-item { display: flex; align-items: center; }
      .folder-list-item > .list-button { flex: 1 1 auto; min-width: 0; padding-left: 0.15rem; }

      .folder-toggle {
        width: 1.45rem;
        height: 1.6rem;
        flex: none;
        display: grid;
        place-items: center;
        padding: 0;
        border: 0;
        border-radius: 5px;
        background: transparent;
        color: var(--muted);
      }

      .folder-toggle:hover { background: var(--hover); color: var(--text); }

      .feed-disclosure {
        width: 10px;
        height: 10px;
        background: currentColor;
        -webkit-mask: var(--icon-chevron) center / contain no-repeat;
        mask: var(--icon-chevron) center / contain no-repeat;
        transition: transform 160ms ease;
      }

      .folder-toggle[aria-expanded="true"] .feed-disclosure { transform: rotate(90deg); }

      @media (prefers-reduced-motion: reduce) { .feed-disclosure { transition: none; } }

      .sidebar-footer {
        display: flex;
        gap: 0.15rem;
        padding: 0.45rem 0.6rem;
        border-top: 1px solid var(--border);
      }

      .sidebar-footer #logout-button { margin-left: auto; }
      .sidebar-footer #logout-button:hover { color: var(--danger); }

      /* Article list */
      .stream-header { flex: none; padding: 0.75rem 0.6rem 0.4rem 1.1rem; }

      .stream-title-row { display: flex; align-items: center; gap: 0.25rem; min-height: 2rem; }
      .stream-title-row .sidebar-current { display: block; flex: 1 1 auto; min-width: 0; }

      #articles-heading {
        display: block;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        font-size: 1.15rem;
        font-weight: 700;
        letter-spacing: -0.01em;
      }

      #articles-status { margin: 0.05rem 0 0; color: var(--muted); font-size: 0.75rem; }

      #stream-back-button { display: none; margin-left: -0.6rem; }

      .article-query-controls { display: grid; gap: 0.45rem; }
      .article-query-controls:not(.is-searching) .article-query-search { display: none; }

      .article-query-search { display: flex; gap: 0.25rem; align-items: center; margin-top: 0.45rem; padding-right: 0.5rem; }
      .article-query-search input { flex: 1 1 auto; min-width: 0; padding: 0.35rem 0.6rem; border-radius: 7px; background: var(--hover); border-color: transparent; }
      .article-query-search .search-submit { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

      #article-query-status:empty, #offline-mode-banner:empty { display: none; }
      #article-query-status { margin: 0; color: var(--muted); font-size: 0.75rem; }

      #offline-mode-banner {
        margin: 0.45rem 0.5rem 0 0;
        padding: 0.4rem 0.6rem;
        border-radius: 7px;
        background: var(--hover);
        color: var(--text-secondary);
        font-size: 0.78rem;
      }

      /* Pop-over menus built on <details>. */
      .menu { position: relative; }

      .menu-panel {
        position: absolute;
        z-index: 30;
        top: calc(100% + 4px);
        right: 0;
        min-width: 15rem;
        display: grid;
        gap: 1px;
        padding: 0.35rem;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--surface-raised);
        box-shadow: var(--shadow);
        font-size: 0.85rem;
      }

      .menu-panel > label, .menu-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        padding: 0.3rem 0.55rem;
        color: var(--text);
      }

      .menu-panel select { width: 9.5rem; padding: 0.25rem 0.45rem; }
      .menu-bulk select { width: 100%; }

      .menu-panel hr { width: 100%; margin: 0.3rem 0; border: 0; border-top: 1px solid var(--hairline); }

      .menu-panel .menu-heading { margin: 0.2rem 0.55rem 0; color: var(--muted); font-size: 0.7rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }

      .menu-item {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.4rem 0.55rem;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: var(--text);
        font-size: 0.85rem;
        text-align: left;
      }

      .menu-item:hover { background: var(--accent-soft); }
      .menu-item[disabled]:hover { background: transparent; }

      .menu-item[aria-pressed]::after {
        content: "";
        width: 14px;
        height: 14px;
        margin-left: auto;
        background: var(--accent);
        -webkit-mask: var(--icon-check-all) center / contain no-repeat;
        mask: var(--icon-check-all) center / contain no-repeat;
        visibility: hidden;
      }

      .menu-item[aria-pressed="true"]::after { visibility: visible; }

      .menu-panel details { padding: 0 0.55rem; }
      .menu-panel details > summary { padding: 0.4rem 0; }
      .menu-panel details[open] { padding-bottom: 0.5rem; }
      .menu-panel details label { display: grid; gap: 0.3rem; color: var(--text-secondary); font-size: 0.78rem; }
      .menu-panel details button { margin-top: 0.45rem; }

      .menu-bulk { display: grid; gap: 0.4rem; padding: 0.3rem 0.55rem 0.4rem; }
      .menu-bulk label { display: grid; gap: 0.3rem; color: var(--text-secondary); font-size: 0.78rem; }
      .menu-bulk button { justify-self: start; }

      #article-page-controls { flex: none; display: flex; justify-content: space-between; padding: 0.25rem 0.75rem; border-bottom: 1px solid var(--hairline); }
      #article-page-controls button { border: 0; color: var(--accent); font-size: 0.8rem; padding: 0.25rem 0.4rem; }

      .list-shell { flex: 1 1 auto; min-height: 0; overflow: auto; }

      #articles-list-shell { border-top: 1px solid var(--hairline); }

      #load-more-button { display: block; margin: 0.75rem auto 1.25rem; border: 0; color: var(--accent); }

      .article-card {
        width: 100%;
        display: block;
        padding: 0.7rem 0.9rem 0.75rem 1.1rem;
        border: 0;
        border-bottom: 1px solid var(--hairline);
        border-radius: 0;
        background: transparent;
        color: var(--text);
        text-align: left;
        font-size: inherit;
      }

      .article-card:hover { background: var(--hover); }
      .article-card.is-active, .article-card.is-active:hover { background: var(--selected); }

      .article-card-grid { display: flex; gap: 0.75rem; align-items: flex-start; }
      .article-card-copy { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 0.2rem; }

      .article-meta {
        order: -1;
        display: flex;
        gap: 0.5rem;
        color: var(--muted);
        font-size: 0.72rem;
        line-height: 1.3;
      }

      .article-source { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .article-time { flex: none; margin-left: auto; font-variant-numeric: tabular-nums; }

      .article-title { display: block; font-size: 0.92rem; font-weight: 600; line-height: 1.3; letter-spacing: -0.003em; }

      .article-preview {
        display: -webkit-box;
        overflow: hidden;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        color: var(--text-secondary);
        font-size: 0.8rem;
        line-height: 1.4;
      }

      .article-card.is-read:not(.is-active) .article-title { color: var(--muted); font-weight: 500; }
      .article-card.is-read:not(.is-active) .article-preview { color: var(--muted); }

      .article-star {
        display: inline-block;
        width: 0.75rem;
        height: 0.75rem;
        margin-right: 0.3rem;
        overflow: hidden;
        background: var(--star);
        color: transparent;
        vertical-align: -0.05rem;
        -webkit-mask: var(--icon-star-filled) center / contain no-repeat;
        mask: var(--icon-star-filled) center / contain no-repeat;
      }

      .article-paywall {
        display: inline-block;
        margin-left: 0.4rem;
        padding: 0 0.35rem;
        border: 1px solid var(--border);
        border-radius: 4px;
        color: var(--muted);
        font-size: 0.65rem;
        font-weight: 500;
        letter-spacing: 0.02em;
        vertical-align: 0.12em;
      }

      .article-hero {
        width: 4rem;
        height: 4rem;
        flex: none;
        margin-top: 0.15rem;
        border-radius: 6px;
        background: var(--hover);
        object-fit: cover;
      }

      .article-card.is-read:not(.is-active) .article-hero { opacity: 0.6; }

      /* Reader */
      .reader-pane-surface {
        position: relative;
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        width: 100%;
      }

      #reader-pane-toolbar {
        flex: none;
        display: flex;
        align-items: center;
        gap: 0.15rem;
        padding: 0.6rem 0.75rem;
      }

      #reader-back-button { display: none; }

      #reader-action-status {
        flex: 1 1 auto;
        min-width: 0;
        margin: 0 0.5rem;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        color: var(--muted);
        font-size: 0.78rem;
        text-align: right;
      }

      .reader-pane-actions { display: flex; align-items: center; gap: 0.15rem; }

      #reader-mode-select { min-width: 8rem; }

      .reader-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; }

      .reader-copy {
        width: 100%;
        max-width: calc(var(--reader-measure, 720px));
        margin: 0 auto;
        padding: 1.5rem var(--reader-gutter, 24px) 0;
      }

      .reader-kicker { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem; margin: 0 0 0.6rem; color: var(--muted); font-size: 0.78rem; }
      .reader-kicker p { margin: 0; }
      #reader-source-label { color: var(--text-secondary); font-weight: 600; }
      #reader-source-note::before { content: "·"; margin-right: 0.4rem; }
      #reader-source-note:empty { display: none; }

      #reader-title {
        display: block;
        font-size: clamp(1.5rem, 2.3vw, 2rem);
        font-weight: 700;
        line-height: 1.18;
        letter-spacing: -0.015em;
      }

      #reader-meta { margin: 0.6rem 0 0; color: var(--muted); font-size: 0.85rem; }
      #reader-meta:empty, #reader-reading-status:empty { display: none; }
      #reader-reading-status { margin: 0.3rem 0 0; color: var(--muted); font-size: 0.78rem; }

      #load-images-button { margin-top: 0.75rem; }

      .reader-copy.is-empty { margin: auto; padding: 0; text-align: center; }
      .reader-copy.is-empty .reader-kicker { display: none; }
      .reader-copy.is-empty #reader-title { color: var(--muted); font-size: 0.95rem; font-weight: 500; letter-spacing: 0; }
      .reader-copy.is-empty #reader-meta { display: none; }
      .reader-scroll.is-empty .reader-frame-shell { display: none; }

      .reader-player-shell { width: 100%; max-width: 720px; margin: 1.25rem auto 0; padding: 0 24px; }
      .reader-player-label { display: none; }
      .reader-player-container { width: 100%; aspect-ratio: 16 / 9; min-height: 200px; overflow: hidden; border-radius: 10px; background: #000; }
      .reader-player-frame { display: block; width: 100%; height: 100%; min-height: 200px; border: 0; }
      .reader-player-fallback { display: inline-block; margin-top: 0.4rem; font-size: 0.8rem; }

      .reader-frame-shell { flex: 1 0 24rem; display: flex; padding: 0.5rem 0 0; }

      #reader-frame { display: block; width: 100%; min-height: 24rem; flex: 1 1 auto; border: 0; background: var(--frame); }

      #notification-action-panel {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin: 0.5rem 0.75rem 0;
        padding: 0.55rem 0.75rem;
        border-radius: 8px;
        background: var(--hover);
        font-size: 0.85rem;
      }

      #notification-action-panel p { flex: 1 1 auto; margin: 0; }

      /* Settings and Library sheets */
      .sheet {
        position: fixed;
        z-index: 40;
        top: 0;
        right: 0;
        bottom: 0;
        width: min(26rem, 100vw);
        display: block;
        overflow: auto;
        padding: 0 1.25rem 2rem;
        border-left: 1px solid var(--border);
        background: var(--surface);
        box-shadow: var(--shadow);
      }

      #library-panel { width: min(34rem, 100vw); }

      .sheet-header {
        position: sticky;
        top: 0;
        z-index: 1;
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin: 0 -1.25rem 0.5rem;
        padding: 0.9rem 0.75rem 0.75rem 1.25rem;
        border-bottom: 1px solid var(--hairline);
        background: var(--surface);
      }

      .sheet-header h2 { margin: 0; font-size: 1rem; font-weight: 650; }

      .sheet h2, .sheet h3, .sheet legend { font-size: 0.7rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); }
      .sheet-header h2 { font-size: 1rem; letter-spacing: -0.005em; text-transform: none; color: var(--text); }

      .sheet section, .sheet > details, .settings-group {
        margin: 0;
        padding: 1rem 0;
        border-top: 1px solid var(--hairline);
      }

      .sheet .sheet-header + section, .sheet .sheet-header + .settings-group, .sheet .sheet-header + div { border-top: 0; }

      .sheet > details > summary, .settings-group > h3 {
        margin: 0 0 0.6rem;
        color: var(--muted);
        font-size: 0.7rem;
        font-weight: 600;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }

      .sheet > details:not([open]) > summary { margin-bottom: 0; }

      .sheet p { margin: 0.35rem 0; color: var(--text-secondary); font-size: 0.82rem; line-height: 1.45; }
      .sheet label { color: var(--text); font-size: 0.85rem; }
      .sheet button { margin: 0.25rem 0.35rem 0.25rem 0; }
      .sheet ol, .sheet ul { padding-left: 1.1rem; }
      .sheet li { margin: 0.25rem 0; }
      .sheet fieldset { margin: 0.5rem 0; padding: 0.6rem 0.75rem; border: 1px solid var(--hairline); border-radius: 8px; }

      .settings-row, #reading-settings-form > label {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.35rem 0;
      }

      #reading-settings-form > label > input, #reading-settings-form > label > select, .settings-row > select { width: 9.5rem; flex: none; }

      #reading-settings-form > label > input[type="number"] { width: 5.5rem; }
      #reading-settings-form > label > input[maxlength="1"] { width: 2.75rem; text-align: center; }
      #reading-settings-form > button { margin-top: 0.6rem; }
      #reading-settings-status:empty, #reading-preference-status:empty { display: none; }

      #library-content label { display: block; margin: 0.45rem 0; }
      #library-content label > span { display: block; margin-bottom: 0.25rem; color: var(--text-secondary); font-size: 0.8rem; }
      #library-content textarea { min-height: 5rem; }
      #library-content section:first-child { border-top: 0; }

      #settings-content dl { display: grid; grid-template-columns: auto 1fr; gap: 0.35rem 1rem; margin: 0; font-size: 0.82rem; }
      #settings-content dt { color: var(--text-secondary); }
      #settings-content dd { margin: 0; text-align: right; }

      .sync-health { display: grid; gap: 0.6rem; margin-top: 1rem; }
      .sync-health h3, .sync-feed strong, .sync-feed p { margin: 0; }
      .sync-feed { display: grid; gap: 0.35rem; padding: 0.65rem 0.75rem; border: 1px solid var(--hairline); border-radius: 8px; }
      .sync-feed p { color: var(--muted); font-size: 0.8rem; }
      .sync-feed button { justify-self: start; }

      .status-meta { color: var(--muted); }

      #image-zoom-panel { position: fixed; inset: 0; z-index: 60; overflow: auto; padding: 3rem 1rem 1rem; background: rgba(0, 0, 0, 0.92); }
      #close-image-zoom { position: fixed; top: 0.75rem; right: 0.75rem; color: #fff; border-color: rgba(255, 255, 255, 0.3); }
      #zoom-image { display: block; max-width: 100%; max-height: 88vh; margin: auto; }

      /* Narrow windows: one column at a time, like the iPhone app. */
      @media (max-width: 760px) {
        .reader-grid, .reader-grid.is-sidebar-collapsed {
          grid-template-columns: 1fr;
          grid-template-areas: "pane";
        }

        #feeds-panel, #articles-panel, #reader-panel { grid-area: pane; border-right: 0; display: none; }
        .reader-grid > .column-resizer { display: none; }
        .reader-grid[data-mobile-pane="sidebar"] > #feeds-panel,
        .reader-grid[data-mobile-pane="stream"] > #articles-panel,
        .reader-grid[data-mobile-pane="reader"] > #reader-panel { display: flex; visibility: visible; }

        #stream-back-button, #reader-back-button { display: inline-grid; }
        #sidebar-toggle-button { display: none; }

        .sidebar-top { padding-top: 1rem; }
        .list-button { padding-top: 0.5rem; padding-bottom: 0.5rem; font-size: 0.95rem; }
        .article-card { padding-top: 0.85rem; padding-bottom: 0.9rem; }
        .article-title { font-size: 1rem; }
        .article-preview { font-size: 0.875rem; }

        .reader-copy { padding: 1rem 24px 0; }
        .sheet, #library-panel { width: 100vw; border-left: 0; }
      }
`;
}
