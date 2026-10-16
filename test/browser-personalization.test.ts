import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { normalizeBrowserTopics, renderBrowserPersonalizationScript } from '../src/browser-personalization';
import { normalizeMonitoredTopics } from '../src/topic-preferences';

function snapshot(topics = ['SwiftUI'], history: any[] = []) {
	return { exportedAt: '2026-10-12T12:00:00Z', monitoredTopics: topics, history,
		policy: { plainLanguageSummary: 'Confirmed activity affects ranking.', confirmedSignals: [{ name: 'Bulk read actions', effect: 'Neutral' }], confirmationRule: 'Only confirmed signals.', retention: 'Retained until deleted.' } };
}

function createService(adapter: any = {}) {
	let identity = 'account-1';
	const window: any = {};
	runInNewContext(renderBrowserPersonalizationScript(), { window, URL, TextEncoder, crypto });
	const service = window.__PIGEON_PERSONALIZATION__.create({ authenticatedJson: async () => snapshot(), authenticatedFetch: async () => new Response(JSON.stringify(snapshot())), getSessionIdentity: () => identity, ...adapter });
	return { service, window, setIdentity: (value: string) => { identity = value; } };
}

test('browser topic normalization matches backend Unicode, whitespace, dedupe and count rules', () => {
	for (const values of [[], [' SwiftUI ', 'swiftui', 'Swift\n concurrency'], ['Ｃｌｉｍａｔｅ', 'Climate', '日本語'], ['Product, design'], Array.from({ length: 20 }, (_, i) => 'Topic ' + i)]) {
		assert.deepEqual(normalizeBrowserTopics(values), normalizeMonitoredTopics(values));
	}
	for (const values of [null, ['x'], ['!!!'], ['x'.repeat(81)], [1], Array.from({ length: 21 }, () => 'same topic')]) {
		assert.throws(() => normalizeBrowserTopics(values)); assert.throws(() => normalizeMonitoredTopics(values));
	}
});

test('topics/history/reset use precise route bodies and require confirmed responses', async () => {
	const calls: Array<{ path: string; init?: RequestInit }> = [];
	const { service } = createService({ authenticatedJson: async (path: string, init?: RequestInit) => {
		calls.push({ path, init });
		if (init?.method === 'DELETE') return { deleted: path.includes('all=1') ? 'all' : 'signal/one' };
		return snapshot(['Climate']);
	} });
	await service.load(); await service.saveTopics([' Climate ', 'climate']); await service.deleteHistory('signal/one'); await service.resetAll();
	assert.deepEqual(calls.map((item) => item.path), ['/api/v1/personalization', '/api/v1/personalization', '/api/v1/personalization?id=signal%2Fone', '/api/v1/personalization?all=1']);
	assert.equal(calls[1].init!.method, 'PUT'); assert.deepEqual(JSON.parse(calls[1].init!.body as string), { monitoredTopics: ['Climate'] });
	assert.equal(calls[2].init!.method, 'DELETE'); assert.equal(calls[3].init!.method, 'DELETE');
	const invalid = createService({ authenticatedJson: async () => ({ deleted: 'wrong' }) }).service;
	await assert.rejects(invalid.deleteHistory('one'), /could not be confirmed/);
	await assert.rejects(invalid.resetAll(), /could not be confirmed/);
});

test('feedback coalesces pending requests, retries the same mutation id after uncertainty, then permits a fresh confirmed action', async () => {
	const mutations: any[] = [];
	let resolve: ((value: any) => void) | null = null;
	let mode = 'pending';
	const { service } = createService({ authenticatedJson: async (_: string, init: RequestInit) => {
		const mutation = JSON.parse(init.body as string).mutations[0]; mutations.push(mutation);
		if (mode === 'pending') return new Promise((done) => { resolve = done; });
		return { results: [{ mutationId: mutation.id, status: 'already_applied' }] };
	} });
	const first = service.feedback('tag:google.com,2005:reader/item/0000000000000007', 'more_like_this');
	const coalesced = service.feedback('tag:google.com,2005:reader/item/0000000000000007', 'more_like_this');
	assert.equal(first, coalesced); assert.equal(mutations.length, 1);
	(resolve as unknown as (value: any) => void)({ results: [] });
	await assert.rejects(first, /not confirmed/);
	mode = 'confirm';
	const result = await service.feedback('tag:google.com,2005:reader/item/0000000000000007', 'more_like_this');
	assert.equal(result.confirmed, true); assert.equal(mutations[0].id, mutations[1].id);
	assert.equal(mutations[1].kind, 'feedback'); assert.deepEqual(mutations[1].itemIds, ['tag:google.com,2005:reader/item/0000000000000007']);
	assert.equal(mutations[1].feedback, 'more_like_this');
	await service.feedback('tag:google.com,2005:reader/item/0000000000000007', 'more_like_this');
	assert.notEqual(mutations[1].id, mutations[2].id);
	assert.throws(() => service.feedback('bad ID', 'more_like_this'), /Invalid/);
	assert.throws(() => service.feedback('7', 'unknown'), /Invalid/);
});

