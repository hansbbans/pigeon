export const AUTH_STORAGE_KEY = 'pigeon.browser.auth';

export interface BrowserAppSession {
	status: 'logged_out' | 'authenticated';
	token: string | null;
}

export function extractAuthToken(responseText: string): string | null {
	const match = responseText.match(/^Auth=pigeon\/(.+)$/m);
	return match?.[1] ?? null;
}

export function createLoggedOutSession(): BrowserAppSession {
	return {
		status: 'logged_out',
		token: null,
	};
}

export function createSessionFromToken(token: string): BrowserAppSession {
	return {
		status: 'authenticated',
		token,
	};
}

export function applyUnauthorizedState(_session: BrowserAppSession): BrowserAppSession {
	return createLoggedOutSession();
}

export function renderBrowserAppClientScript(): string {
	return `
${extractAuthToken.toString()}
${createLoggedOutSession.toString()}
${createSessionFromToken.toString()}
${applyUnauthorizedState.toString()}

window.__PIGEON_BROWSER_CLIENT__ = {
  AUTH_STORAGE_KEY: ${JSON.stringify(AUTH_STORAGE_KEY)},
  extractAuthToken,
  createLoggedOutSession,
  createSessionFromToken,
  applyUnauthorizedState,
};
`.trim();
}
