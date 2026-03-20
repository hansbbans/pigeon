export function renderBrowserAppHtml(baseUrl: string): string {
	const config = JSON.stringify({ baseUrl });

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
        grid-template-columns: minmax(15rem, 18rem) minmax(18rem, 22rem) minmax(0, 1fr) minmax(15rem, 18rem);
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

      pre#settings-status {
        white-space: pre-wrap;
        word-break: break-word;
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.82rem;
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
          <button id="logout-button" type="button">Log Out</button>
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

          <aside class="panel" id="settings-panel">
            <h2>Settings &amp; Status</h2>
            <p class="status-meta">Status data will load after login.</p>
            <pre id="settings-status">{}</pre>
          </aside>
        </div>
      </section>
    </div>
    <script>
      (() => {
        const config = window.__PIGEON_CONFIG__ || {};
        const storageKey = 'pigeon.browser.auth';
        const loginScreen = document.getElementById('login-screen');
        const readerShell = document.getElementById('reader-shell');
        const loginForm = document.getElementById('login-form');
        const loginError = document.getElementById('login-error');
        const passwordInput = document.getElementById('password-input');
        const logoutButton = document.getElementById('logout-button');
        const statusOutput = document.getElementById('settings-status');

        function getStoredToken() {
          return window.sessionStorage.getItem(storageKey);
        }

        function setStoredToken(token) {
          window.sessionStorage.setItem(storageKey, token);
        }

        function clearStoredToken() {
          window.sessionStorage.removeItem(storageKey);
        }

        function setLoggedOut(message) {
          clearStoredToken();
          loginScreen.classList.remove('hidden');
          readerShell.classList.add('hidden');
          loginError.textContent = message || '';
        }

        function setLoggedIn() {
          loginError.textContent = '';
          loginScreen.classList.add('hidden');
          readerShell.classList.remove('hidden');
        }

        function extractToken(responseText) {
          const match = responseText.match(/^Auth=pigeon\\/(.+)$/m);
          return match ? match[1] : null;
        }

        async function login(password) {
          const form = new FormData();
          form.set('Passwd', password);

          const response = await fetch('/accounts/ClientLogin', {
            method: 'POST',
            body: form,
          });

          if (!response.ok) {
            setLoggedOut('Incorrect password.');
            return false;
          }

          const text = await response.text();
          const token = extractToken(text);
          if (!token) {
            setLoggedOut('Could not start a session.');
            return false;
          }

          setStoredToken(token);
          setLoggedIn();
          return true;
        }

        async function loadStatus() {
          const token = getStoredToken();
          if (!token) {
            setLoggedOut('');
            return;
          }

          const response = await fetch('/app/status', {
            headers: {
              Authorization: 'GoogleLogin auth=pigeon/' + token,
            },
          });

          if (response.status === 401) {
            setLoggedOut('Session expired. Please sign in again.');
            return;
          }

          const payload = await response.json();
          statusOutput.textContent = JSON.stringify(payload, null, 2);
        }

        loginForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          const ok = await login(passwordInput.value);
          if (ok) {
            passwordInput.value = '';
            await loadStatus();
          }
        });

        logoutButton.addEventListener('click', () => {
          setLoggedOut('');
        });

        if (config.baseUrl) {
          document.documentElement.setAttribute('data-base-url', config.baseUrl);
        }

        if (getStoredToken()) {
          setLoggedIn();
          loadStatus().catch(() => setLoggedOut('Session expired. Please sign in again.'));
        } else {
          setLoggedOut('');
        }
      })();
    </script>
  </body>
</html>`;
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
