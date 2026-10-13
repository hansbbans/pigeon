export interface LibrarySubscription {
	id: string;
	title: string;
	url?: string;
	sourceUrl?: string | null;
	categories?: Array<{ id: string; label?: string }>;
}

export interface LibraryImportEntry { url: string; title: string; folders: string[]; duplicateId: string | null }
export interface LibraryMutation { id: string; kind: string; feedId: string; folders?: string[]; title?: string }
export interface LibraryOperationAdapter {
	authenticatedJson(input: string, init?: RequestInit): Promise<any>;
	isCurrent(): boolean;
}

/** Browser-side validation supplements the authoritative Worker URL checks. */
export function librarySafeURL(value: string): string {
	if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Enter a public HTTP or HTTPS feed URL.');
	const url = new URL(value.trim());
	const host = url.hostname.toLowerCase().replace(/\.$/, '');
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['', '80', '443'].includes(url.port)
		|| !host || host === 'localhost' || /\.(localhost|local|internal|home\.arpa)$/.test(host)
		|| /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
		|| host === '[::]' || host === '[::1]' || /^\[(fc|fd|fe[89ab]|::ffff:)/i.test(host)) throw new Error('Feed URL must use a public HTTP or HTTPS address.');
	url.hostname = host;
	url.hash = '';
	return url.href;
}

export function libraryCanonicalURL(value: string): string {
	const url = new URL(librarySafeURL(value));
	if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
	return url.href;
}

export function libraryFolderNames(subscription: LibrarySubscription): string[] {
	return [...new Set((subscription.categories ?? []).map((category) => category.label ?? (category.id.startsWith('user/-/label/') ? category.id.slice(13) : '')).filter(Boolean))];
}

export function libraryValidateFolders(names: string[]): string[] {
	const folders = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
	if (folders.length > 20 || folders.some((name) => name.length > 80 || /[\u0000-\u001f\u007f]/.test(name))) throw new Error('Choose at most 20 folders; each name must be 1–80 characters.');
	return folders;
}

export function libraryFolderPlan(subscriptions: LibrarySubscription[], oldName: string, newName: string | null): Array<{ feedId: string; folders: string[]; previous: string[] }> {
	const name = newName === null ? null : libraryValidateFolders([newName])[0];
	if (newName !== null && !name) throw new Error('Enter a folder name.');
	if (name !== null && name !== oldName && subscriptions.some((subscription) => libraryFolderNames(subscription).some((folder) => folder.toLowerCase() === name.toLowerCase()))) throw new Error('A folder with that name already exists.');
	const affected = subscriptions.filter((subscription) => libraryFolderNames(subscription).includes(oldName));
	if (affected.length > 100) throw new Error('This folder contains more than 100 feeds. Change smaller groups first.');
	return affected.map((subscription) => {
		const previous = libraryFolderNames(subscription);
		return { feedId: subscription.id, previous, folders: libraryValidateFolders(previous.flatMap((folder) => folder === oldName ? (name === null ? [] : [name]) : [folder])) };
	});
}

