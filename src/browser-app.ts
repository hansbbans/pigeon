import { renderBrowserAppClientScript } from './browser-app-client';

export function renderBrowserAppHtml(baseUrl: string): string {
	const config = JSON.stringify({ baseUrl });
	const sharedClientScript = renderBrowserAppClientScript();
	const runtimeScript = renderBrowserAppRuntimeScript();

	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pigeon</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #dfe8f5;
        --bg-strong: #cfd9e9;
        --window: rgba(245, 248, 252, 0.94);
        --window-edge: #becada;
        --panel: #f8fafc;
        --panel-strong: #eef3f8;
        --border: #d4dde8;
        --text: #1f2937;
        --muted: #66758b;
        --accent: #2f6fed;
        --accent-strong: #2358be;
        --danger: #c34747;
        --shadow: 0 30px 80px rgba(31, 41, 55, 0.18);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: 'Avenir Next', 'Segoe UI', sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(255, 255, 255, 0.82), rgba(255, 255, 255, 0) 32%),
          radial-gradient(circle at right, rgba(47, 111, 237, 0.14), rgba(47, 111, 237, 0) 34%),
          linear-gradient(180deg, #edf3fb 0%, var(--bg) 100%);
      }

      button,
      input {
        font: inherit;
      }

      button {
        border: 1px solid transparent;
        border-radius: 999px;
        background: var(--accent);
        color: #fff;
        cursor: pointer;
        padding: 0.7rem 1.15rem;
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease, transform 120ms ease;
      }

      button:hover {
        background: var(--accent-strong);
        transform: translateY(-1px);
      }

      button[disabled] {
        cursor: default;
        transform: none;
        opacity: 0.72;
      }

      input {
        width: 100%;
        padding: 0.75rem 0.9rem;
        border-radius: 0.9rem;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.96);
      }

      #app {
        min-height: 100vh;
        padding: 1.25rem;
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
        padding: 1.5rem;
        border: 1px solid var(--border);
        border-radius: 1.5rem;
        background: rgba(248, 250, 252, 0.96);
        box-shadow: var(--shadow);
      }

      .login-card h1,
      .reader-brand h1 {
        margin: 0 0 0.5rem;
        font-size: clamp(1.8rem, 3vw, 2.6rem);
        letter-spacing: -0.04em;
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
        gap: 0.85rem;
        margin-top: 1rem;
      }

      #login-error {
        min-height: 1.2rem;
        color: var(--danger);
      }

      .reader-shell {
        width: min(100%, 96rem);
        margin: 0 auto;
      }

      .reader-window {
        border: 1px solid rgba(255, 255, 255, 0.7);
        border-radius: 1.5rem;
        overflow: hidden;
        background: var(--window);
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }

      #reader-window-bar {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 1rem;
        align-items: center;
        padding: 0.8rem 1rem;
        border-bottom: 1px solid rgba(255, 255, 255, 0.6);
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.74), rgba(232, 238, 246, 0.92)),
          linear-gradient(90deg, rgba(47, 111, 237, 0.06), rgba(47, 111, 237, 0));
      }

      .window-controls {
        display: inline-flex;
        gap: 0.45rem;
      }

      .window-dot {
        width: 0.72rem;
        height: 0.72rem;
        border-radius: 999px;
        display: inline-block;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.4);
      }

      .window-dot[data-tone="close"] {
        background: #ff5f57;
      }

      .window-dot[data-tone="minimize"] {
        background: #febc2e;
      }

      .window-dot[data-tone="expand"] {
        background: #28c840;
      }

      .window-address {
        min-width: 0;
        padding: 0.55rem 0.9rem;
        border: 1px solid rgba(190, 202, 218, 0.9);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.76);
        color: var(--muted);
        font-size: 0.93rem;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .window-status {
        font-size: 0.83rem;
        color: var(--muted);
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      #reader-toolbar {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        align-items: center;
        padding: 1rem 1rem 0.95rem;
      }

      .reader-brand {
        display: grid;
        gap: 0.15rem;
      }

      .reader-brand p {
        margin: 0;
        font-size: 0.8rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }

      .reader-brand h1 {
        margin-bottom: 0;
      }

      .toolbar-actions,
      .toolbar-cluster {
        display: flex;
        gap: 0.65rem;
        align-items: center;
        flex-wrap: wrap;
      }

      .toolbar-pill,
      .secondary-button {
        background: rgba(255, 255, 255, 0.74);
        color: var(--text);
        border-color: var(--border);
      }

      .toolbar-pill:hover,
      .secondary-button:hover {
        background: rgba(255, 255, 255, 0.96);
      }

      .toolbar-pill[data-presentational-control="true"] {
        color: var(--muted);
      }

      .reader-grid {
        display: grid;
        gap: 1px;
        padding: 0 1rem 1rem;
        grid-template-columns: minmax(14rem, 16rem) minmax(20rem, 26rem) minmax(24rem, 1fr);
        grid-template-areas: "sidebar stream reader";
        align-items: stretch;
        background: var(--window-edge);
      }

      .panel {
        min-height: 18rem;
        padding: 1rem;
        border: 0;
        border-radius: 0;
        background: var(--panel);
        box-shadow: none;
      }

      #feeds-panel {
        grid-area: sidebar;
        background:
          linear-gradient(180deg, rgba(241, 246, 252, 0.98), rgba(233, 240, 248, 0.94)),
          var(--panel);
        border-radius: 0 0 0 1.15rem;
      }

      #articles-panel {
        grid-area: stream;
      }

      #reader-panel {
        grid-area: reader;
        border-radius: 0 0 1.15rem 0;
      }

      .panel h2,
      .reader-copy h2 {
        margin: 0 0 0.75rem;
        font-size: 0.78rem;
        color: var(--muted);
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }

      .section-kicker {
        display: inline-flex;
        margin: 0 0 0.35rem;
        padding: 0.2rem 0.55rem;
        border-radius: 999px;
        background: var(--panel-strong);
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

      .sidebar-section {
        padding: 0.9rem;
        border: 1px solid rgba(206, 216, 229, 0.9);
        border-radius: 1rem;
        background: rgba(255, 255, 255, 0.58);
      }

      .sidebar-divider {
        height: 1px;
        margin: 0.8rem 0;
        background: var(--border);
      }

      .list-shell {
        display: grid;
        gap: 0.85rem;
      }

      .list-reset {
        display: grid;
        gap: 0.6rem;
        padding: 0;
        margin: 0;
        list-style: none;
      }

      .list-button {
        width: 100%;
        border-radius: 1rem;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.78);
        color: var(--text);
        padding: 0.8rem 0.9rem;
        text-align: left;
      }

      .list-button:hover {
        background: rgba(255, 255, 255, 0.98);
        color: var(--text);
        border-color: #c3d0e2;
      }

      .list-button.is-active {
        border-color: var(--accent);
        background: rgba(47, 111, 237, 0.15);
        box-shadow: inset 0 0 0 1px rgba(47, 111, 237, 0.2), 0 10px 24px rgba(47, 111, 237, 0.08);
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
        font-size: 0.95rem;
      }

      .feed-count {
        min-width: 2rem;
        padding: 0.2rem 0.5rem;
        border-radius: 999px;
        background: rgba(47, 111, 237, 0.09);
        color: var(--accent-strong);
        font-size: 0.79rem;
        font-weight: 700;
        text-align: center;
      }

      .feed-kind {
        display: block;
        margin-top: 0.28rem;
        color: var(--muted);
        font-size: 0.76rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .feed-meta,
      .article-preview,
      .article-meta {
        display: block;
        margin-top: 0.25rem;
      }

      .article-card {
        width: 100%;
        display: grid;
        gap: 0.85rem;
        border-radius: 1.15rem;
        border: 1px solid rgba(209, 218, 231, 0.95);
        background: rgba(255, 255, 255, 0.92);
        color: var(--text);
        padding: 0.95rem;
        text-align: left;
        box-shadow: 0 10px 30px rgba(31, 41, 55, 0.04);
      }

      .article-card:hover {
        background: #ffffff;
        color: var(--text);
        border-color: #c6d4e4;
      }

      .article-card.is-active {
        border-color: rgba(47, 111, 237, 0.92);
        background:
          linear-gradient(180deg, rgba(238, 245, 255, 0.98), rgba(231, 241, 255, 0.98)),
          #fff;
        box-shadow:
          0 16px 36px rgba(47, 111, 237, 0.14),
          inset 0 0 0 1px rgba(47, 111, 237, 0.18);
      }

      .article-card-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 0.9rem;
        align-items: start;
      }

      .article-card.has-hero-image .article-card-grid {
        grid-template-columns: minmax(0, 1fr) 7.5rem;
      }

      .article-card-copy {
        display: grid;
        gap: 0.48rem;
        min-width: 0;
      }

      .article-title {
        font-size: 1rem;
        line-height: 1.3;
        letter-spacing: -0.02em;
      }

      .article-preview {
        margin-top: 0;
        color: #526176;
        font-size: 0.92rem;
        line-height: 1.45;
      }

      .article-meta {
        margin-top: 0;
        color: #7a8799;
        font-size: 0.77rem;
        letter-spacing: 0.02em;
      }

      .article-hero {
        width: 100%;
        aspect-ratio: 4 / 3;
        border-radius: 0.95rem;
        border: 1px solid rgba(210, 220, 232, 0.95);
        background: var(--panel-strong);
        object-fit: cover;
      }

      #reader-panel {
        display: grid;
        gap: 1rem;
      }

      .reader-copy {
        display: grid;
        gap: 0.45rem;
      }

      .reader-copy strong {
        font-size: clamp(1.15rem, 1.5vw, 1.55rem);
        letter-spacing: -0.03em;
      }

      #reader-frame {
        width: 100%;
        min-height: 55vh;
        border: 1px solid var(--border);
        border-radius: 1rem;
        background: #fff;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8);
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
        border-radius: 1.25rem;
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

      @media (max-width: 1100px) {
        #app {
          padding: 0.75rem;
        }

        #reader-window-bar {
          grid-template-columns: 1fr;
          justify-items: flex-start;
        }

        #reader-toolbar {
          flex-direction: column;
          align-items: flex-start;
        }

        .reader-grid {
          grid-template-columns: 1fr;
          grid-template-areas: "sidebar" "stream" "reader";
          padding: 0 0.75rem 0.75rem;
        }

        .article-card.has-hero-image .article-card-grid {
          grid-template-columns: 1fr;
        }

        #feeds-panel,
        #articles-panel,
        #reader-panel {
          border-radius: 0;
        }

        #feeds-panel {
          border-top-left-radius: 0;
          border-top-right-radius: 0;
        }

        #reader-panel {
          border-bottom-left-radius: 1rem;
          border-bottom-right-radius: 1rem;
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
          <h1>Pigeon Reader</h1>
          <p>Use the app password to unlock your private reading view.</p>
          <form id="login-form">
            <label>
              <span class="hidden">Password</span>
              <input id="password-input" name="Passwd" type="password" autocomplete="current-password" placeholder="Password" />
            </label>
            <button id="login-button" type="submit">Open Reader</button>
            <div id="login-error" aria-live="polite"></div>
          </form>
        </div>
      </section>

      <section class="reader-shell hidden" id="reader-shell">
        <div class="reader-window">
          <div id="reader-window-bar">
            <div class="window-controls" aria-hidden="true">
              <span class="window-dot" data-tone="close"></span>
              <span class="window-dot" data-tone="minimize"></span>
              <span class="window-dot" data-tone="expand"></span>
            </div>
            <div class="window-address">pigeon://reader/private</div>
            <div class="window-status">Read-only browser shell</div>
          </div>

          <header id="reader-toolbar">
            <div class="reader-brand">
              <p>Private browser reader</p>
              <h1>Pigeon</h1>
            </div>
            <div class="toolbar-actions">
              <div class="toolbar-cluster" aria-label="Future actions">
                <button class="toolbar-pill" type="button" data-presentational-control="true" disabled>Mark</button>
                <button class="toolbar-pill" type="button" data-presentational-control="true" disabled>Save</button>
              </div>
              <button class="secondary-button" id="settings-button" type="button">Settings</button>
              <button id="logout-button" type="button">Log Out</button>
            </div>
          </header>

          <div class="reader-grid">
            <aside class="panel" id="feeds-panel">
              <section class="sidebar-section" id="real-views-section">
                <span class="section-kicker">Views</span>
                <div class="pane-header">
                  <h2>Real views</h2>
                  <p class="status-meta">All items and unread stay here as the built-in reader views.</p>
                </div>
                <div class="list-shell">
                  <ul class="list-reset" id="views-list"></ul>
                </div>
              </section>

              <div class="sidebar-divider" aria-hidden="true"></div>

              <section class="sidebar-section" id="real-feeds-section">
                <span class="section-kicker">Feeds</span>
                <div class="pane-header">
                  <h2>Real feeds</h2>
                  <p class="status-meta" id="feeds-status">Feed list loads after login.</p>
                </div>
                <div class="list-shell">
                  <ul class="list-reset" id="feeds-list"></ul>
                </div>
              </section>
            </aside>

            <section class="panel" id="articles-panel">
              <div class="pane-header">
                <span class="section-kicker">Stream</span>
                <h2>Articles</h2>
                <p class="status-meta" id="articles-status">Choose a feed to load article previews.</p>
              </div>
              <div class="list-shell">
                <ul class="list-reset" id="articles-list"></ul>
                <button class="secondary-button hidden" id="load-more-button" type="button">Load More</button>
              </div>
            </section>

            <article class="panel" id="reader-panel">
              <div class="reader-copy">
                <span class="section-kicker">Reader</span>
                <h2>Selected article</h2>
                <strong id="reader-title">Select an article</strong>
                <p class="panel-note" id="reader-meta">Full article content stays isolated inside the reader frame.</p>
              </div>
              <iframe id="reader-frame" title="Article content" sandbox="" srcdoc=""></iframe>
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
  const loginScreen = document.getElementById('login-screen');
  const readerShell = document.getElementById('reader-shell');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const passwordInput = document.getElementById('password-input');
  const logoutButton = document.getElementById('logout-button');
  const settingsButton = document.getElementById('settings-button');
  const settingsPanel = document.getElementById('settings-panel');
  const closeSettingsButton = document.getElementById('close-settings-button');
  const viewsList = document.getElementById('views-list');
  const feedsStatus = document.getElementById('feeds-status');
  const feedsList = document.getElementById('feeds-list');
  const articlesStatus = document.getElementById('articles-status');
  const articlesList = document.getElementById('articles-list');
  const loadMoreButton = document.getElementById('load-more-button');
  const readerTitle = document.getElementById('reader-title');
  const readerMeta = document.getElementById('reader-meta');
  const readerFrame = document.getElementById('reader-frame');
  const settingsContent = document.getElementById('settings-content');
  let session = client.createLoggedOutSession();
  let activeValidationId = 0;
  let activeViewRequestId = 0;
  let activeStatusRequestId = 0;
  let activeContentRequestId = 0;
  let views = [];
  let activeViewId = 'all';
  let itemIds = [];
  let loadedItemsById = {};
  let inFlightContentIds = [];
  let selectedItemId = null;
  let statusLoaded = false;

  function getStoredToken() {
    return window.sessionStorage.getItem(storageKey);
  }

  function setStoredToken(token) {
    window.sessionStorage.setItem(storageKey, token);
  }

  function clearStoredToken() {
    window.sessionStorage.removeItem(storageKey);
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

  function createPendingContentPlan(preferredItemId) {
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
    cancelStatusLoads();
    views = [];
    clearElement(viewsList);
    clearElement(feedsList);
    feedsStatus.textContent = 'Feed list loads after login.';
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
  }

  async function validateToken(token) {
    const response = await fetch('/app/status', {
      headers: {
        Authorization: 'GoogleLogin auth=pigeon/' + token,
      },
    });

    return response.status === 200;
  }

  function renderViewList(targetList, availableViews) {
    clearElement(targetList);

    for (const view of availableViews) {
      const listItem = createNode('li');
      const button = createNode('button', {
        classNames: ['list-button', view.id === activeViewId ? 'is-active' : ''],
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
      row.appendChild(createNode('span', { classNames: ['feed-count'], text: String(view.unreadCount) }));
      button.appendChild(row);
      button.appendChild(
        createNode('span', {
          classNames: ['feed-kind'],
          text: view.kind === 'feed' ? 'Feed' : 'View',
        }),
      );
      listItem.appendChild(button);
      targetList.appendChild(listItem);
    }
  }

  function renderFeeds() {
    clearElement(viewsList);
    clearElement(feedsList);

    if (views.length === 0) {
      feedsStatus.textContent = 'Feed list loads after login.';
      return;
    }

    const builtInViews = views.filter((view) => view.kind !== 'feed');
    const feedViews = views.filter((view) => view.kind === 'feed');

    renderViewList(viewsList, builtInViews);
    renderViewList(feedsList, feedViews);
    feedsStatus.textContent = feedViews.length > 0 ? 'Choose a feed.' : 'No feeds yet.';
  }

  function renderArticles() {
    const entries = client.buildArticleListEntries({
      itemIds,
      loadedItemsById,
    });

    clearElement(articlesList);

    if (entries.length === 0) {
      articlesStatus.textContent = 'Choose a feed to load article previews.';
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
          entry.heroImageUrl ? 'has-hero-image' : 'is-text-only',
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
      if (entry.preview) {
        copy.appendChild(createNode('span', { classNames: ['article-preview'], text: entry.preview }));
      }
      const metaParts = [entry.feedTitle, formatTimestamp(entry.published)].filter(Boolean);
      if (metaParts.length > 0) {
        copy.appendChild(createNode('span', { classNames: ['article-meta'], text: metaParts.join(' · ') }));
      }
      cardGrid.appendChild(copy);
      if (entry.heroImageUrl) {
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
    loadMoreButton.disabled = inFlightContentIds.length > 0;
    loadMoreButton.classList.toggle('hidden', pendingPlan.length === 0);
  }

  function renderReader() {
    if (!selectedItemId) {
      readerTitle.textContent = 'Select an article';
      readerMeta.textContent = 'Full article content stays isolated inside the reader frame.';
      readerFrame.srcdoc = '';
      return;
    }

    const item = loadedItemsById[selectedItemId];
    if (!item) {
      readerTitle.textContent = 'Loading article…';
      readerMeta.textContent = 'Loading the full article body.';
      readerFrame.srcdoc = '';
      return;
    }

    readerTitle.textContent = item.title || 'Untitled article';
    readerMeta.textContent = [item.origin && item.origin.title ? item.origin.title : '', formatTimestamp(item.published)]
      .filter(Boolean)
      .join(' · ');
    readerFrame.srcdoc = item.content && item.content.content ? item.content.content : '';
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

  function buildStreamIdsUrl(view) {
    const params = new URLSearchParams();
    params.set('s', view.streamId);
    params.set('n', String(client.INITIAL_ITEM_ID_LIMIT));
    if (view.kind === 'unread') {
      params.set('xt', 'user/-/state/com.google/read');
    }
    return '/reader/api/0/stream/items/ids?' + params.toString();
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
      renderArticles();
      renderReader();
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
    loadedItemsById = {};
    selectedItemId = null;
    articlesStatus.textContent = 'Loading articles…';
    clearElement(articlesList);
    loadMoreButton.classList.add('hidden');
    renderFeeds();
    renderReader();

    try {
      const payload = await authenticatedJson(buildStreamIdsUrl(activeView));
      if (requestId !== activeViewRequestId) {
        return;
      }

      itemIds = (payload.itemRefs || []).map((itemRef) => String(itemRef.id)).slice(0, client.INITIAL_ITEM_ID_LIMIT);
      selectedItemId = itemIds[0] || null;
      renderArticles();
      renderReader();

      if (itemIds.length > 0) {
        await loadContentChunk(selectedItemId, requestId);
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

    activeViewId = viewId;
    await loadActiveView();
  }

  async function selectArticle(itemId) {
    if (!itemIds.includes(itemId)) {
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

  settingsButton.addEventListener('click', () => {
    const isHidden = settingsPanel.classList.toggle('hidden');
    if (!isHidden && !statusLoaded) {
      void loadStatus();
    }
  });

  closeSettingsButton.addEventListener('click', () => {
    settingsPanel.classList.add('hidden');
  });

  loadMoreButton.addEventListener('click', () => {
    if (inFlightContentIds.length > 0) {
      return;
    }
    void loadContentChunk(selectedItemId, activeViewRequestId);
  });

  if (config.baseUrl) {
    document.documentElement.setAttribute('data-base-url', config.baseUrl);
  }

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
