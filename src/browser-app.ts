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
        --bg: #f4f1e8;
        --panel: #fffaf0;
        --panel-strong: #f0e7d4;
        --border: #d9cdb6;
        --text: #1f1b16;
        --muted: #6f6559;
        --accent: #1e6b52;
        --accent-strong: #184f3d;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: Georgia, 'Times New Roman', serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0) 30%),
          linear-gradient(180deg, #efe7d7 0%, var(--bg) 100%);
      }

      button,
      input {
        font: inherit;
      }

      button {
        border: 0;
        border-radius: 999px;
        background: var(--accent);
        color: #fff;
        cursor: pointer;
        padding: 0.7rem 1.1rem;
      }

      button:hover {
        background: var(--accent-strong);
      }

      input {
        width: 100%;
        padding: 0.75rem 0.9rem;
        border-radius: 0.9rem;
        border: 1px solid var(--border);
        background: #fff;
      }

      #app {
        min-height: 100vh;
        padding: 1.5rem;
      }

      .hidden {
        display: none !important;
      }

      .login-shell {
        min-height: calc(100vh - 3rem);
        display: grid;
        place-items: center;
      }

      .login-card {
        width: min(28rem, 100%);
        padding: 1.5rem;
        border: 1px solid var(--border);
        border-radius: 1.5rem;
        background: rgba(255, 250, 240, 0.95);
        box-shadow: 0 20px 50px rgba(64, 42, 12, 0.12);
      }

      .login-card h1,
      .reader-header h1 {
        margin: 0 0 0.5rem;
        font-size: clamp(1.8rem, 3vw, 2.6rem);
      }

      .login-card p,
      .reader-header p,
      .panel-note,
      .status-meta {
        color: var(--muted);
      }

      #login-form {
        display: grid;
        gap: 0.85rem;
        margin-top: 1rem;
      }

      #login-error {
        min-height: 1.2rem;
        color: #b24732;
      }

      .reader-shell {
        display: grid;
        gap: 1rem;
      }

      .reader-header {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        align-items: flex-start;
      }

      .reader-grid {
        display: grid;
        gap: 1rem;
        grid-template-columns: minmax(15rem, 18rem) minmax(18rem, 22rem) minmax(0, 1fr);
      }

      .panel {
        min-height: 18rem;
        padding: 1rem;
        border: 1px solid var(--border);
        border-radius: 1.25rem;
        background: rgba(255, 250, 240, 0.92);
        box-shadow: 0 10px 30px rgba(64, 42, 12, 0.08);
      }

      .panel h2 {
        margin: 0 0 0.75rem;
        font-size: 1rem;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }

      .placeholder-list {
        display: grid;
        gap: 0.75rem;
        padding: 0;
        margin: 0;
        list-style: none;
      }

      .placeholder-list li {
        padding: 0.8rem;
        border-radius: 1rem;
        background: var(--panel-strong);
      }

      #settings-panel {
        position: fixed;
        top: 1.5rem;
        right: 1.5rem;
        width: min(22rem, calc(100vw - 3rem));
        min-height: auto;
        max-height: calc(100vh - 3rem);
        overflow: auto;
      }

      #settings-panel h2 {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 0.75rem;
      }

      .secondary-button {
        background: transparent;
        color: var(--accent-strong);
        border: 1px solid var(--border);
      }

      @media (max-width: 960px) {
        .reader-grid {
          grid-template-columns: 1fr;
        }

        .reader-header {
          flex-direction: column;
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
        <header class="reader-header">
          <div>
            <p>Private browser reader</p>
            <h1>Pigeon</h1>
          </div>
          <div>
            <button class="secondary-button" id="settings-button" type="button">Settings</button>
            <button id="logout-button" type="button">Log Out</button>
          </div>
        </header>

        <div class="reader-grid">
          <aside class="panel" id="feeds-panel">
            <h2>Feeds</h2>
            <ul class="placeholder-list">
              <li>Feed list loads after login.</li>
            </ul>
          </aside>

          <section class="panel" id="articles-panel">
            <h2>Articles</h2>
            <ul class="placeholder-list">
              <li>Choose a feed to load article previews.</li>
            </ul>
          </section>

          <article class="panel" id="reader-panel">
            <h2>Reader</h2>
            <p class="panel-note">The full article reader is wired in the next task.</p>
          </article>
        </div>
      </section>

      <aside class="panel hidden" id="settings-panel">
        <h2>
          <span>Settings</span>
          <button class="secondary-button" id="close-settings-button" type="button">Close</button>
        </h2>
        <p class="status-meta">Status details and live settings data arrive in the next task.</p>
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
  let session = client.createLoggedOutSession();
  let activeValidationId = 0;

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

  function setLoggedOut(message) {
    session = client.applyUnauthorizedState(session);
    clearStoredToken();
    loginScreen.classList.remove('hidden');
    readerShell.classList.add('hidden');
    settingsPanel.classList.add('hidden');
    loginError.textContent = message || '';
  }

  function setLoggedIn() {
    loginError.textContent = '';
    loginScreen.classList.add('hidden');
    readerShell.classList.remove('hidden');
  }

  async function validateToken(token) {
    try {
      const response = await fetch('/app/status', {
        headers: {
          Authorization: 'GoogleLogin auth=pigeon/' + token,
        },
      });

      return response.status === 200;
    } catch (_error) {
      setLoggedOut('Could not restore session.');
      return false;
    }
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
    cancelPendingValidation();
    setLoggedOut('');
  });

  settingsButton.addEventListener('click', () => {
    settingsPanel.classList.toggle('hidden');
  });

  closeSettingsButton.addEventListener('click', () => {
    settingsPanel.classList.add('hidden');
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
      } else if (loginError.textContent === '') {
        setLoggedOut('');
      }
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