/** XML is parsed by the caller's native DOMParser. No markup from it is rendered. */
export function libraryOPMLPreview(text: string, subscriptions: LibrarySubscription[], parseXML: (text: string) => any): LibraryImportEntry[] {
	if (new TextEncoder().encode(text).byteLength > 1_000_000) throw new Error('OPML must be at most 1 MB.');
	if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(text)) throw new Error('OPML with DTDs or entities is not supported.');
	const document = parseXML(text);
	if (!document?.documentElement || document.getElementsByTagName('parsererror').length || document.documentElement.tagName.toLowerCase() !== 'opml') throw new Error('Choose valid OPML XML.');
	const bodies = Array.from(document.documentElement.children as any[]).filter((node: any) => node.tagName.toLowerCase() === 'body');
	if (bodies.length !== 1) throw new Error('OPML needs exactly one body.');
	const existing = new Map<string, string>();
	for (const subscription of subscriptions) {
		try { existing.set(libraryCanonicalURL(subscription.sourceUrl || subscription.url || ''), subscription.id); } catch { /* An unrelated malformed saved URL is not a duplicate. */ }
	}
	const entries = new Map<string, LibraryImportEntry>();
	let outlines = 0;
	function visit(node: any, folders: string[], depth: number): void {
		if (depth > 20 || ++outlines > 1000) throw new Error('OPML nesting or outline count exceeds the import limit.');
		if (node.tagName.toLowerCase() !== 'outline') throw new Error('OPML body must contain outlines.');
		const attributes = new Map<string, string>();
		for (const attribute of Array.from(node.attributes as any[])) {
			const key = attribute.name.toLowerCase();
			if (attributes.has(key)) throw new Error('OPML has ambiguous attributes.');
			attributes.set(key, attribute.value);
		}
		const title = (attributes.get('title') || attributes.get('text') || '').trim();
		const rawURL = attributes.get('xmlurl');
		let nestedFolders = folders;
		if (rawURL !== undefined) {
			const url = librarySafeURL(rawURL);
			const canonical = libraryCanonicalURL(url);
			const prior = entries.get(canonical);
			if (prior) prior.folders = libraryValidateFolders([...prior.folders, ...folders]);
			else {
				if (entries.size >= 100) throw new Error('Import at most 100 unique feeds at a time.');
				if (title.length > 200) throw new Error('Feed titles must be at most 200 characters.');
				entries.set(canonical, { url, title: title || new URL(url).hostname, folders, duplicateId: existing.get(canonical) ?? null });
			}
		} else if (title) nestedFolders = libraryValidateFolders([...folders, title]);
		for (const child of Array.from(node.children as any[])) visit(child, nestedFolders, depth + 1);
	}
	for (const child of Array.from((bodies[0] as any).children as any[])) visit(child, [], 1);
	if (!entries.size) throw new Error('No feeds found in this OPML.');
	return [...entries.values()];
}

