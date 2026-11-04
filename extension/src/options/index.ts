/** Options page: sign in once (the password is exchanged for a token), sign out. */

import browser from '../browser-api';
import { OPTIONS_STATE_KEYS, optionsState, signOut, submitSignIn } from '../core/sign-in';

const store = browser.storage.local;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $<HTMLFormElement>('sign-in');
const urlInput = $<HTMLInputElement>('url');
const passwordInput = $<HTMLInputElement>('password');
const submit = $<HTMLButtonElement>('submit');
const errors = { url: $('url-error'), password: $('password-error'), general: $('general-error') };

function showError(field: keyof typeof errors | null, message = ''): void {
	for (const [name, element] of Object.entries(errors)) {
		element.hidden = name !== field;
		element.textContent = name === field ? message : '';
	}
}

async function render(): Promise<void> {
	const state = await optionsState(store);
	$('signed-in').hidden = !state.signedIn;
	form.hidden = state.signedIn;
	$('signed-in-origin').textContent = state.origin;
	if (!urlInput.value) urlInput.value = state.origin;
	const notice = $('notice');
	notice.hidden = !state.needsSignIn;
	notice.textContent = state.needsSignIn ? 'Pigeon did not accept the saved sign-in. Enter your password again.' : '';
	const queue = $('queue');
	queue.hidden = state.queued === 0;
	queue.textContent = state.queued === 1 ? '1 save is waiting to be sent.' : `${state.queued} saves are waiting to be sent.`;
	const commands = await browser.commands.getAll();
	const shortcut = commands.find((command) => command.name === 'save-page')?.shortcut;
	$('shortcut').textContent = shortcut || 'a shortcut (set one at chrome://extensions/shortcuts)';
}

form.addEventListener('submit', (event) => {
	event.preventDefault();
	showError(null);
	void submitSignIn(urlInput.value, passwordInput.value, {
		fetch: (input, init) => fetch(input, init),
		store,
		requestHostPermission: (pattern) => browser.permissions.request({ origins: [pattern] }),
	}, {
		setBusy: (busy) => {
			submit.disabled = busy;
		},
		showError,
		signedIn: async () => {
			passwordInput.value = '';
			await render();
			// Send anything that waited for sign-in.
			await browser.runtime.sendMessage({ type: 'pigeon:flush' }).catch(() => undefined);
			await render();
		},
	});
});

$('sign-out').addEventListener('click', () => {
	void signOut(store)
		.then(render)
		.catch((error: unknown) => showError('general', `Sign-out failed: ${error instanceof Error ? error.message : String(error)}`));
});

browser.storage.onChanged.addListener((changes, area) => {
	if (area === 'local' && Object.keys(changes).some((key) => OPTIONS_STATE_KEYS.includes(key))) void render().catch(reportRenderError);
});
function reportRenderError(error: unknown): void {
	showError('general', `Could not read the settings: ${error instanceof Error ? error.message : String(error)}`);
}

void render().catch(reportRenderError);