test('service guards both sides of asynchronous operations and does not write into another session', async () => {
	let resolve: ((value: any) => void) | null = null; let calls = 0;
	const harness = createService({ authenticatedJson: async () => { calls++; return new Promise((done) => { resolve = done; }); } });
	const pending = harness.service.load(); harness.setIdentity('account-2');
	(resolve as unknown as (value: any) => void)(snapshot());
	await assert.rejects(pending, /session changed/);
	await assert.rejects(harness.service.saveTopics(['Climate']), /session changed/);
	assert.equal(calls, 1);
	assert.throws(() => harness.service.feedback('7', 'not_interested'), /session changed/);
	const normal = createService(); normal.service.destroy(); await assert.rejects(normal.service.load(), /session changed/);
});

test('export preserves complete history beyond panel limit and rejects incomplete/error responses', async () => {
	const full = JSON.stringify(snapshot(['Climate'], Array.from({ length: 1201 }, (_, i) => ({ id: 'signal-' + i }))));
	let url = '';
	const { service } = createService({ authenticatedFetch: async (path: string) => { url = path; return new Response(full); } });
	assert.equal(await service.exportData(), full); assert.equal(url, '/api/v1/personalization?download=1');
	await assert.rejects(createService({ authenticatedFetch: async () => new Response('partial json') }).service.exportData(), /incomplete/);
	await assert.rejects(createService({ authenticatedFetch: async () => new Response('unavailable', { status: 503 }) }).service.exportData(), /Could not export/);
});

test('reset waits for older feedback, suppresses its stale confirmation and preserves explicitly newer feedback behind the barrier', async () => {
	let resolveOlder!: (value: any) => void;
	const calls: any[] = []; const resetStates: boolean[] = []; const history: string[] = [];
	const { service } = createService({ onResetStateChanged: (value: boolean) => resetStates.push(value), authenticatedJson: async (path: string, init: RequestInit) => {
		if (path.includes('all=1')) { calls.push('reset'); history.length = 0; return { deleted: 'all' }; }
		const change = JSON.parse(init.body as string).mutations[0]; calls.push(change);
		if (calls.length === 1) return new Promise((resolve) => { resolveOlder = (value) => { history.push('old'); resolve(value); }; });
		history.push('new'); return { results: [{ mutationId: change.id, status: 'applied' }] };
	} });
	const older = service.feedback('7', 'more_like_this');
	const stale = assert.rejects(older, (error: any) => error.code === 'personalization_superseded');
	const reset = service.resetAll();
	assert.equal(service.isResetting(), true); assert.equal(service.getResetGeneration(), 1);
	const newer = service.feedback('8', 'not_interested');
	assert.equal(calls.length, 1, 'reset and new feedback must wait for the older write');
	resolveOlder({ results: [{ mutationId: calls[0].id, status: 'applied' }] });
	await stale; await reset; const fresh = await newer;
	assert.equal(fresh.confirmed, true); assert.deepEqual(calls.map((item) => typeof item === 'string' ? item : item.itemIds[0]), ['7', 'reset', '8']);
	assert.deepEqual(history, ['new']); assert.deepEqual(resetStates, [true, false]); assert.equal(service.isResetting(), false);
});

test('reset discards retained uncertain feedback IDs and serializes earlier topic writes before clearing preferences', async () => {
	const mutations: any[] = []; let failing = true;
	const { service } = createService({ authenticatedJson: async (path: string, init: RequestInit) => {
		if (path.includes('all=1')) return { deleted: 'all' };
		const change = JSON.parse(init.body as string).mutations[0]; mutations.push(change);
		if (failing) throw new Error('uncertain network failure');
		return { results: [{ mutationId: change.id, status: 'applied' }] };
	} });
	await assert.rejects(service.feedback('7', 'more_like_this'), /network/);
	await service.resetAll(); failing = false;
	await service.feedback('7', 'more_like_this');
	assert.notEqual(mutations[0].id, mutations[1].id, 'explicit post-reset feedback must not revive the pre-reset retry');
	let resolveTopics!: (value: any) => void; const writes: string[] = [];
	const topicService = createService({ authenticatedJson: async (path: string, init: RequestInit) => {
		writes.push(init.method!);
		if (init.method === 'PUT') return new Promise((resolve) => { resolveTopics = resolve; });
		return { deleted: 'all' };
	} }).service;
	const topics = topicService.saveTopics(['Old topic']); const superseded = assert.rejects(topics, /superseded/);
	const resetting = topicService.resetAll(); assert.deepEqual(writes, ['PUT']);
	resolveTopics(snapshot(['Old topic'])); await superseded; await resetting;
	assert.deepEqual(writes, ['PUT', 'DELETE']);
});