export async function libraryRunMutations(adapter: LibraryOperationAdapter, mutations: LibraryMutation[]): Promise<{ applied: LibraryMutation[]; failed: Array<{ mutation: LibraryMutation; error: string; uncertain: boolean }>; notAttempted: LibraryMutation[]; cancelled: boolean }> {
	if (mutations.length > 100) throw new Error('Change at most 100 feeds at a time.');
	const result = { applied: [] as LibraryMutation[], failed: [] as Array<{ mutation: LibraryMutation; error: string; uncertain: boolean }>, notAttempted: [] as LibraryMutation[], cancelled: false };
	for (let index = 0; index < mutations.length; index++) {
		if (!adapter.isCurrent()) { result.cancelled = true; result.notAttempted = mutations.slice(index); break; }
		const mutation = mutations[index];
		try {
			const payload = await adapter.authenticatedJson('/api/v1/mutations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mutations: [mutation] }) });
			const receipt = payload?.results?.find((item: any) => item.mutationId === mutation.id);
			if (receipt?.status === 'applied' || receipt?.status === 'already_applied') result.applied.push(mutation);
			else {
				result.failed.push({ mutation, error: receipt?.error || 'No confirmed receipt was returned.', uncertain: receipt?.status !== 'failed' });
				result.notAttempted = mutations.slice(index + 1); break;
			}
		} catch {
			result.failed.push({ mutation, error: 'Request failed; whether this change reached the server is unknown. Retry the same operation to check its receipt.', uncertain: true });
			result.notAttempted = mutations.slice(index + 1); break;
		}
	}
	if (!adapter.isCurrent()) result.cancelled = true;
	return result;
}

export async function libraryRunImport(adapter: LibraryOperationAdapter, entries: LibraryImportEntry[]): Promise<any> {
	if (entries.length > 100) throw new Error('Import at most 100 feeds.');
	for (const entry of entries) {
		librarySafeURL(entry.url); libraryValidateFolders(entry.folders);
		if (entry.title.length > 200) throw new Error('Feed titles must be at most 200 characters.');
	}
	const result = { added: [] as Array<{ id: string; title: string }>, skipped: [] as string[], rolledBack: [] as string[], rollbackFailed: [] as string[], failed: null as string | null, uncertain: [] as string[], cancelled: false, notAttempted: [] as string[] };
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (!adapter.isCurrent()) { result.cancelled = true; result.notAttempted = entries.slice(index).map((item) => item.title); break; }
		if (entry.duplicateId) { result.skipped.push(entry.title); continue; }
		let subscribed = false;
		try {
			const payload = await adapter.authenticatedJson('/reader/api/0/subscription/quickadd?quickadd=' + encodeURIComponent(librarySafeURL(entry.url)));
			if (!/^feed\/[1-9]\d*$/.test(payload?.streamId) || typeof payload.isNew !== 'boolean') throw new Error('No confirmed subscription result.');
			subscribed = true;
			if (!payload.isNew) { result.skipped.push(entry.title); continue; }
			result.added.push({ id: payload.streamId, title: entry.title });
			const changes: LibraryMutation[] = [{ id: crypto.randomUUID(), kind: 'move_feed', feedId: payload.streamId, folders: libraryValidateFolders(entry.folders) }];
			if (entry.title) changes.push({ id: crypto.randomUUID(), kind: 'rename_feed', feedId: payload.streamId, title: entry.title });
			const edits = await libraryRunMutations(adapter, changes);
			if (edits.cancelled) { result.cancelled = true; result.notAttempted = entries.slice(index + 1).map((item) => item.title); break; }
			if (edits.failed.length) throw new Error('Feed added, but its title or folders could not be confirmed.');
		} catch (error) {
			result.failed = entry.title + ': ' + (error instanceof Error ? error.message : 'Import failed.');
			if (!subscribed) result.uncertain.push(entry.title);
			result.notAttempted = entries.slice(index + 1).map((item) => item.title);
			break;
		}
	}
	if (!adapter.isCurrent()) result.cancelled = true;
	// This is compensating unsubscribe, not a transaction or deletion of downloaded stories.
	if (result.failed && !result.cancelled) {
		for (const added of [...result.added].reverse()) {
			if (!adapter.isCurrent()) { result.cancelled = true; break; }
			const rollback = await libraryRunMutations(adapter, [{ id: crypto.randomUUID(), kind: 'unsubscribe_feed', feedId: added.id }]);
			if (rollback.applied.length) result.rolledBack.push(added.id); else result.rollbackFailed.push(added.id);
		}
	}
	return result;
}

/** mount({container,authenticatedFetch,authenticatedJson,getSubscriptions,
 * refreshLibrary,getSessionIdentity,onFolderRenamed?}) -> {refresh,destroy}.
 * onFolderRenamed(oldName,newName) runs after all rename receipts are confirmed,
 * before refreshLibrary, including the reverse callback for a confirmed Undo.
 * Identity must be a
 * stable primitive including account generation; refreshLibrary returns Promise.
 * No operation continues or rolls back into a replacement account. */
