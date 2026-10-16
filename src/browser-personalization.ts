export function normalizeBrowserTopics(values: unknown): string[] {
	if (!Array.isArray(values) || values.length > 20) throw new Error('Monitor at most 20 topics.');
	const result: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (typeof value !== 'string') throw new Error('Topics must be text.');
		const topic = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
		if (topic.length < 2 || topic.length > 80 || !/[\p{L}\p{N}]/u.test(topic)) throw new Error('Each topic must contain 2–80 characters and a letter or number.');
		const key = topic.toLowerCase();
		if (!seen.has(key)) { seen.add(key); result.push(topic); }
	}
	return result;
}

/** create({authenticatedJson,authenticatedFetch,getSessionIdentity}) is bound
 * to the current stable account-generation identity. feedback(readerId,type)
 * uses server mutation receipts and retains the same mutation ID after an
 * uncertain failure. mount({container,onChanged?})->{refresh,destroy} supplies
 * topics, policy, confirmed history, delete/reset confirmation and JSON export.
 * Destroy the service on logout and create another for a replacement account.
 */
function installBrowserPersonalization(root: any): void {
	root.__PIGEON_PERSONALIZATION__ = { create(adapter: any) {
		const identity = adapter.getSessionIdentity();
		let closed = false;
		let resetGeneration = 0;
		let resetting = false;
		let resetPromise: Promise<any> | null = null;
		const pendingWrites = new Set<Promise<any>>();
		const feedbackRequests = new Map<string, { id: string; promise: Promise<any> | null }>();
		const panels = new Set<() => void>();
		const panelPendingUpdates = new Set<() => void>();
		function current() { return !closed && identity === adapter.getSessionIdentity(); }
		function check() { if (!current()) throw new Error('Personalization session changed. Reopen this panel.'); }
		async function json(path: string, init?: RequestInit): Promise<any> {
			check(); const payload = await adapter.authenticatedJson(path, init); check(); return payload;
		}
		function checkGeneration(generation: number) {
			check();
			if (generation !== resetGeneration) {
				const error = new Error('This operation was superseded by resetting preferences.') as Error & { code: string };
				error.code = 'personalization_superseded'; throw error;
			}
		}
		function writeJSON(path: string, init: RequestInit): Promise<any> {
			check();
			const generation = resetGeneration;
			const barrier = resetPromise;
			const operation = (async () => {
				if (barrier) await barrier;
				checkGeneration(generation);
				const payload = await json(path, init);
				checkGeneration(generation);
				return payload;
			})();
			pendingWrites.add(operation);
			void operation.then(() => pendingWrites.delete(operation), () => pendingWrites.delete(operation));
			return operation;
		}
		function notifyResetState() {
			for (const update of panelPendingUpdates) update();
			if (current() && adapter.onResetStateChanged) { try { adapter.onResetStateChanged(resetting); } catch { /* UI callback cannot change a confirmed server operation. */ } }
		}
		function snapshot(value: any): any {
			if (!value || !Array.isArray(value.monitoredTopics) || !Array.isArray(value.history) || !value.policy) throw new Error('Personalization data is unavailable. Try again.');
			normalizeBrowserTopics(value.monitoredTopics);
			return value;
		}
		const service: any = {
			isCurrent: current,
			isResetting: () => resetting,
			getResetGeneration: () => resetGeneration,
			async load() {
				const generation = resetGeneration; const barrier = resetPromise;
				if (barrier) await barrier;
				checkGeneration(generation);
				const payload = await json('/api/v1/personalization'); checkGeneration(generation);
				return snapshot(payload);
			},
			async saveTopics(topics: string[]) {
				const generation = resetGeneration;
				const payload = await writeJSON('/api/v1/personalization', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monitoredTopics: normalizeBrowserTopics(topics) }) });
				checkGeneration(generation); return snapshot(payload);
			},
			async deleteHistory(id: string) {
				if (typeof id !== 'string' || !id || id.length > 200) throw new Error('Invalid history entry.');
				const result = await writeJSON('/api/v1/personalization?id=' + encodeURIComponent(id), { method: 'DELETE' });
				if (result?.deleted !== id) throw new Error('Deletion could not be confirmed. Refresh before retrying.');
				return result;
			},
			resetAll(): Promise<any> {
				check();
				if (resetPromise) return resetPromise;
				const olderWrites = [...pendingWrites];
				resetGeneration += 1;
				feedbackRequests.clear();
				resetting = true;
				const operation = Promise.allSettled(olderWrites).then(async () => {
					check(); const result = await json('/api/v1/personalization?all=1', { method: 'DELETE' });
					if (result?.deleted !== 'all') throw new Error('Reset could not be confirmed. Refresh before retrying.');
					return result;
				});
				const tracked = operation.finally(() => { if (resetPromise === tracked) { resetPromise = null; resetting = false; notifyResetState(); } });
				resetPromise = tracked;
				notifyResetState();
				return tracked;
			},
			async exportData(): Promise<string> {
				check(); const response = await adapter.authenticatedFetch('/api/v1/personalization?download=1'); check();
				if (!response.ok) throw new Error('Could not export personalization data. Try again.');
				const text = await response.text(); check();
				try { const data = JSON.parse(text); if (!Array.isArray(data.history) || !Array.isArray(data.monitoredTopics)) throw new Error(); }
				catch { throw new Error('The export was incomplete. Try again.'); }
				return text;
			},
			feedback(readerId: string, type: string): Promise<any> {
				check();
				if (typeof readerId !== 'string' || !/^(?:[1-9]\d{0,15}|[0-9a-f]{16}|tag:google\.com,2005:reader\/item\/[0-9a-f]{16}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(readerId)
					|| !['more_like_this', 'not_interested'].includes(type)) throw new Error('Invalid article feedback.');
				const key = readerId + ':' + type;
				let request = feedbackRequests.get(key);
				if (request?.promise) return request.promise;
				if (!request) { request = { id: crypto.randomUUID(), promise: null }; feedbackRequests.set(key, request); }
				const active = request;
				const generation = resetGeneration;
				active.promise = writeJSON('/api/v1/mutations', { method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ mutations: [{ id: active.id, kind: 'feedback', itemIds: [readerId], feedback: type }] }) })
					.then((payload) => {
						checkGeneration(generation);
						const receipt = payload?.results?.find((result: any) => result.mutationId === active.id);
						if (!['applied', 'already_applied'].includes(receipt?.status)) throw new Error('Feedback was not confirmed. Retry to check the same operation.');
						if (feedbackRequests.get(key) === active) feedbackRequests.delete(key);
						return { confirmed: true, mutationId: active.id };
					}).finally(() => { active.promise = null; });
				return active.promise;
			},
			mount(options: any) {
				const document = root.document;
				const container = options.container;
				let alive = true, busy = false, state: any = null, exportURL: string | null = null;
				function visible() { return alive && current(); }
				function element(tag: string, text = ''): any { const node = document.createElement(tag); node.textContent = text; return node; }
				function button(text: string, action: () => void): any { const node = element('button', text); node.type = 'button'; node.addEventListener('click', action); return node; }
				container.replaceChildren(); container.append(element('h2', 'Personalization'));
				const status = element('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
				const policy = element('section'); const topics = element('section'); const history = element('section'); const exports = element('section');
				container.append(status, policy, topics, history, exports);
				function pending() { for (const node of container.querySelectorAll('button,input,textarea')) node.disabled = busy || resetting; }
				panelPendingUpdates.add(pending);
				async function run(action: () => Promise<void>) {
					if (!visible() || busy || resetting) return;
					busy = true; status.textContent = 'Working…'; pending();
					try { await action(); } catch (error) { if (visible()) status.textContent = error instanceof Error ? error.message : 'Could not complete the operation. Try again.'; }
					finally { if (visible()) { busy = false; pending(); } }
				}
				async function changed() {
					if (visible() && options.onChanged) {
						try { await options.onChanged(); }
						catch { if (visible()) status.textContent += ' The change is saved, but recommendations could not refresh. Try refreshing again.'; }
					}
				}
				function render(value: any) {
					if (!visible()) return;
					state = value;
					policy.replaceChildren(element('h3', 'How recommendations work'), element('p', value.policy.plainLanguageSummary || 'Recommendations use confirmed activity from your subscriptions.'));
					const signals = element('ul');
					for (const signal of value.policy.confirmedSignals ?? []) signals.append(element('li', signal.name + ': ' + signal.effect));
					policy.append(signals, element('p', value.policy.confirmationRule || ''), element('p', value.policy.retention || ''));
					topics.replaceChildren(element('h3', 'Topics to monitor'), element('p', 'Prioritize matching stories from existing subscriptions. Topics do not create subscriptions or notifications.'));
					const label = element('label', 'New topic'); const input = element('input'); input.type = 'text'; input.maxLength = 80; input.setAttribute('aria-label', 'New monitored topic'); label.append(input);
					topics.append(label, button('Add topic', () => void run(async () => {
						const next = await service.saveTopics([...state.monitoredTopics, input.value]); if (!visible()) return;
						render(next); status.textContent = 'Topic preferences saved.'; await changed();
					})));
					const list = element('ul');
					for (const topic of value.monitoredTopics) { const row = element('li'); row.append(element('span', topic), button('Remove topic ' + topic, () => void run(async () => {
						const next = await service.saveTopics(state.monitoredTopics.filter((candidate: string) => candidate !== topic)); if (!visible()) return;
						render(next); status.textContent = 'Topic removed.'; await changed();
					}))); list.append(row); }
					topics.append(list, element('p', value.monitoredTopics.length + ' of 20 topics monitored.'));
					history.replaceChildren(element('h3', 'Confirmed signal history'), element('p', 'Up to 500 recent confirmed signals are shown. Export includes the full history.'));
					if (!value.history.length) history.append(element('p', 'No confirmed signals yet.'));
					for (const entry of value.history) {
						const titles: Record<string, string> = { explicit_open: 'Opened story', active_reading: 'Active reading', scroll_depth: 'Reading progress', outbound_link: 'Opened source', star: 'Starred', unstar: 'Unstarred', more_like_this: 'More like this', not_interested: 'Not interested', read: 'Marked read', unread: 'Marked unread' };
						const date = new Date(entry.occurredAt);
						const row = element('article'); row.append(element('p', (entry.title || 'Untitled story') + ' — ' + (entry.source || 'Unknown source')), element('p', (titles[entry.type] || 'Confirmed activity') + ' — ' + (Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unknown time')));
						const confirmation = element('div');
						row.append(button('Delete signal', () => {
							if (busy || !visible()) return;
							confirmation.replaceChildren(element('p', 'Permanently delete this confirmed signal?'), button('Confirm delete signal', () => void run(async () => {
								await service.deleteHistory(entry.id); const next = await service.load(); if (!visible()) return;
								render(next); status.textContent = 'Signal deleted.'; await changed();
							})), button('Cancel deletion', () => confirmation.replaceChildren()));
						}), confirmation); history.append(row);
					}
					const resetLabel = element('label'); const resetCheck = element('input'); resetCheck.type = 'checkbox'; resetLabel.append(resetCheck, document.createTextNode('I understand reset permanently deletes all monitored topics and confirmed signal history.'));
					history.append(resetLabel, element('p', 'Read and starred article state stays unchanged.'), button('Reset all preferences', () => void run(async () => {
						if (!resetCheck.checked) throw new Error('Select the reset confirmation first.');
						await service.resetAll(); const next = await service.load(); if (!visible()) return;
						render(next); status.textContent = 'All preferences reset.'; await changed();
					})));
					pending();
				}
				exports.append(element('h3', 'Export your data'));
				const exportLink = element('div'); exports.append(exportLink, button('Export personalization JSON', () => void run(async () => {
					const text = await service.exportData(); if (!visible()) return;
					if (exportURL) root.URL.revokeObjectURL(exportURL);
					exportURL = root.URL.createObjectURL(new root.Blob([text], { type: 'application/json' }));
					const link = element('a', 'Download personalization JSON'); link.href = exportURL; link.download = 'pigeon-personalization.json'; exportLink.replaceChildren(link);
					status.textContent = 'Full export is ready to download.';
				})));
				async function refresh() { await run(async () => { render(await service.load()); if (visible()) status.textContent = 'Personalization loaded.'; }); }
				container.append(button('Refresh personalization', () => void refresh()));
				void refresh();
				function destroy() { if (!alive) return; alive = false; panels.delete(destroy); panelPendingUpdates.delete(pending); if (exportURL) root.URL.revokeObjectURL(exportURL); container.replaceChildren(); }
				panels.add(destroy);
				return { refresh, destroy };
			},
			destroy() { closed = true; feedbackRequests.clear(); for (const destroy of panels) destroy(); },
		};
		return service;
	} };
}

export function renderBrowserPersonalizationScript(): string {
	return 'function __name(target) { return target; }\n' + normalizeBrowserTopics.toString() + '\n' + installBrowserPersonalization.toString() + '\ninstallBrowserPersonalization(window);';
}