test('failed reset releases the busy state, blocks queued feedback and cannot cross an account switch', async () => {
	let resolveReset!: (value: any) => void; const calls: string[] = [];
	const harness = createService({ authenticatedJson: async (path: string) => { calls.push(path); return new Promise((resolve) => { resolveReset = resolve; }); } });
	const reset = harness.service.resetAll(); await settle(() => calls.length === 1);
	const failed = assert.rejects(reset, /could not be confirmed/);
	const feedback = harness.service.feedback('7', 'more_like_this'); const blocked = assert.rejects(feedback, /could not be confirmed/);
	resolveReset({ deleted: 'wrong' }); await failed; await blocked;
	assert.equal(calls.length, 1); assert.equal(harness.service.isResetting(), false);
	const changed = harness.service.resetAll(); const rejected = assert.rejects(changed, /session changed/);
	harness.setIdentity('account-2'); await rejected;
	assert.equal(calls.length, 1, 'new-account reset must not be sent'); assert.equal(harness.service.isResetting(), false);
});

class Element {
	children: Element[] = []; attrs: Record<string, string> = {}; actions: Record<string, () => void> = {};
	own = ''; value = ''; checked = false; disabled = false; type = ''; href = ''; download = '';
	constructor(readonly tag: string) {}
	set textContent(value: string) { this.own = value; this.children = []; }
	get textContent(): string { return this.own + this.children.map((child) => child.textContent).join(''); }
	set innerHTML(_: string) { throw new Error('Markup must be inert text.'); }
	append(...nodes: Element[]) { this.children.push(...nodes); }
	replaceChildren(...nodes: Element[]) { this.own = ''; this.children = nodes; }
	setAttribute(key: string, value: string) { this.attrs[key] = value; }
	addEventListener(key: string, callback: () => void) { this.actions[key] = callback; }
	querySelectorAll(tags: string): Element[] { return this.children.flatMap((child) => [...(tags.split(',').includes(child.tag) ? [child] : []), ...child.querySelectorAll(tags)]); }
	click() { if (!this.disabled) this.actions.click?.(); }
}

async function settle(condition: () => boolean) {
	for (let i = 0; i < 30 && !condition(); i++) await new Promise<void>((done) => setImmediate(done));
	assert.ok(condition(), 'personalization operation did not settle');
}

test('panel renders untrusted data as text, requires delete/reset confirmation, and releases export URLs on destroy', async () => {
	let data = snapshot(['SwiftUI'], [{ id: 'sig-one', title: '<img src=x onerror=evil()>', source: '<script>evil()</script>', type: 'more_like_this', occurredAt: '2026-10-12T12:00:00Z' }]);
	const writes: string[] = []; const revoked: string[] = [];
	const harness = createService({ authenticatedJson: async (path: string, init?: RequestInit) => {
		if (init?.method === 'DELETE') {
			writes.push(path);
			if (path.includes('all=1')) { data = snapshot([], []); return { deleted: 'all' }; }
			data.history = []; return { deleted: 'sig-one' };
		}
		return structuredClone(data);
	} });
	harness.window.document = { createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => { const node = new Element('#text'); node.textContent = text; return node; } };
	harness.window.Blob = Blob;
	harness.window.URL = { createObjectURL: () => 'blob:personalization-fixture', revokeObjectURL: (url: string) => revoked.push(url) };
	const container = new Element('div');
	const panel = harness.service.mount({ container });
	const button = (label: string) => container.querySelectorAll('button').find((node) => node.textContent === label)!;
	await settle(() => container.textContent.includes('Personalization loaded.'));
	assert.ok(container.textContent.includes('<img src=x onerror=evil()>')); assert.equal(container.querySelectorAll('img,script').length, 0);
	assert.ok(container.textContent.includes('More like this'));
	button('Delete signal').click(); assert.equal(writes.length, 0);
	button('Confirm delete signal').click(); await settle(() => container.textContent.includes('Signal deleted.'));
	assert.deepEqual(writes, ['/api/v1/personalization?id=sig-one']);
	button('Reset all preferences').click(); await settle(() => container.textContent.includes('Select the reset confirmation first.'));
	assert.equal(writes.length, 1);
	container.querySelectorAll('input').find((node) => node.type === 'checkbox')!.checked = true;
	button('Reset all preferences').click(); await settle(() => container.textContent.includes('All preferences reset.'));
	assert.equal(writes.length, 2);
	button('Export personalization JSON').click(); await settle(() => container.textContent.includes('Full export is ready'));
	const download = container.querySelectorAll('a')[0]; assert.equal(download.href, 'blob:personalization-fixture'); assert.equal(download.download, 'pigeon-personalization.json');
	panel.destroy(); assert.deepEqual(revoked, ['blob:personalization-fixture']); assert.equal(container.children.length, 0);
});