function installLibraryManagement(root: any): void {
	root.__PIGEON_LIBRARY_MANAGEMENT__ = { mount(adapter: any) {
		const document = root.document;
		const container = adapter.container;
		const identity = adapter.getSessionIdentity();
		let alive = true, busy = false, cancelled = false;
		let undo: (() => Promise<void>) | null = null;
		let preview: LibraryImportEntry[] = [];
		let retry: LibraryMutation[] = [];
		let retryInverse: LibraryMutation[] = [];
		let retryRename: { from: string; to: string } | undefined;
		const current = () => alive && !cancelled && identity === adapter.getSessionIdentity();
		const service = { authenticatedJson: adapter.authenticatedJson, isCurrent: current };
		function element(tag: string, text = ''): any { const node = document.createElement(tag); node.textContent = text; return node; }
		function button(text: string, action: () => void): any { const node = element('button', text); node.type = 'button'; node.addEventListener('click', action); return node; }
		function field(label: string, multiline = false): any {
			const wrapper = element('label'); const title = element('span', label); const input = element(multiline ? 'textarea' : 'input');
			if (!multiline) input.type = 'text'; input.setAttribute('aria-label', label); wrapper.append(title, input); return { wrapper, input };
		}
		function section(title: string): any { const node = element('section'); node.append(element('h3', title)); container.append(node); return node; }
		container.replaceChildren();
		container.append(element('h2', 'Library management'));
		const status = element('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); container.append(status);
		const results = element('ol'); container.append(results);
		const controlBar = element('div'); container.append(controlBar);
		const cancel = button('Stop after current request', () => { cancelled = true; status.textContent = 'Stopping after the current request. Completed changes remain; reopen or refresh to inspect them.'; });
		cancel.hidden = true;
		const undoButton = button('Undo last change', () => { if (undo) void perform(undo); }); undoButton.disabled = true;
		const retryButton = button('Retry unconfirmed operation', () => { if (retry.length) void perform(() => mutate(retry, retryInverse, retryRename)); }); retryButton.hidden = true;
		controlBar.append(cancel, undoButton, retryButton);
		function showRows(rows: string[]): void { results.replaceChildren(...rows.map((row) => element('li', row))); }
		function pending(): void {
			for (const node of container.querySelectorAll('button,input,textarea,select')) node.disabled = busy;
			cancel.hidden = !busy; cancel.disabled = false;
			undoButton.disabled = busy || !undo; retryButton.hidden = !retry.length; retryButton.disabled = busy;
		}
		async function refresh(): Promise<void> { if (!alive || identity !== adapter.getSessionIdentity()) return; await adapter.refreshLibrary(); if (alive && identity === adapter.getSessionIdentity()) renderSubscriptions(); }
		async function perform(action: () => Promise<void>): Promise<void> {
			if (busy || !alive || identity !== adapter.getSessionIdentity()) return;
			busy = true; cancelled = false; status.textContent = 'Working…'; results.replaceChildren(); pending();
			try { await action(); } catch (error) { if (current()) status.textContent = error instanceof Error ? error.message : 'Operation failed.'; }
			finally { if (alive && identity === adapter.getSessionIdentity()) { busy = false; pending(); } }
		}
		async function mutate(changes: LibraryMutation[], inverse: LibraryMutation[] = [], rename?: { from: string; to: string }): Promise<void> {
			const outcome = await libraryRunMutations(service, changes);
			if (!alive || identity !== adapter.getSessionIdentity()) return;
			// Reuse every original id so confirmed steps return receipts and unfinished
			// steps can continue without losing the complete operation's undo snapshot.
			retry = outcome.failed.some((item) => item.uncertain) ? changes : [];
			retryInverse = inverse;
			retryRename = rename;
			status.textContent = outcome.applied.length + ' changes confirmed; ' + outcome.failed.length + ' failed/unconfirmed; ' + outcome.notAttempted.length + ' not attempted.' + (outcome.cancelled ? ' Stopped.' : '');
			showRows([...outcome.applied.map((item) => item.feedId + ': ' + item.kind + ' confirmed'), ...outcome.failed.map((item) => item.mutation.feedId + ': ' + item.error), ...outcome.notAttempted.map((item) => item.feedId + ': not attempted')]);
			const appliedKeys = new Set(outcome.applied.map((item) => item.kind + ':' + item.feedId));
			const toUndo = inverse.filter((item) => appliedKeys.has((item.kind === 'restore_feed' ? 'unsubscribe_feed' : item.kind === 'unsubscribe_feed' ? 'restore_feed' : item.kind) + ':' + item.feedId));
			const renamed = rename && outcome.applied.length === changes.length && !outcome.failed.length && !outcome.cancelled;
			undo = toUndo.length ? async () => { undo = null; await mutate(toUndo.map((item) => ({ ...item, id: crypto.randomUUID() })), [], renamed ? { from: rename.to, to: rename.from } : undefined); } : null;
			if (renamed && current() && adapter.onFolderRenamed) {
				try { await adapter.onFolderRenamed(rename.from, rename.to); }
				catch { if (current()) status.textContent += ' Rename is saved, but reading position could not be updated.'; }
			}
			if (current()) await refresh();
		}
		function mutation(kind: string, feedId: string, fields: any = {}): LibraryMutation { return { id: crypto.randomUUID(), kind, feedId, ...fields }; }
		function foldersEditor(selected: string[]): any {
			const node = element('fieldset'); node.append(element('legend', 'Folders'));
			const names = [...new Set(adapter.getSubscriptions().flatMap(libraryFolderNames))].sort() as string[];
			const checkboxes: any[] = [];
			for (const name of names) { const label = element('label'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.includes(name); checkbox.value = name; label.append(checkbox, document.createTextNode(name)); node.append(label); checkboxes.push(checkbox); }
			const added = field('New folder names (one per line)', true); node.append(added.wrapper);
			return { node, values: () => libraryValidateFolders([...checkboxes.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value), ...added.input.value.split('\n')]) };
		}
		const add = section('Add feeds'); const source = field('Website or feed URL'); const addFolders = foldersEditor([]); add.append(source.wrapper, addFolders.node);
		const candidates = element('div'); add.append(candidates);
		async function importEntries(entries: LibraryImportEntry[]): Promise<void> {
			const outcome = await libraryRunImport(service, entries);
			if (!alive || identity !== adapter.getSessionIdentity()) return;
			status.textContent = `${outcome.added.length} newly added; ${outcome.skipped.length} duplicates skipped; ${outcome.rolledBack.length} unsubscribed during rollback; ${outcome.rollbackFailed.length} rollback failures; ${outcome.uncertain.length} unknown subscription results; ${outcome.notAttempted.length} not attempted.${outcome.cancelled ? ' Stopped; no further requests were made.' : ''}`;
			showRows([...outcome.added.map((item: any) => `${item.title}: ${outcome.rolledBack.includes(item.id) ? 'unsubscribed during rollback' : 'added (inspect library if later editing failed)'}`), ...outcome.skipped.map((title: string) => title + ': duplicate skipped'), ...outcome.rollbackFailed.map((id: string) => id + ': rollback not confirmed'), ...outcome.uncertain.map((title: string) => title + ': subscription result unknown; inspect before retry'), ...(outcome.failed ? [outcome.failed] : []), ...outcome.notAttempted.map((title: string) => title + ': not attempted')]);
			undo = null; retry = []; if (current()) await refresh();
		}
		add.append(button('Add URL', () => void perform(async () => importEntries([{ url: librarySafeURL(source.input.value), title: '', folders: addFolders.values(), duplicateId: null }]))));
		add.append(button('Discover feeds', () => void perform(async () => {
			const payload = await adapter.authenticatedJson('/feeds/discover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: librarySafeURL(source.input.value) }) });
			if (!current()) return; candidates.replaceChildren();
			for (const candidate of (payload.candidates ?? []).slice(0, 20)) { const row = element('div'); row.append(element('p', candidate.title + ' — ' + candidate.url), button('Add this feed', () => void perform(() => importEntries([{ url: librarySafeURL(candidate.url), title: candidate.title.slice(0, 200), folders: addFolders.values(), duplicateId: null }])))); candidates.append(row); }
			status.textContent = candidates.childElementCount ? 'Choose a discovered feed.' : 'No feeds found.';
		})));
		const youtube = field('YouTube channel name or @handle'); add.append(youtube.wrapper, button('Search YouTube', () => void perform(async () => {
			const q = youtube.input.value.trim(); if (q.length < 2 || q.length > 100) throw new Error('Enter 2–100 characters.');
			const payload = await adapter.authenticatedJson('/feeds/youtube/search?q=' + encodeURIComponent(q)); if (!current()) return; candidates.replaceChildren();
			for (const channel of (payload.channels ?? []).slice(0, 8)) { const row = element('div'); row.append(element('p', channel.title), button('Add channel', () => void perform(() => importEntries([{ url: librarySafeURL(channel.feedUrl), title: channel.title.slice(0, 200), folders: addFolders.values(), duplicateId: null }])))); candidates.append(row); }
			status.textContent = payload.message || (candidates.childElementCount ? 'Choose a channel.' : 'No channels found.');
		})));
		const feeds = section('Your subscriptions'); const feedList = element('div'); feeds.append(feedList);
		function renderSubscriptions(): void {
			feedList.replaceChildren();
			for (const subscription of adapter.getSubscriptions()) {
				const details = element('details'); details.append(element('summary', subscription.title));
				const title = field('Feed title'); title.input.value = subscription.title;
				const folderControls = foldersEditor(libraryFolderNames(subscription)); details.append(title.wrapper, folderControls.node);
				details.append(button('Save feed', () => void perform(async () => {
					const next = title.input.value.trim(); if (!next || next.length > 200) throw new Error('Feed title must be 1–200 characters.');
					await mutate([mutation('rename_feed', subscription.id, { title: next }), mutation('move_feed', subscription.id, { folders: folderControls.values() })], [mutation('rename_feed', subscription.id, { title: subscription.title }), mutation('move_feed', subscription.id, { folders: libraryFolderNames(subscription) })]);
				})));
				const confirm = element('label'); const check = element('input'); check.type = 'checkbox'; confirm.append(check, document.createTextNode('Confirm unsubscribe (downloaded stories remain)')); details.append(confirm);
				details.append(button('Unsubscribe feed', () => void perform(async () => { if (!check.checked) throw new Error('Select the unsubscribe confirmation.'); await mutate([mutation('unsubscribe_feed', subscription.id)], [mutation('restore_feed', subscription.id)]); })));
				feedList.append(details);
			}
		}
		const folderSection = section('Rename or delete a folder'); const oldFolder = field('Current folder name'); const newFolder = field('New folder name'); const deleteConfirmation = element('label'); const confirmDelete = element('input'); confirmDelete.type = 'checkbox'; deleteConfirmation.append(confirmDelete, document.createTextNode('Confirm delete folder (feeds remain subscribed)'));
		folderSection.append(oldFolder.wrapper, newFolder.wrapper, deleteConfirmation);
		async function changeFolder(remove: boolean): Promise<void> {
			if (remove && !confirmDelete.checked) throw new Error('Select the folder deletion confirmation.');
			const plan = libraryFolderPlan(adapter.getSubscriptions(), oldFolder.input.value.trim(), remove ? null : newFolder.input.value);
			if (!plan.length) throw new Error('No feeds belong to that folder.');
			await mutate(plan.map((item) => mutation('move_feed', item.feedId, { folders: item.folders })), plan.map((item) => mutation('move_feed', item.feedId, { folders: item.previous })), remove ? undefined : { from: oldFolder.input.value.trim(), to: libraryValidateFolders([newFolder.input.value])[0] });
		}
		folderSection.append(button('Rename folder', () => void perform(() => changeFolder(false))), button('Delete folder', () => void perform(() => changeFolder(true))));
		const opml = section('Import OPML'); opml.append(element('p', 'Preview before importing. Existing subscriptions are skipped. On failure, Pigeon attempts to unsubscribe only feeds confirmed newly created by this import. Rollback is not a transaction and downloaded stories remain.'));
		const file = element('input'); file.type = 'file'; file.accept = '.opml,.xml,text/xml,application/xml'; file.setAttribute('aria-label', 'Choose OPML file');
		const xml = field('OPML XML', true); const previewList = element('ol');
		opml.append(file, xml.wrapper, previewList, button('Preview OPML', () => void perform(async () => {
			const chosen = file.files?.[0]; if (chosen && chosen.size > 1_000_000) throw new Error('OPML file must be at most 1 MB.');
			const text = chosen ? await chosen.text() : xml.input.value; if (!current()) return;
			preview = libraryOPMLPreview(text, adapter.getSubscriptions(), (source) => new root.DOMParser().parseFromString(source, 'application/xml'));
			previewList.replaceChildren(...preview.map((entry) => element('li', entry.title + ' — ' + entry.url + ' — ' + (entry.folders.join(' / ') || 'No folders') + (entry.duplicateId ? ' — Already subscribed; skipped' : ' — New'))));
			status.textContent = `${preview.length} unique feeds previewed. Apply import when ready.`;
		})), button('Apply OPML import', () => void perform(async () => { if (!preview.length) throw new Error('Preview an OPML file first.'); await importEntries(preview); preview = []; previewList.replaceChildren(); })));
		const stale = section('Stale and archived feeds'); stale.append(element('p', 'Feeds with no new story for 90 days. Archive keeps the subscription; unsubscribe can be undone.'));
		const staleList = element('div'); stale.append(staleList);
		async function loadStale(): Promise<void> {
			if (!current()) return;
			const payload = await adapter.authenticatedJson('/api/v1/stale-feeds?days=90'); if (!current()) return; staleList.replaceChildren();
			for (const feed of (payload.feeds ?? []).slice(0, 500)) {
				const row = element('div'); row.append(element('p', feed.title + (feed.archived ? ' — Archived' : '') + ' — Last article: ' + (feed.lastArticleAt || 'none')));
				row.append(button(feed.archived ? 'Restore from archive' : 'Archive feed', () => void perform(async () => {
					const action = feed.archived ? 'unarchive' : 'archive';
					await adapter.authenticatedJson('/api/v1/stale-feeds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, feedKeys: [feed.feedKey] }) }); if (!current()) return;
					undo = async () => { await adapter.authenticatedJson('/api/v1/stale-feeds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: action === 'archive' ? 'unarchive' : 'archive', feedKeys: [feed.feedKey] }) }); if (current()) { undo = null; await refresh(); if (!current()) return; await loadStale(); if (current()) status.textContent = 'Archive change undone.'; } };
					await refresh(); if (!current()) return; await loadStale(); status.textContent = 'Archive change confirmed.';
				})));
				const confirmation = element('label'); const check = element('input'); check.type = 'checkbox'; confirmation.append(check, document.createTextNode('Confirm unsubscribe')); row.append(confirmation);
				row.append(button('Unsubscribe stale feed', () => void perform(async () => { if (!check.checked) throw new Error('Select the unsubscribe confirmation.'); await mutate([mutation('unsubscribe_feed', feed.streamId)], [mutation('restore_feed', feed.streamId)]); if (current()) await loadStale(); })));
				staleList.append(row);
			}
			if (!staleList.childElementCount) staleList.append(element('p', 'No stale or archived feeds.'));
		}
		stale.append(button('Load stale feeds', () => void perform(async () => { await loadStale(); if (current()) status.textContent = 'Stale feeds refreshed.'; })));
		renderSubscriptions(); pending();
		return { refresh, destroy() { alive = false; cancelled = true; container.replaceChildren(); } };
	} };
}

export function renderBrowserLibraryManagementScript(): string {
	return ['function __name(target) { return target; }', librarySafeURL, libraryCanonicalURL, libraryFolderNames, libraryValidateFolders, libraryFolderPlan, libraryOPMLPreview, libraryRunMutations, libraryRunImport, installLibraryManagement]
		.map((item) => typeof item === 'string' ? item : item.toString()).join('\n') + '\ninstallLibraryManagement(window);';
}
