import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
	libraryCanonicalURL, libraryFolderNames, libraryFolderPlan, libraryOPMLPreview, libraryMutationMessage,
	libraryRunImport, libraryRunMutations, librarySafeURL, renderBrowserLibraryManagementScript,
	type LibraryMutation, type LibrarySubscription,
} from '../src/browser-library-management';

// Adapter produces the native DOMParser shape while exercising real XML validation.
function parseXML(text: string): any {
	const valid = XMLValidator.validate(text) === true;
	function node(tagName: string, children: any[] = [], attributes: any[] = []) { return { tagName, children, attributes }; }
	function convert(records: any[]): any[] {
		return records.flatMap((record) => Object.keys(record).filter((key) => key !== ':@' && key !== '#text' && !key.startsWith('?')).map((key) =>
			node(key, convert(record[key]), Object.entries(record[':@'] ?? {}).map(([name, value]) => ({ name, value })))));
	}
	const root = valid ? convert(new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', preserveOrder: true }).parse(text))[0] : node('parsererror');
	return { documentElement: root, getElementsByTagName: (name: string) => name === 'parsererror' && !valid ? [root] : [] };
}

const subscriptions: LibrarySubscription[] = [
	{ id: 'feed/1', title: 'Existing', sourceUrl: 'https://example.com/feed/', categories: [{ id: 'user/-/label/Keep, commas', label: 'Keep, commas' }, { id: 'user/-/label/Old', label: 'Old' }] },
	{ id: 'feed/2', title: 'Second', sourceUrl: 'https://other.example/feed', categories: [{ id: 'user/-/label/Old', label: 'Old' }, { id: 'user/-/label/Other' }] },
];

test('folder rename/delete preserves every unrelated exact label, including commas and literal percent escapes', () => {
	assert.deepEqual(libraryFolderNames(subscriptions[1]), ['Old', 'Other']);
	assert.deepEqual(libraryFolderPlan(subscriptions, 'Old', 'New').map((item) => item.folders), [['Keep, commas', 'New'], ['New', 'Other']]);
	assert.deepEqual(libraryFolderPlan(subscriptions, 'Old', null).map((item) => item.folders), [['Keep, commas'], ['Other']]);
	assert.throws(() => libraryFolderPlan(subscriptions, 'Old', 'other'), /already exists/);
	assert.deepEqual(libraryFolderPlan(subscriptions, 'Old', 'OLD').map((item) => item.folders), [['Keep, commas', 'OLD'], ['OLD', 'Other']]);
	assert.throws(() => libraryFolderPlan(subscriptions, 'Old', 'KEEP, COMMAS'), /already exists/);
	assert.throws(() => libraryFolderPlan(Array.from({ length: 101 }, (_, i) => ({ ...subscriptions[0], id: `feed/${i + 1}` })), 'Old', null), /100/);
	assert.deepEqual(libraryFolderNames({ id: 'feed/9', title: 'P', categories: [{ id: 'user/-/label/100%25 日本語 / News' }] }), ['100%25 日本語 / News']);
});

test('library results name feeds and human actions without exposing mutation kinds or IDs', () => {
	assert.equal(libraryMutationMessage({ id: 'receipt', kind: 'rename_feed', feedId: 'feed/1', title: 'New title' }, 'Old title', 'saved'), 'New title: Feed renamed.');
	assert.equal(libraryMutationMessage({ id: 'receipt', kind: 'move_feed', feedId: 'feed/1' }, 'Design Weekly', 'failed'), 'Design Weekly: The folder update was not saved.');
	assert.equal(libraryMutationMessage({ id: 'receipt', kind: 'unsubscribe_feed', feedId: 'feed/1' }, 'Design Weekly', 'uncertain'), 'Design Weekly: Could not confirm the unsubscribe. Retry this operation to check.');
	assert.equal(libraryMutationMessage({ id: 'receipt', kind: 'restore_feed', feedId: 'feed/1' }, 'Design Weekly', 'saved'), 'Design Weekly: Subscription restored.');
});

test('OPML previews nested folder memberships and merges duplicate URLs while marking existing subscriptions', () => {
	const entries = libraryOPMLPreview(`<opml version="2.0"><head/><body>
		<outline text="Design, news"><outline title="Existing title" xmlUrl="https://example.com/feed#fragment"/></outline>
		<outline text="Parent"><outline text="日本語"><outline text="New" xmlUrl="https://new.example/rss"/></outline></outline>
		<outline text="Other"><outline xmlUrl="https://new.example/rss#again"/></outline>
	</body></opml>`, subscriptions, parseXML);
	assert.deepEqual(entries, [
		{ url: 'https://example.com/feed', title: 'Existing title', folders: ['Design, news'], duplicateId: 'feed/1' },
		{ url: 'https://new.example/rss', title: 'New', folders: ['Parent', '日本語', 'Other'], duplicateId: null },
	]);
	assert.equal(libraryCanonicalURL('HTTPS://EXAMPLE.COM:443/feed/#fragment'), 'https://example.com/feed');
});

test('OPML rejects DTDs/entities/parser errors/root ambiguity/unsafe URLs and limits before writing', () => {
	for (const xml of [
		'<!DOCTYPE opml [<!ENTITY external SYSTEM "file:///etc/passwd">]><opml><body/></opml>',
		'<opml><body><outline></body></opml>', '<rss><body/></rss>', '<opml><body/><body/></opml>',
		'<opml><body><outline xmlUrl="javascript:alert(1)"/></body></opml>',
		'<opml><body><outline xmlUrl="http://127.0.0.1/"/></body></opml>',
		'<opml><body><outline xmlUrl="https://public.example" XMLURL="https://other.example"/></body></opml>',
		'<opml><body><outline text="Empty"/></body></opml>',
	]) assert.throws(() => libraryOPMLPreview(xml, [], parseXML), undefined, xml);
	assert.throws(() => libraryOPMLPreview('x'.repeat(1_000_001), [], parseXML), /1 MB/);
	const tooMany = `<opml><body>${Array.from({ length: 101 }, (_, i) => `<outline xmlUrl="https://public.example/${i}"/>`).join('')}</body></opml>`;
	assert.throws(() => libraryOPMLPreview(tooMany, [], parseXML), /100 unique/);
	assert.throws(() => libraryOPMLPreview('<opml><body>' + '<outline text="Nested">'.repeat(21) + '<outline xmlUrl="https://public.example"/>' + '</outline>'.repeat(21) + '</body></opml>', [], parseXML), /nesting/);
	for (const url of ['javascript:alert(1)', 'file:///tmp/x', 'http://2130706433', 'https://user:pass@public.example', 'http://10.1.2.3', 'https://host.internal']) assert.throws(() => librarySafeURL(url));
});

function mutation(id: string, feedId = 'feed/1'): LibraryMutation { return { id, kind: 'unsubscribe_feed', feedId }; }
function receipt(change: LibraryMutation, status = 'applied') { return { results: [{ mutationId: change.id, status }] }; }

test('mutations report exact partial receipts and stop after known failure', async () => {
	const changes = [mutation('one'), mutation('two', 'feed/2'), mutation('three', 'feed/3')];
	const calls: LibraryMutation[] = [];
	const outcome = await libraryRunMutations({ isCurrent: () => true, authenticatedJson: async (path, init) => {
		assert.equal(path, '/api/v1/mutations'); const change = JSON.parse(init!.body as string).mutations[0]; calls.push(change);
		return calls.length === 1 ? receipt(change, 'already_applied') : { results: [{ mutationId: change.id, status: 'failed', error: 'Feed missing' }] };
	} }, changes);
	assert.deepEqual(outcome.applied, [changes[0]]); assert.equal(outcome.failed[0].uncertain, false);
	assert.deepEqual(outcome.notAttempted, [changes[2]]); assert.equal(calls.length, 2);
});

test('uncertain mutations retain their idempotency key for safe receipt retry', async () => {
	const changes = [mutation('stable-id'), mutation('later')];
	const failed = await libraryRunMutations({ isCurrent: () => true, authenticatedJson: async () => { throw new Error('network'); } }, changes);
	assert.equal(failed.failed[0].uncertain, true); assert.equal(failed.failed[0].mutation.id, 'stable-id');
	assert.deepEqual(failed.notAttempted, [changes[1]]);
	const retried = await libraryRunMutations({ isCurrent: () => true, authenticatedJson: async (_, init) => receipt(JSON.parse(init!.body as string).mutations[0], 'already_applied') }, failed.failed.map((item) => item.mutation));
	assert.equal(retried.applied[0].id, 'stable-id');
});

test('mutation sequence isolates session changes and cancels before starting another request', async () => {
	let current = true; let calls = 0;
	const outcome = await libraryRunMutations({ isCurrent: () => current, authenticatedJson: async (_, init) => { calls++; current = false; return receipt(JSON.parse(init!.body as string).mutations[0]); } }, [mutation('one'), mutation('two')]);
	assert.equal(outcome.cancelled, true); assert.equal(calls, 1); assert.equal(outcome.applied.length, 1); assert.equal(outcome.notAttempted.length, 1);
	const before = await libraryRunMutations({ isCurrent: () => false, authenticatedJson: async () => { throw new Error('must not call'); } }, [mutation('one')]);
	assert.equal(before.cancelled, true); assert.equal(before.notAttempted.length, 1);
});

const entries = [
	{ url: 'https://one.example/rss', title: 'One', folders: ['Keep, commas'], duplicateId: null },
	{ url: 'https://two.example/rss', title: 'Two', folders: ['Second'], duplicateId: null },
	{ url: 'https://three.example/rss', title: 'Three', folders: [], duplicateId: null },
];

test('import applies title/folder changes sequentially and skips known or server-discovered duplicates', async () => {
	const calls: string[] = []; const changes: LibraryMutation[] = [];
	const outcome = await libraryRunImport({ isCurrent: () => true, authenticatedJson: async (path, init) => {
		calls.push(path);
		if (path.includes('quickadd')) return { streamId: 'feed/7', isNew: !path.includes('two.example') };
		const change = JSON.parse(init!.body as string).mutations[0]; changes.push(change); return receipt(change);
	} }, [{ ...entries[0], duplicateId: 'feed/1' }, entries[1], entries[2]]);
	assert.equal(outcome.skipped.length, 2); assert.deepEqual(outcome.added, [{ id: 'feed/7', title: 'Three' }]);
	assert.deepEqual(changes.map((change) => change.kind), ['move_feed', 'rename_feed']);
	assert.equal(calls.filter((path) => path.includes('quickadd')).length, 2); assert.equal(outcome.failed, null);
});

test('import failure rolls back only confirmed new subscriptions, reporting each compensating result', async () => {
	const changes: LibraryMutation[] = [];
	let nextFeed = 7;
	const outcome = await libraryRunImport({ isCurrent: () => true, authenticatedJson: async (path, init) => {
		if (path.includes('quickadd')) return { streamId: `feed/${nextFeed++}`, isNew: true };
		const change = JSON.parse(init!.body as string).mutations[0]; changes.push(change);
		if (change.feedId === 'feed/8' && change.kind === 'move_feed') return { results: [{ mutationId: change.id, status: 'failed', error: 'Rejected' }] };
		if (change.feedId === 'feed/7' && change.kind === 'unsubscribe_feed') throw new Error('rollback network error');
		return receipt(change);
	} }, [{ ...entries[0], duplicateId: 'feed/1' }, entries[0], entries[1], entries[2]]);
	assert.equal(outcome.added.length, 2); assert.deepEqual(outcome.rolledBack, ['feed/8']); assert.deepEqual(outcome.rollbackFailed, ['feed/7']);
	assert.deepEqual(outcome.notAttempted, ['Three']); assert.equal(outcome.uncertain.length, 0);
	assert.deepEqual(changes.filter((change) => change.kind === 'unsubscribe_feed').map((change) => change.feedId), ['feed/8', 'feed/7']);
	assert.ok(!changes.some((change) => change.feedId === 'feed/1'));
});

test('unknown subscription result is explicit and never used as rollback ownership evidence', async () => {
	let calls = 0;
	const outcome = await libraryRunImport({ isCurrent: () => true, authenticatedJson: async () => { calls++; throw new Error('network after send'); } }, entries);
	assert.deepEqual(outcome.uncertain, ['One']); assert.equal(outcome.added.length, 0); assert.equal(outcome.rolledBack.length, 0); assert.equal(calls, 1);
	assert.deepEqual(outcome.notAttempted, ['Two', 'Three']);
});

test('import stops on session change and never rolls back using a replacement account', async () => {
	let current = true; let calls = 0;
	const outcome = await libraryRunImport({ isCurrent: () => current, authenticatedJson: async () => { calls++; current = false; return { streamId: 'feed/7', isNew: true }; } }, entries);
	assert.equal(outcome.cancelled, true); assert.equal(outcome.added.length, 1); assert.equal(calls, 1); assert.deepEqual(outcome.rolledBack, []);
	let rollbackCalls = 0;
	const cancelledRollback = await libraryRunImport({ isCurrent: () => current, authenticatedJson: async () => { rollbackCalls++; throw new Error(); } }, entries);
	assert.equal(cancelledRollback.cancelled, true); assert.equal(rollbackCalls, 0);
});

test('emitted module is executable and installs the documented mount adapter without a DOM or side effects', () => {
	const window: any = {};
	runInNewContext(renderBrowserLibraryManagementScript(), { window, URL, TextEncoder, crypto });
	assert.equal(typeof window.__PIGEON_LIBRARY_MANAGEMENT__.mount, 'function');
	assert.equal(Object.keys(window).length, 1);
});

class TestElement {
	children: TestElement[] = [];
	attributes: Record<string, string> = {};
	listeners: Record<string, () => void> = {};
	ownText = '';
	parent: TestElement | null = null;
	type = ''; value = ''; disabled = false; hidden = false; checked = false;
	constructor(readonly tagName: string) {}
	set textContent(value: string) { this.ownText = value; this.children = []; }
	get textContent(): string { return this.ownText + this.children.map((child) => child.textContent).join(''); }
	set innerHTML(_: string) { throw new Error('Untrusted markup must never be rendered.'); }
	get childElementCount() { return this.children.length; }
	append(...children: TestElement[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
	replaceChildren(...children: TestElement[]) { this.children = []; this.ownText = ''; this.append(...children); }
	setAttribute(name: string, value: string) { this.attributes[name] = value; }
	addEventListener(name: string, action: () => void) { this.listeners[name] = action; }
	querySelectorAll(selectors: string): TestElement[] {
		const tags = selectors.split(',');
		return this.children.flatMap((child) => [...(tags.includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selectors)]);
	}
	click() { if (!this.disabled) this.listeners.click?.(); }
}

function moduleHarness(adapterFields: any) {
	const container = new TestElement('div');
	const window: any = { document: {
		createElement: (tag: string) => new TestElement(tag),
		createTextNode: (text: string) => { const node = new TestElement('#text'); node.textContent = text; return node; },
	} };
	runInNewContext(renderBrowserLibraryManagementScript(), { window, URL, TextEncoder, crypto });
	const mounted = window.__PIGEON_LIBRARY_MANAGEMENT__.mount({ container, getSubscriptions: () => subscriptions,
		getSessionIdentity: () => 'account-generation-1', refreshLibrary: async () => {}, ...adapterFields });
	return { container, mounted, button: (title: string) => container.querySelectorAll('button').find((node) => node.textContent === title)!,
		field: (label: string) => container.querySelectorAll('input,textarea').find((node) => node.attributes['aria-label'] === label)! };
}

async function settleUntil(condition: () => boolean) {
	for (let i = 0; i < 30 && !condition(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
	assert.ok(condition(), 'module operation did not settle');
}

test('mounted unsubscribe requires explicit selection, disables pending controls, and restores exactly the same feed with Undo', async () => {
	const calls: LibraryMutation[] = [];
	let resolveFirst: ((payload: any) => void) | null = null;
	const harness = moduleHarness({ authenticatedJson: async (_: string, init: RequestInit) => {
		const change = JSON.parse(init.body as string).mutations[0]; calls.push(change);
		if (calls.length === 1) return new Promise((resolve) => { resolveFirst = resolve; });
		return receipt(change);
	} });
	harness.button('Unsubscribe feed').click();
	await settleUntil(() => harness.container.textContent.includes('Select the unsubscribe confirmation.'));
	assert.equal(calls.length, 0);
	const confirmation = harness.container.querySelectorAll('label').find((node) => node.textContent.startsWith('Confirm unsubscribe'))!.children[0];
	confirmation.checked = true;
	harness.button('Unsubscribe feed').click();
	await settleUntil(() => calls.length === 1);
	assert.equal(harness.button('Unsubscribe feed').disabled, true);
	assert.equal(harness.button('Add URL').disabled, true);
	assert.equal(harness.button('Stop after current request').disabled, false);
	(resolveFirst as unknown as (payload: any) => void)(receipt(calls[0]));
	await settleUntil(() => !harness.button('Undo last change').disabled);
	harness.button('Undo last change').click();
	await settleUntil(() => calls.length === 2 && harness.container.textContent.includes('Subscription restored.'));
	assert.deepEqual(calls.map((change) => [change.kind, change.feedId]), [['unsubscribe_feed', 'feed/1'], ['restore_feed', 'feed/1']]);
	harness.mounted.destroy(); assert.equal(harness.container.childElementCount, 0);
});

test('mounted feed saving treats titles as text, preserves checkbox labels, and undoes only confirmed edits after a partial failure', async () => {
	const calls: LibraryMutation[] = [];
	const harness = moduleHarness({ getSubscriptions: () => [{ ...subscriptions[0], title: '<img src=x onerror=evil()>' }], authenticatedJson: async (_: string, init: RequestInit) => {
		const change = JSON.parse(init.body as string).mutations[0]; calls.push(change);
		return calls.length === 2 ? { results: [{ mutationId: change.id, status: 'failed', error: 'Folders rejected' }] } : receipt(change);
	} });
	assert.ok(harness.container.textContent.includes('<img src=x onerror=evil()>'));
	assert.equal(harness.container.querySelectorAll('img,script').length, 0);
	harness.field('Feed title').value = 'Renamed';
	harness.button('Save feed').click();
	await settleUntil(() => !harness.button('Undo last change').disabled);
	assert.deepEqual(calls[1].folders, ['Keep, commas', 'Old']);
	harness.button('Undo last change').click();
	await settleUntil(() => calls.length === 3 && harness.container.textContent.includes('Feed renamed.'));
	assert.equal(calls[2].kind, 'rename_feed'); assert.equal(calls[2].title, '<img src=x onerror=evil()>');
});

test('folder rename emits reading-context mapping only after every receipt, before refresh, and reverses it on Undo', async () => {
	const order: string[] = [];
	const harness = moduleHarness({ authenticatedJson: async (_: string, init: RequestInit) => {
		const change = JSON.parse(init.body as string).mutations[0]; order.push('write:' + change.feedId); return receipt(change);
	}, onFolderRenamed: (from: string, to: string) => order.push('rename:' + from + ':' + to), refreshLibrary: async () => { order.push('refresh'); } });
	harness.field('Current folder name').value = 'Old'; harness.field('New folder name').value = 'Renamed';
	harness.button('Rename folder').click(); await settleUntil(() => !harness.button('Undo last change').disabled);
	assert.deepEqual(order, ['write:feed/1', 'write:feed/2', 'rename:Old:Renamed', 'refresh']);
	harness.button('Undo last change').click(); await settleUntil(() => order.length === 8);
	assert.deepEqual(order.slice(4), ['write:feed/1', 'write:feed/2', 'rename:Renamed:Old', 'refresh']);
});

test('partial folder rename and its partial Undo keep the old reading-context mapping', async () => {
	const changes: LibraryMutation[] = []; const mappings: string[] = [];
	const harness = moduleHarness({ authenticatedJson: async (_: string, init: RequestInit) => {
		const change = JSON.parse(init.body as string).mutations[0]; changes.push(change);
		return changes.length === 2 ? { results: [{ mutationId: change.id, status: 'failed', error: 'Rejected' }] } : receipt(change);
	}, onFolderRenamed: (from: string, to: string) => mappings.push(from + ':' + to) });
	harness.field('Current folder name').value = 'Old'; harness.field('New folder name').value = 'Renamed';
	harness.button('Rename folder').click(); await settleUntil(() => !harness.button('Undo last change').disabled);
	assert.deepEqual(mappings, []);
	harness.button('Undo last change').click(); await settleUntil(() => changes.length === 3 && harness.container.textContent.includes('Folders updated.'));
	assert.deepEqual(mappings, []); assert.equal(changes[2].feedId, 'feed/1'); assert.deepEqual(changes[2].folders, ['Keep, commas', 'Old']);
});
