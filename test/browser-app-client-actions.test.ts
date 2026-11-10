import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { renderBrowserAppRuntimeScript } from '../src/browser-app';
import { handleGreaderRequest } from '../src/greader';
import { generateApiToken } from '../src/api-auth';
import {
	browserRegressionItem,
	browserRegressionResponse,
	collectBrowserWindowIds,
	createBrowserHarness,
	createDeferred,
	createLargeTodaySqliteLibrary,
	createStatefulArticleBrowser,
	findListButtonByItemId,
	findListButtonByViewId,
	finishArticleMutation,
	flushBrowserTasks,
	renderedArticleIds,
	setBrowserQuery,
	waitForBrowserCondition,
} from './helpers/browser-app-client-harness';

function markUnreadFixtureResponse(input: string, init?: { body?: FormData }, unreadItemIds: string[] = []) {
	if (input.startsWith('/reader/api/0/stream/items/ids?')) {
		return Response.json({ itemRefs: [{ id: '1' }, { id: '2' }] });
	}
	if (input.endsWith('/contents')) {
		return Response.json({ items: (init?.body?.getAll('i') ?? []).map(String).map((id) => ({
			...browserRegressionItem(id, 1_742_460_800),
			categories: [...(unreadItemIds.includes(id) ? [] : ['user/-/state/com.google/read']), 'user/-/state/com.google/starred'],
		})) });
	}
	return browserRegressionResponse(input, init);
}

test('mark unread persists through the real authenticated API while preserving the selected article and scroll', async () => {
	const state = createLargeTodaySqliteLibrary(new Date(2026, 9, 12, 12).getTime(), 2);
	state.database.exec('UPDATE items SET is_read = 1');
	try {
		const token = await generateApiToken('today-test-password');
		let bodyRequests = 0;
		const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin') return new Response(`Auth=pigeon/${token}`);
			if (input.endsWith('/contents')) bodyRequests += 1;
			return handleGreaderRequest(new Request(`https://pigeon.example${input}`, init as RequestInit), state.env);
		} });
		assert.equal(harness.elements.get('mark-unread-button')!.disabled, true);
		await harness.elements.get('login-form')!.dispatch('submit');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 3');
		await flushBrowserTasks();
		const originalFrame = harness.elements.get('reader-frame')!.srcdoc;
		const originalBodyRequests = bodyRequests;
		harness.dispatchReaderFrameScroll(280);
		harness.elements.get('mark-unread-button')!.dispatch('click');
		await waitForBrowserCondition(() => harness.elements.get('mark-unread-button')!.disabled === false);
		assert.equal(state.database.prepare("SELECT is_read FROM items WHERE id = 'today-3'").get()!.is_read, 0);
		assert.equal(state.database.prepare("SELECT is_read FROM items WHERE id = 'today-2'").get()!.is_read, 1);
		assert.equal(harness.elements.get('reader-action-status')!.textContent, 'Marked unread.');
		assert.equal(findListButtonByViewId(harness.elements.get('views-list'), 'unread')!.textContent, 'Unread1');
		assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 3');
		assert.equal(harness.elements.get('reader-frame')!.srcdoc, originalFrame);
		assert.equal(harness.getReaderFrameScrollTop(), 280);
		assert.equal(bodyRequests, originalBodyRequests);
		assert.equal(harness.getCachedArticleState('3').body.includes('user/-/state/com.google/read'), false);
		assert.equal(harness.getCachedArticleState('3').metadata.includes('user/-/state/com.google/read'), false);
	} finally { state.database.close(); }
});

test('mark unread sends one selected item, prevents duplicate clicks and ignores stale counts', async () => {
	const mutation = createDeferred<Response>();
	const oldCounts = createDeferred<Response>();
	let countRequests = 0;
	let mutations = 0;
	let saved = false;
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.endsWith('/edit-tag')) {
			mutations += 1;
			assert.deepEqual(init?.body?.getAll('i'), ['1']);
			assert.equal(init?.body?.get('r'), 'user/-/state/com.google/read');
			assert.equal(init?.body?.get('a'), null);
			assert.equal(init?.headers?.Authorization, 'GoogleLogin auth=pigeon/live');
			assert.equal(init?.method, 'POST');
			return mutation.promise.then((response) => { saved = response.ok; return response; });
		}
		if (input.endsWith('/unread-count')) {
			if (++countRequests === 2) return oldCounts.promise;
			return Response.json({ unreadcounts: [{ id: 'user/-/state/com.google/reading-list', count: mutations ? 1 : 0 }] });
		}
		return markUnreadFixtureResponse(input, init, saved ? ['1'] : []);
	} });
	await harness.elements.get('login-form')!.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article 1');
	const button = harness.elements.get('mark-unread-button')!;
	harness.dispatchDocumentEvent('visibilitychange');
	button.dispatch('click');
	button.dispatch('click');
	assert.equal(button.disabled, true);
	assert.equal(button.getAttribute('aria-busy'), 'true');
	assert.equal(mutations, 1);
	mutation.resolve(new Response('OK'));
	await waitForBrowserCondition(() => button.disabled === false);
	oldCounts.resolve(Response.json({ unreadcounts: [{ id: 'user/-/state/com.google/reading-list', count: 0 }] }));
	await flushBrowserTasks();
	assert.equal(findListButtonByViewId(harness.elements.get('views-list'), 'unread')!.textContent, 'Unread1');
	assert.deepEqual(harness.getCachedArticleState('1'), {
		body: ['user/-/state/com.google/starred'], metadata: ['user/-/state/com.google/starred'],
	});
	assert.equal(harness.elements.get('reader-action-status')!.textContent, 'Marked unread.');
	assert.equal(button.getAttribute('aria-busy'), 'false');
});

test('a cached Unread view refreshes membership after marking an article unread in its feed', async () => {
	const state = createLargeTodaySqliteLibrary(new Date(2026, 9, 12, 12).getTime(), 2);
	state.database.exec('UPDATE items SET is_read = 1');
	try {
		const token = await generateApiToken('today-test-password');
		const harness = await createBrowserHarness({ fetchImpl: async (input, init) => input === '/accounts/ClientLogin'
			? new Response(`Auth=pigeon/${token}`)
			: handleGreaderRequest(new Request(`https://pigeon.example${input}`, init as RequestInit), state.env) });
		await harness.elements.get('login-form')!.dispatch('submit');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 3');
		findListButtonByViewId(harness.elements.get('views-list'), 'unread')!.dispatch('click');
		await waitForBrowserCondition(() => harness.elements.get('articles-status')!.textContent === 'No articles in Unread.');
		findListButtonByViewId(harness.elements.get('views-list'), 'all')!.dispatch('click');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 3');
		findListButtonByViewId(harness.elements.get('feeds-list'), 'feed/1')!.dispatch('click');
		await waitForBrowserCondition(() => harness.elements.get('articles-heading')!.textContent === 'Today source' &&
			harness.elements.get('mark-unread-button')!.disabled === false);
		harness.elements.get('mark-unread-button')!.dispatch('click');
		await waitForBrowserCondition(() => harness.elements.get('mark-unread-button')!.disabled === false);
		assert.equal(harness.elements.get('reader-action-status')!.textContent, 'Marked unread.');
		findListButtonByViewId(harness.elements.get('views-list'), 'unread')!.dispatch('click');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 3');
		assert.deepEqual(renderedArticleIds(harness), ['3']);
		assert.equal(harness.elements.get('articles-heading')!.textContent, 'Unread');
		assert.equal(harness.elements.get('reader-action-status')!.textContent, '');
	} finally { state.database.close(); }
});

test('failed mark unread leaves cache intact and can be retried', async () => {
	let mutations = 0;
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.endsWith('/edit-tag')) return new Response(++mutations === 1 ? 'Error' : 'OK', { status: mutations === 1 ? 503 : 200 });
		return markUnreadFixtureResponse(input, init);
	} });
	await harness.elements.get('login-form')!.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article 1');
	const button = harness.elements.get('mark-unread-button')!;
	button.dispatch('click');
	await waitForBrowserCondition(() => button.disabled === false);
	assert.equal(harness.elements.get('reader-action-status')!.textContent, 'Could not mark unread. Try again.');
	assert.ok(harness.getCachedArticleState('1').body.includes('user/-/state/com.google/read'));
	button.dispatch('click');
	await waitForBrowserCondition(() => button.disabled === false);
	assert.equal(harness.elements.get('reader-action-status')!.textContent, 'Marked unread.');
	assert.equal(mutations, 2);
});

test('mark unread reports saved state when count refresh fails', async () => {
	let mutated = false;
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.endsWith('/edit-tag')) { mutated = true; return new Response('OK'); }
		if (input.endsWith('/unread-count') && mutated) return new Response('Error', { status: 503 });
		return markUnreadFixtureResponse(input, init);
	} });
	await harness.elements.get('login-form')!.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article 1');
	harness.elements.get('mark-unread-button')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('mark-unread-button')!.disabled === false);
	assert.equal(harness.elements.get('reader-action-status')!.textContent, 'Marked unread, but could not refresh unread counts.');
	assert.equal(harness.getCachedArticleState('1').body.includes('user/-/state/com.google/read'), false);
});

for (const failed of [false, true]) {
	test(`mark unread ${failed ? 'failure' : 'success'} after navigation does not replace the selected article or its feedback`, async () => {
		const mutation = createDeferred<Response>();
		const harness = await createBrowserHarness({ fetchImpl: async (input, init) => input.endsWith('/edit-tag') ? mutation.promise : markUnreadFixtureResponse(input, init) });
		await harness.elements.get('login-form')!.dispatch('submit');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article 1');
		harness.elements.get('mark-unread-button')!.dispatch('click');
		harness.dispatchKeydown('j');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article 2');
		assert.equal(harness.elements.get('reader-action-status')!.textContent, '');
		mutation.resolve(new Response(failed ? 'Error' : 'OK', { status: failed ? 503 : 200 }));
		await waitForBrowserCondition(() => harness.elements.get('mark-unread-button')!.disabled === false);
		assert.equal(harness.elements.get('reader-title')!.textContent, 'Article 2');
		assert.equal(harness.elements.get('reader-action-status')!.textContent, '');
		assert.equal(harness.getCachedArticleState('1').body.includes('user/-/state/com.google/read'), failed);
		assert.equal(harness.getCachedArticleState('2').body.includes('user/-/state/com.google/read'), true);
	});
}

for (const status of [200, 503, 401]) {
	test(`an old mark unread ${status} response cannot alter a new login or its pending action`, async () => {
		const oldMutation = createDeferred<Response>();
		const newMutation = createDeferred<Response>();
		let mutations = 0;
		const harness = await createBrowserHarness({ fetchImpl: async (input, init) => input.endsWith('/edit-tag')
			? (++mutations === 1 ? oldMutation.promise : newMutation.promise) : markUnreadFixtureResponse(input, init) });
		await harness.elements.get('login-form')!.dispatch('submit');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article 1');
		harness.elements.get('mark-unread-button')!.dispatch('click');
		harness.elements.get('logout-button')!.dispatch('click');
		await harness.elements.get('login-form')!.dispatch('submit');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article 1');
		harness.elements.get('mark-unread-button')!.dispatch('click');
		oldMutation.resolve(new Response('Old response', { status }));
		await flushBrowserTasks();
		assert.equal(harness.elements.get('reader-shell')!.classList.contains('hidden'), false);
		assert.equal(harness.elements.get('mark-unread-button')!.disabled, true);
		assert.equal(harness.elements.get('reader-action-status')!.textContent, 'Marking article unread…');
		assert.equal(harness.getCachedArticleState('1').body.includes('user/-/state/com.google/read'), true);
		newMutation.resolve(new Response('OK'));
		await waitForBrowserCondition(() => harness.elements.get('mark-unread-button')!.disabled === false);
		assert.equal(harness.elements.get('reader-action-status')!.textContent, 'Marked unread.');
	});
}

test('a current unauthorized mark unread logs out and clears action feedback', async () => {
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => input.endsWith('/edit-tag')
		? new Response('Unauthorized', { status: 401 }) : markUnreadFixtureResponse(input, init) });
	await harness.elements.get('login-form')!.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article 1');
	harness.elements.get('mark-unread-button')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-shell')!.classList.contains('hidden'));
	assert.equal(harness.elements.get('reader-action-status')!.textContent, '');
	assert.equal(harness.elements.get('mark-unread-button')!.disabled, true);
	assert.equal(harness.elements.get('login-error')!.textContent, 'Session expired.');
});

test('a pre-mutation article refresh cannot restore cached read state after marking unread', async () => {
	const oldBody = createDeferred<Response>();
	let bodyRequests = 0;
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.endsWith('/edit-tag')) return new Response('OK');
		if (input.endsWith('/contents') && ++bodyRequests === 2) return oldBody.promise;
		return markUnreadFixtureResponse(input, init);
	} });
	await harness.elements.get('login-form')!.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article 1');
	harness.dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => bodyRequests === 2);
	harness.elements.get('mark-unread-button')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('mark-unread-button')!.disabled === false);
	oldBody.resolve(markUnreadFixtureResponse('/reader/api/0/stream/items/contents', { body: (() => {
		const form = new FormData(); form.append('i', '1'); form.append('i', '2'); return form;
	})() }));
	await flushBrowserTasks();
	assert.equal(harness.getCachedArticleState('1').body.includes('user/-/state/com.google/read'), false);
	assert.equal(harness.getCachedArticleState('1').metadata.includes('user/-/state/com.google/read'), false);
	assert.equal(harness.getCachedArticleState('2').body.includes('user/-/state/com.google/read'), true);
});

test('mounted Library saves and undoes a feed rename through the real API and refreshes navigation', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser(); t.after(() => database.close());
	harness.elements.get('library-button')!.dispatch('click');
	const content = harness.elements.get('library-content')!;
	await waitForBrowserCondition(() => content.querySelectorAll('input').some((node) => node.getAttribute('aria-label') === 'Feed title'), 100);
	const title = content.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === 'Feed title')!;
	title.value = 'Renamed newsletter';
	content.querySelectorAll('button').find((node) => node.textContent === 'Save feed')!.dispatch('click');
	await waitForBrowserCondition(() => content.querySelectorAll('button').find((node) => node.textContent === 'Save feed')?.disabled === false, 200);
	assert.equal(database.prepare("SELECT COALESCE(custom_title, display_name) AS title FROM feeds WHERE feed_key='today-source'").get()!.title, 'Renamed newsletter');
	assert.ok(harness.elements.get('feeds-list')!.children.some((node) => node.textContent.includes('Renamed newsletter')));
	content.querySelectorAll('button').find((node) => node.textContent === 'Undo last change')!.dispatch('click');
	await waitForBrowserCondition(() => database.prepare("SELECT COALESCE(custom_title, display_name) AS title FROM feeds WHERE feed_key='today-source'").get()!.title === 'Today source' && content.querySelectorAll('button').find(node=>node.textContent==='Save feed')?.disabled===false, 200);
	harness.elements.get('close-library-button')!.dispatch('click');
	assert.equal(content.childElementCount, 0);
	assert.equal(harness.elements.get('library-button')!.getAttribute('aria-expanded'), 'false');
});

function recommendationFixture(id: number) {
 return {readerId:'tag:google.com,2005:reader/item/' + id.toString(16).padStart(16,'0'),id:'today-'+id,
  feedKey:'today-source',source:'Today source',title:'Recommended '+id,author:'Writer',receivedAt:new Date(Date.UTC(2026,9,12,id)).toISOString(),
  originalURL:'https://example.com/story/'+id,html:'<p>Recommendation body '+id+'</p>',text:'Recommendation body '+id,
  isRead:false,isStarred:id===1,score:id===2?90:20,explanation:'Matches your interests',matchedTopics:['reading']};
}

function readingIntegrationTools(policy='ask') {
 const preferences={theme:'sepia',font:'serif',fontSize:18,lineHeight:1.6,width:720,margins:24,density:'comfortable',imagePolicy:policy,shortcuts:{next:'n',previous:'p',read:'r',star:'t'}};
 const calls:any[]=[];
 return {calls,readPreferences:()=>preferences,savePreferences:(next:any)=>next,frameCSS:()=> 'body{font-size:18px}',
  async applyImagePolicy(html:string,options:any){calls.push({html,options});return {html:html.replace(/<img[^>]*>/g,options.loadOnce?'<img src="https://example.com/image.jpg">':'<img alt="hidden">'),images:[{loaded:!!options.loadOnce,reason:'consent'}],blockedCount:options.loadOnce?0:1};}};
}

function offlineIntegrationTools(count=2) {
 const rows=Array.from({length:count+2},(_,index)=>({...browserRegressionItem(String(index+1),Date.UTC(2026,9,12,12)/1000+index),id:String(index+1),categories:[] as string[]}));
 const queued:any[]=[];let closed=false;
 const library={close(){closed=true;},async sync(){},async replay(){const applied=queued.length;queued.splice(0);return {applied,pending:0};},async storeBodies(){},async savePosition(){},async getPosition(){return 0;},
  async stats(){return {articles:rows.length,savedBodies:rows.length,pending:queued.length,bodyBytes:100,lastSync:'2026-10-12T12:00:00Z'};},
  async feeds(){return [{feedKey:'today-source',streamId:'feed/1',title:'Today source',isActive:true,folders:[]}];},
  async contents(ids:string[]){return {items:rows.filter(row=>ids.includes(row.id)).map(row=>({...row,offlineSaved:true}))};},
  async query(query:any){let filtered=rows.filter(row=>query.filter!=='unread'||!row.categories?.includes('user/-/state/com.google/read')).sort((a,b)=>query.sort==='oldest'?a.published-b.published:b.published-a.published);
   const offset=query.offset||0,limit=query.limit||50;return {itemIds:filtered.slice(offset,offset+limit).map(row=>row.id),total:filtered.length,hasMore:offset+limit<filtered.length};},
  async queueMutation(id:string,kind:string,value:boolean){if(closed)throw new Error('closed');queued.push({id,kind,value});const row=rows.find(row=>row.id===id)!;const category='user/-/state/com.google/'+(kind==='set_read'?'read':'starred');row.categories=(row.categories||[]).filter(c=>c!==category);if(value)row.categories.push(category);return {id:'queued-'+queued.length};},
  async confirmState(id:string,kind:string,value:boolean){const row=rows.find(row=>row.id===id);if(!row)return {saved:false};const category='user/-/state/com.google/'+(kind==='set_read'?'read':'starred');row.categories=row.categories.filter(c=>c!==category);if(value)row.categories.push(category);return {saved:true};},
  async clearCache(){if(queued.length)throw new Error('Sync pending edits first.');},async freeOlderReadUnstarred(){return {freed:0};}};
 return {queued,library,accountHash:async()=> 'account-hash',hasAccount:async()=>true,create:async()=>library};
}

test('offline individual read and star edits queue once, refresh local counts, and Undo queues exact inverse',async(t)=>{
 const tools=offlineIntegrationTools();const {database,harness,mutations}=await createStatefulArticleBrowser({offlineTools:tools});t.after(()=>database.close());
 harness.setOnline(false);await finishArticleMutation(harness,'mark-unread-button');
 assert.equal(tools.queued.length,1);assert.equal(tools.queued[0].kind,'set_read');assert.equal(mutations.length,0);
 await finishArticleMutation(harness,'undo-article-button');assert.equal(tools.queued.length,2);assert.equal(tools.queued[1].value,false);
 await finishArticleMutation(harness,'star-article-button');assert.equal(tools.queued.length,3);assert.equal(tools.queued[2].kind,'set_starred');
 assert.ok(harness.elements.get('offline-status')!.textContent.includes('3 pending edits'));
 harness.elements.get('logout-button')!.dispatch('click');await assert.rejects(()=>tools.library.queueMutation('1','set_read',true),/closed/);
});

test('offline membership continuation beyond fifty articles loads all saved IDs',async(t)=>{
 const tools=offlineIntegrationTools(65);const {database,harness}=await createStatefulArticleBrowser({count:65,offlineTools:tools});t.after(()=>database.close());
 harness.setOnline(false);harness.elements.get('refresh-view-button')!.dispatch('click');
 await waitForBrowserCondition(()=>harness.getCacheSizes().membership===0,100);await flushBrowserTasks();
 harness.elements.get('load-more-button')!.dispatch('click');
 await waitForBrowserCondition(()=>harness.elements.get('articles-list')!.children.length===67,200);
 assert.equal(harness.elements.get('load-more-button')!.classList.contains('hidden'),true);
});

async function createSavedOfflineBrowser(count: number) {
 const harness = await createBrowserHarness({
  storedToken: await generateApiToken('today-test-password'), offlineTools: offlineIntegrationTools(count), online: false,
  fetchImpl: async () => { throw new TypeError('Network offline'); },
 });
 await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article ' + (count + 2), 100);
 await flushBrowserTasks();
 return harness;
}

async function loadSavedOfflineWindow(harness: Awaited<ReturnType<typeof createBrowserHarness>>, size: number) {
 for (let attempt = 0; attempt < 15; attempt++) {
  const ids = renderedArticleIds(harness);
  if (ids.length === size && harness.getCacheSizes().bodies >= size) return;
  harness.elements.get('load-more-button')!.dispatch('click');
  await flushBrowserTasks();
 }
 assert.fail('Saved article window did not finish loading');
}

for (const navigation of ['Older button', 'next shortcut']) {
 test(`offline ${navigation} opens the saved window beyond 200 articles`, async () => {
  const harness = await createSavedOfflineBrowser(210);
  await loadSavedOfflineWindow(harness, 200);
  assert.equal(renderedArticleIds(harness).at(-1), '13');
  if (navigation === 'next shortcut') {
   findListButtonByItemId(harness.elements.get('articles-list'), '13')!.dispatch('click');
   await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article 13');
   harness.dispatchKeydown('j');
  } else harness.elements.get('article-older-button')!.dispatch('click');
  await waitForBrowserCondition(() => renderedArticleIds(harness).length === 12 && harness.elements.get('reader-title')!.textContent === 'Article 12', 200);
  assert.deepEqual(renderedArticleIds(harness), Array.from({ length: 12 }, (_, index) => String(12 - index)));
  assert.equal(harness.elements.get('article-older-button')!.disabled, true);
 });
}

test('offline next shortcut loads the next saved membership page at a partial window boundary', async () => {
 const harness = await createSavedOfflineBrowser(65);
 await loadSavedOfflineWindow(harness, 50);
 const last = renderedArticleIds(harness).at(-1)!;
 findListButtonByItemId(harness.elements.get('articles-list'), last)!.dispatch('click');
 await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article ' + last);
 harness.dispatchKeydown('j');
 await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article ' + (Number(last) - 1), 200);
 assert.equal(renderedArticleIds(harness).length, 67);
});

test('acknowledged online read and star state survives a fresh offline session without duplicate mutations',async(t)=>{
 const tools=offlineIntegrationTools();const {database,harness,mutations}=await createStatefulArticleBrowser({offlineTools:tools});t.after(()=>database.close());
 await finishArticleMutation(harness,'mark-unread-button');await finishArticleMutation(harness,'star-article-button');
 assert.equal(tools.queued.length,0);assert.equal(mutations.length,2);
 const saved=await tools.library.contents(['3']);assert.ok(saved.items[0].categories.includes('user/-/state/com.google/read'));assert.ok(saved.items[0].categories.includes('user/-/state/com.google/starred'));
 harness.elements.get('logout-button')!.dispatch('click');
 const fresh=await createBrowserHarness({storedToken:await generateApiToken('today-test-password'),offlineTools:tools,fetchImpl:async()=>{throw new TypeError('Network offline');}});
 await waitForBrowserCondition(()=>!fresh.elements.get('reader-shell')!.classList.contains('hidden')&&fresh.getCachedArticleState('3').body.length>0,100);
 assert.ok(fresh.getCachedArticleState('3').body.includes('user/-/state/com.google/read'));assert.ok(fresh.getCachedArticleState('3').body.includes('user/-/state/com.google/starred'));
 assert.equal(tools.queued.length,0);fresh.elements.get('logout-button')!.dispatch('click');
});

test('account change while offline hashing is pending cannot create the previous account storage',async()=>{
 const held=createDeferred<string>();const tools=offlineIntegrationTools();let hashes=0,created=0;
 tools.accountHash=async()=>++hashes===1?held.promise:'new-hash';tools.create=async()=>{created++;return tools.library;};
 const harness=await createBrowserHarness({offlineTools:tools,fetchImpl:async(input,init)=>markUnreadFixtureResponse(input,init)});
 await harness.elements.get('login-form')!.dispatch('submit');await waitForBrowserCondition(()=>hashes===1,100);
 harness.elements.get('logout-button')!.dispatch('click');await harness.elements.get('login-form')!.dispatch('submit');await waitForBrowserCondition(()=>created===1,100);
 held.resolve('old-hash');await flushBrowserTasks();assert.equal(created,1);
 harness.elements.get('logout-button')!.dispatch('click');
});

test('notification read action requires explicit confirmation after authentication',async(t)=>{
 const {database,harness,mutations}=await createStatefulArticleBrowser({locationHref:'https://pigeon.example/app?article=1&notificationAction=read'});t.after(()=>database.close());
 await waitForBrowserCondition(()=>!harness.elements.get('notification-action-panel')!.classList.contains('hidden'),100);
 assert.equal(mutations.length,0);assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-1'").get()!.is_read,0);
 harness.elements.get('notification-confirm-button')!.dispatch('click');harness.elements.get('notification-confirm-button')!.dispatch('click');
 await waitForBrowserCondition(()=>harness.elements.get('notification-action-panel')!.classList.contains('hidden'),100);
 assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-1'").get()!.is_read,1);assert.equal(mutations.length,1);
});

test('the reader header column follows the saved reading width and margins',async(t)=>{
 const {database,harness}=await createStatefulArticleBrowser({readingTools:readingIntegrationTools()});t.after(()=>database.close());
 const scroll=harness.elements.get('reader-scroll')!;
 assert.equal(scroll.style.getPropertyValue('--reader-measure'),'720px');
 assert.equal(scroll.style.getPropertyValue('--reader-gutter'),'24px');
});

test('reader extraction prepares image policy before insertion, consent reloads safely, and preference shortcuts work',async(t)=>{
 const tools=readingIntegrationTools();let sources=0;
 const {database,harness}=await createStatefulArticleBrowser({readingTools:tools,extractReader:()=>({content:'<p>Extracted story</p><img src="https://example.com/image.jpg">',url:'https://example.com/reader'}),fetchOverride:async(input,init,next)=>{
  if(input.startsWith('/api/v1/recommendations?'))return Response.json({items:[recommendationFixture(1)],continuation:null});
  if(input.startsWith('/api/v1/browser/reader-source?')){sources++;return Response.json({url:'https://example.com/reader',html:'<article>Source</article>'});}return next();
 }});t.after(()=>database.close());
 findListButtonByViewId(harness.elements.get('views-list'),'for-you')!.dispatch('click');
 await waitForBrowserCondition(()=>harness.elements.get('reader-title')!.textContent==='Recommended 1'&&tools.calls.length>0,100);
 harness.elements.get('reader-mode-select')!.value='reader';harness.elements.get('reader-mode-select')!.dispatch('change');
 await waitForBrowserCondition(()=>harness.elements.get('reader-frame')!.srcdoc.includes('Extracted story'),100);
 assert.equal(sources,1);assert.equal(harness.elements.get('reader-frame')!.srcdoc.includes('src="https://example.com/image.jpg"'),false);
 assert.equal(harness.elements.get('load-images-button')!.hidden,false);
 harness.elements.get('load-images-button')!.dispatch('click');await waitForBrowserCondition(()=>harness.elements.get('reader-frame')!.srcdoc.includes('src="https://example.com/image.jpg"'),100);
 assert.equal(tools.calls.at(-1).options.loadOnce,true);
 harness.dispatchKeydown('r');
 await waitForBrowserCondition(()=>database.prepare("SELECT is_read FROM items WHERE id='today-1'").get()!.is_read===1,100);
 await flushBrowserTasks();harness.elements.get('logout-button')!.dispatch('click');
});

test('returning to the same article after a view with no selection re-renders its body',async(t)=>{
 const tools=readingIntegrationTools('load');const {database,harness}=await createStatefulArticleBrowser({readingTools:tools});t.after(()=>database.close());
 await waitForBrowserCondition(() => harness.elements.get('reader-frame')!.srcdoc.includes('Body 3</p>'), 100);
 findListButtonByViewId(harness.elements.get('views-list'),'starred')!.dispatch('click');
 await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent==='Select an article', 100);
 assert.equal(harness.elements.get('reader-frame')!.srcdoc.includes('Body 3</p>'),false);
 findListButtonByViewId(harness.elements.get('views-list'),'all')!.dispatch('click');
 await waitForBrowserCondition(() => findListButtonByItemId(harness.elements.get('articles-list'),'3')!==null, 100);
 findListButtonByItemId(harness.elements.get('articles-list'),'3')!.dispatch('click');
 await waitForBrowserCondition(() => harness.elements.get('reader-frame')!.srcdoc.includes('Body 3</p>'), 100);
 harness.elements.get('logout-button')!.dispatch('click');
});

test('reading positions for two quickly visited articles survive the shared persistence debounce',async(t)=>{
 const tools=readingIntegrationTools('load');const {database,harness}=await createStatefulArticleBrowser({readingTools:tools,frameHeight:1000,viewportHeight:200});t.after(()=>database.close());
 await waitForBrowserCondition(() => harness.elements.get('reader-frame')!.srcdoc.includes('Body 3</p>'), 100);
 await flushBrowserTasks();harness.dispatchReaderFrameScroll(640);
 findListButtonByItemId(harness.elements.get('articles-list'),'2')!.dispatch('click');
 await waitForBrowserCondition(() => harness.elements.get('reader-frame')!.srcdoc.includes('Body 2</p>'), 100);
 await flushBrowserTasks();harness.dispatchReaderFrameScroll(160);
 await new Promise(resolve=>setTimeout(resolve,280));
 const key=[...harness.localStorageState.keys()].find(key=>key.startsWith('pigeon.browser.reading-account.'))!;
 const positions=JSON.parse(harness.localStorageState.get(key)!).positions;
 assert.equal(positions['3'],0.8);assert.equal(positions['2'],0.2);
 harness.elements.get('logout-button')!.dispatch('click');
});

test('switching to Proxy clears direct-image zoom while the new private frame is pending',async(t)=>{
 const held=createDeferred<any>();const tools=readingIntegrationTools('load');const normalApply=tools.applyImagePolicy;
 tools.applyImagePolicy=async(html,options)=>options.policy==='proxy'?held.promise:normalApply(html,options);
 const {database,harness}=await createStatefulArticleBrowser({readingTools:tools});t.after(()=>database.close());await flushBrowserTasks();
 harness.elements.get('zoom-image')!.setAttribute('src','https://example.com/direct.jpg');harness.elements.get('image-zoom-panel')!.classList.remove('hidden');
 harness.elements.get('reading-imagePolicy')!.value='proxy';harness.elements.get('reading-settings-form')!.dispatch('submit');await flushBrowserTasks();
 assert.equal(harness.elements.get('image-zoom-panel')!.classList.contains('hidden'),true);assert.equal(harness.elements.get('zoom-image')!.getAttribute('src'),'');
 assert.ok(harness.elements.get('reader-frame')!.srcdoc.includes('Preparing private reading view'));
 held.resolve({html:'<p>Private body</p>',images:[],blockedCount:0});await flushBrowserTasks();harness.elements.get('logout-button')!.dispatch('click');
});

test('offline password login opens only a previously saved derived account after network failure',async()=>{
 const tools=offlineIntegrationTools();let created=0;let receivedToken='';
 const originalCreate=tools.create;tools.create=async(adapter:any)=>{created++;receivedToken=adapter.token;return originalCreate();};
 const harness=await createBrowserHarness({offlineTools:tools,fetchImpl:async()=>{throw new TypeError('Network unavailable');}});
 await harness.elements.get('login-form')!.dispatch('submit');await waitForBrowserCondition(()=>!harness.elements.get('reader-shell')!.classList.contains('hidden'),100);
 assert.equal(created,1);assert.equal(receivedToken,await generateApiToken('secret-password'));
 assert.ok(harness.elements.get('offline-mode-banner')!.textContent.includes('saved articles only'));
 harness.elements.get('logout-button')!.dispatch('click');
});

test('online rejected credentials cannot open a saved offline namespace',async()=>{
 const tools=offlineIntegrationTools();let created=0;tools.create=async()=>{created++;return tools.library;};
 const harness=await createBrowserHarness({offlineTools:tools,fetchImpl:async()=>new Response('Unauthorized',{status:401})});
 await harness.elements.get('login-form')!.dispatch('submit');await flushBrowserTasks();
 assert.equal(created,0);assert.equal(harness.elements.get('reader-shell')!.classList.contains('hidden'),true);
});

test('emitted preview regex and reader CSS insert the intended blob source and real newline',()=>{
 const script=renderBrowserAppRuntimeScript();const expression=script.match(/const match=result.html.match\((.*?)\);/s)![1];
 assert.equal(vm.runInNewContext(expression+'.exec(html)[1]',{html:'<img src="blob:fixture-image">'}),'blob:fixture-image');
 const context={documentHtml:'<style></style>',readingTools:{frameCSS:()=>':root{color:red}'},readingPreferences:{}};
 vm.runInNewContext(script.split('\n').find(line=>line.includes('documentHtml=documentHtml.replace'))!,context);
 assert.equal(context.documentHtml.includes('<style>\n:root'),true);
});

test('For You collects every page before sorting and retains canonical read/star state with real mutations', async (t) => {
 let pages=0;
 const {database,harness}=await createStatefulArticleBrowser({fetchOverride:async(input,init,next)=>{
  if(input.startsWith('/api/v1/recommendations?')) {pages++; return Response.json(input.includes('continuation=') ? {items:[recommendationFixture(2)],continuation:null} : {items:[recommendationFixture(1),recommendationFixture(3)],continuation:'second'});}
  return next();
 }});t.after(()=>database.close());
 findListButtonByViewId(harness.elements.get('views-list'),'for-you')!.dispatch('click');
 await waitForBrowserCondition(()=>harness.elements.get('reader-title')!.textContent==='Recommended 1',100);
 assert.equal(pages,2); assert.equal(harness.getCachedArticleState('1').body.includes('user/-/state/com.google/starred'),true);
 harness.elements.get('article-sort-select')!.value='score';harness.elements.get('article-sort-select')!.dispatch('change');
 await waitForBrowserCondition(()=>harness.elements.get('reader-title')!.textContent==='Recommended 2',100);
 assert.equal(pages,4);
 await finishArticleMutation(harness,'mark-unread-button');
 assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-2'").get()!.is_read,1);
 harness.elements.get('article-search-input')!.value='body 3';harness.elements.get('article-query-form')!.dispatch('submit');
 await waitForBrowserCondition(()=>harness.elements.get('reader-title')!.textContent==='Recommended 3',100);
 assert.equal(harness.elements.get('articles-list')!.children.length,1);
});

test('For You reports a failed later page without pretending an incomplete recommendation sort succeeded', async(t)=>{
 const {database,harness}=await createStatefulArticleBrowser({fetchOverride:async(input,init,next)=>{
  if(input.startsWith('/api/v1/recommendations?'))return input.includes('continuation=')?new Response('Unavailable',{status:503}):Response.json({items:[recommendationFixture(1)],continuation:'next'});
  return next();
 }});t.after(()=>database.close());
 findListButtonByViewId(harness.elements.get('views-list'),'for-you')!.dispatch('click');
 await waitForBrowserCondition(()=>harness.elements.get('articles-status')!.textContent.includes('Could not'),100);
 assert.equal(harness.elements.get('articles-list')!.children.length,0);
});

test('For You date sorts, Read filter, and age bulk use article dates and canonical read state',async(t)=>{
 const {database,harness}=await createStatefulArticleBrowser({fetchOverride:async(input,init,next)=>input.startsWith('/api/v1/recommendations?')?Response.json({items:[{...recommendationFixture(1),isRead:true},recommendationFixture(3),{...recommendationFixture(2),receivedAt:'2026-10-01T00:00:00Z'}],continuation:null}):next()});t.after(()=>database.close());
 database.exec("UPDATE items SET is_read=1 WHERE id='today-1'; UPDATE items SET received_at='2026-10-01T00:00:00Z' WHERE id='today-2'");
 findListButtonByViewId(harness.elements.get('views-list'),'for-you')!.dispatch('click');
 await waitForBrowserCondition(()=>harness.elements.get('reader-title')!.textContent==='Recommended 1',100);
 harness.elements.get('article-sort-select')!.value='newest';harness.elements.get('article-sort-select')!.dispatch('change');
 await waitForBrowserCondition(()=>harness.elements.get('reader-title')!.textContent==='Recommended 3',100);
 harness.elements.get('article-sort-select')!.value='oldest';harness.elements.get('article-sort-select')!.dispatch('change');
 await waitForBrowserCondition(()=>harness.elements.get('reader-title')!.textContent==='Recommended 2',100);
 harness.elements.get('article-read-filter')!.value='read';harness.elements.get('article-read-filter')!.dispatch('change');
 await waitForBrowserCondition(()=>harness.elements.get('reader-title')!.textContent==='Recommended 1',100);
 assert.equal(harness.elements.get('articles-list')!.children.length,1);
 harness.elements.get('article-read-filter')!.value='all';harness.elements.get('article-read-filter')!.dispatch('change');
 await waitForBrowserCondition(()=>harness.elements.get('reader-title')!.textContent==='Recommended 2',100);
 await finishBulkRead(harness,'age-1');
 assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-2'").get()!.is_read,1);
 assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-3'").get()!.is_read,0);
});

test('topics changed while recommendations are pending start a fresh membership request',async(t)=>{
 const held=createDeferred<Response>();let roots=0;
 const {database,harness}=await createStatefulArticleBrowser({fetchOverride:async(input,init,next)=>{
  if(input.startsWith('/api/v1/recommendations?'))return ++roots===1?held.promise:Response.json({items:[recommendationFixture(3)],continuation:null});return next();
 }});t.after(()=>database.close());
 findListButtonByViewId(harness.elements.get('views-list'),'for-you')!.dispatch('click');await waitForBrowserCondition(()=>roots===1,100);
 harness.elements.get('settings-button')!.dispatch('click');const panel=harness.elements.get('personalization-content')!;
 await waitForBrowserCondition(()=>panel.querySelectorAll('button').some(node=>node.textContent==='Add topic'),100);
 panel.querySelectorAll('input').find(node=>node.getAttribute('aria-label')==='New monitored topic')!.value='reading';
 panel.querySelectorAll('button').find(node=>node.textContent==='Add topic')!.dispatch('click');
 await waitForBrowserCondition(()=>roots===2 && harness.elements.get('reader-title')!.textContent==='Recommended 3',100);
 held.resolve(Response.json({items:[recommendationFixture(1)],continuation:null}));await flushBrowserTasks();
 assert.equal(harness.elements.get('reader-title')!.textContent,'Recommended 3');
});

test('late For You membership and feedback cannot update a signed-out session',async(t)=>{
 const held=createDeferred<Response>(); let requested=false;
 const {database,harness}=await createStatefulArticleBrowser({fetchOverride:async(input,init,next)=>{
  if(input.startsWith('/api/v1/recommendations?')){requested=true;return held.promise;}return next();
 }});t.after(()=>database.close());
 findListButtonByViewId(harness.elements.get('views-list'),'for-you')!.dispatch('click');
 await waitForBrowserCondition(()=>requested,100);
 harness.elements.get('logout-button')!.dispatch('click'); held.resolve(Response.json({items:[recommendationFixture(1)],continuation:null}));
 await flushBrowserTasks();assert.equal(harness.getCacheSizes().bodies,0);assert.equal(harness.elements.get('reader-action-status')!.textContent,'');
});

test('confirmed Not interested removes only recommendation membership and preserves the opened story and star',async(t)=>{
 const {database,harness}=await createStatefulArticleBrowser({fetchOverride:async(input,init,next)=>input.startsWith('/api/v1/recommendations?')?Response.json({items:[recommendationFixture(1)],continuation:null}):next()});t.after(()=>database.close());
 findListButtonByViewId(harness.elements.get('views-list'),'for-you')!.dispatch('click');
 await waitForBrowserCondition(()=>harness.elements.get('reader-title')!.textContent==='Recommended 1',100);
 harness.elements.get('not-interested-button')!.dispatch('click');harness.elements.get('not-interested-button')!.dispatch('click');
 await waitForBrowserCondition(()=>harness.elements.get('reader-action-status')!.textContent==='Preference saved: not interested.',100);
 assert.equal(harness.elements.get('articles-list')!.children.length,0);
 assert.equal(harness.elements.get('reader-title')!.textContent,'Recommended 1');
 assert.equal(harness.getCachedArticleState('1').body.includes('user/-/state/com.google/starred'),true);
 assert.equal(database.prepare("SELECT COUNT(*) AS count FROM engagement_events WHERE event_type='not_interested'").get()!.count,1);
});

test('read Undo cannot restore a confirmed Not interested story to cached For You',async(t)=>{
 const {database,harness}=await createStatefulArticleBrowser({fetchOverride:async(input,init,next)=>input.startsWith('/api/v1/recommendations?')?Response.json({items:[recommendationFixture(1)],continuation:null}):next()});t.after(()=>database.close());
 findListButtonByViewId(harness.elements.get('views-list'),'for-you')!.dispatch('click');await waitForBrowserCondition(()=>harness.elements.get('reader-title')!.textContent==='Recommended 1',100);
 harness.elements.get('article-read-filter')!.value='unread';harness.elements.get('article-read-filter')!.dispatch('change');await flushBrowserTasks();
 await finishArticleMutation(harness,'mark-unread-button');
 harness.elements.get('not-interested-button')!.dispatch('click');await waitForBrowserCondition(()=>harness.elements.get('reader-action-status')!.textContent.includes('not interested'),100);
 harness.setOnline(false);await finishArticleMutation(harness,'undo-article-button');
 assert.equal(harness.elements.get('articles-list')!.children.length,0);
 assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-1'").get()!.is_read,0);
});

test('recommendation feed identity matches an exact feed key and retains folders',async(t)=>{
 const {database,harness}=await createStatefulArticleBrowser({fetchOverride:async(input,init,next)=>{
  if(input==='/reader/api/0/subscription/list')return Response.json({subscriptions:[
   {id:'feed/2',title:'Design weekly',url:'https://pigeon.example/feed/design-weekly'},
   {id:'feed/1',title:'Design',url:'https://pigeon.example/feed/design',categories:[{id:'user/-/label/Design folder',label:'Design folder'}]}]});
  if(input.startsWith('/api/v1/recommendations?'))return Response.json({items:[{...recommendationFixture(1),feedKey:'design'}],continuation:null});return next();
 }});t.after(()=>database.close());
 findListButtonByViewId(harness.elements.get('feeds-list'),'feed/2')!.dispatch('click');await flushBrowserTasks();
 harness.elements.get('article-read-filter')!.value='unread';harness.elements.get('article-read-filter')!.dispatch('change');await flushBrowserTasks();
 findListButtonByViewId(harness.elements.get('views-list'),'for-you')!.dispatch('click');await waitForBrowserCondition(()=>harness.elements.get('reader-title')!.textContent==='Recommended 1',100);
 assert.ok(harness.getCachedArticleState('1').body.includes('user/-/label/Design folder'));
 await finishArticleMutation(harness,'mark-unread-button');harness.setOnline(false);await finishArticleMutation(harness,'undo-article-button');
 findListButtonByViewId(harness.elements.get('feeds-list'),'feed/2')!.dispatch('click');await flushBrowserTasks();
 assert.equal(harness.elements.get('articles-list')!.children.length,0);
});

test('personalization reset disables feedback and suppresses a delayed pre-reset acknowledgement',async(t)=>{
 const held=createDeferred<Response>();let feedbackStarted=false;
 const {database,harness}=await createStatefulArticleBrowser({fetchOverride:async(input,init,next)=>{
  if(input.endsWith('/mutations') && JSON.parse(init!.body as string).mutations[0].kind==='feedback'){feedbackStarted=true;const response=await next();await held.promise;return response;}return next();
 }});t.after(()=>database.close());
 harness.elements.get('more-like-button')!.dispatch('click');await waitForBrowserCondition(()=>feedbackStarted,100);
 harness.elements.get('settings-button')!.dispatch('click');const panel=harness.elements.get('personalization-content')!;
 await waitForBrowserCondition(()=>panel.querySelectorAll('button').some(node=>node.textContent==='Reset all preferences'),100);
 (panel.querySelectorAll('input').find(node=>(node as any).type==='checkbox') as any).checked=true;
 panel.querySelectorAll('button').find(node=>node.textContent==='Reset all preferences')!.dispatch('click');
 assert.equal(harness.elements.get('not-interested-button')!.disabled,true);
 held.resolve(new Response('released'));await waitForBrowserCondition(()=>panel.querySelectorAll('p').some(node=>node.textContent==='All preferences reset.'),100);
 assert.equal(harness.elements.get('reader-action-status')!.textContent,'');
 assert.equal(database.prepare('SELECT COUNT(*) AS count FROM engagement_events').get()!.count,0);
});

test('closing Library stops follow-up feed changes while refreshing a completed same-account write', async (t) => {
	const held = createDeferred<Response>(); let mutationCalls = 0;
	const { database, harness } = await createStatefulArticleBrowser({ fetchOverride: async (input, init, next) => {
		if (input.endsWith('/mutations') && JSON.parse(init!.body as string).mutations[0].kind === 'rename_feed') { mutationCalls++; const response = await next(); await held.promise; return response; }
		return next();
	} }); t.after(() => database.close());
	harness.elements.get('library-button')!.dispatch('click'); const content = harness.elements.get('library-content')!;
	await waitForBrowserCondition(() => content.querySelectorAll('input').some((node) => node.getAttribute('aria-label') === 'Feed title'), 100);
	content.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === 'Feed title')!.value = 'Saved after close';
	content.querySelectorAll('button').find((node) => node.textContent === 'Save feed')!.dispatch('click');
	await waitForBrowserCondition(() => mutationCalls === 1, 100);
	harness.elements.get('close-library-button')!.dispatch('click'); held.resolve(new Response('released'));
	await waitForBrowserCondition(() => harness.elements.get('feeds-list')!.children.some((node) => node.textContent.includes('Saved after close')), 200);
	assert.equal(mutationCalls, 1); assert.equal(content.childElementCount, 0);
});

test('manual read and star toggles persist, display state and undo each individual change', async (t) => {
	const { database, harness, mutations } = await createStatefulArticleBrowser();
	t.after(() => database.close());
	assert.equal(mutations.length, 0, 'manual is the default');
	assert.equal(harness.elements.get('mark-unread-button')!.textContent, 'Mark read');
	await finishArticleMutation(harness, 'mark-unread-button');
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-3'").get()!.is_read, 1);
	assert.equal(harness.elements.get('mark-unread-button')!.textContent, 'Mark unread');
	assert.equal(findListButtonByItemId(harness.elements.get('articles-list'), '3')!.classList.contains('is-read'), true);
	await finishArticleMutation(harness, 'undo-article-button');
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-3'").get()!.is_read, 0);
	assert.equal(harness.elements.get('undo-article-button')!.classList.contains('hidden'), true);
	await finishArticleMutation(harness, 'star-article-button');
	assert.equal(database.prepare("SELECT is_starred FROM items WHERE id='today-3'").get()!.is_starred, 1);
	assert.equal(harness.elements.get('star-article-button')!.getAttribute('aria-pressed'), 'true');
	assert.match(findListButtonByItemId(harness.elements.get('articles-list'), '3')!.textContent, /★/);
	await finishArticleMutation(harness, 'star-article-button');
	assert.equal(database.prepare("SELECT is_starred FROM items WHERE id='today-3'").get()!.is_starred, 0);
	await finishArticleMutation(harness, 'undo-article-button');
	assert.equal(database.prepare("SELECT is_starred FROM items WHERE id='today-3'").get()!.is_starred, 1);
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-3'").get()!.is_read, 0);
});

test('Starred and Unread memberships update while the changed story stays open, including undo', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser();
	t.after(() => database.close());
	findListButtonByViewId(harness.elements.get('views-list'), 'starred')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('articles-status')!.textContent === 'No articles in Starred.');
	findListButtonByViewId(harness.elements.get('views-list'), 'all')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 3');
	await finishArticleMutation(harness, 'star-article-button');
	findListButtonByViewId(harness.elements.get('views-list'), 'starred')!.dispatch('click');
	await waitForBrowserCondition(() => renderedArticleIds(harness).join() === '3');
	await finishArticleMutation(harness, 'star-article-button');
	await waitForBrowserCondition(() => renderedArticleIds(harness).length === 0);
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 3');
	await finishArticleMutation(harness, 'undo-article-button');
	assert.deepEqual(renderedArticleIds(harness), ['3']);
	findListButtonByViewId(harness.elements.get('views-list'), 'unread')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('articles-heading')!.textContent === 'Unread' && renderedArticleIds(harness).length === 4);
	await finishArticleMutation(harness, 'mark-unread-button');
	assert.equal(renderedArticleIds(harness).includes('3'), true, 'a story read in the open Unread list stays until the list is refreshed');
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 3');
	await finishArticleMutation(harness, 'undo-article-button');
	assert.equal(renderedArticleIds(harness).includes('3'), true);
});

test('when-opened auto-read respects manual unread across refresh and navigation without consuming Unread', async (t) => {
	const { database, harness, mutations } = await createStatefulArticleBrowser({ policy: 'opened' });
	t.after(() => database.close());
	await waitForBrowserCondition(() => harness.elements.get('mark-unread-button')!.textContent === 'Mark unread');
	assert.equal(mutations.length, 1);
	findListButtonByViewId(harness.elements.get('views-list'), 'unread')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 2' && harness.elements.get('mark-unread-button')!.textContent === 'Mark unread');
	await flushBrowserTasks();
	assert.equal(mutations.length, 2, 'only opened stories are marked read');
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 2');
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-1'").get()!.is_read, 0);
	await finishArticleMutation(harness, 'mark-unread-button');
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-2'").get()!.is_read, 0);
	harness.dispatchDocumentEvent('visibilitychange');
	await flushBrowserTasks();
	findListButtonByViewId(harness.elements.get('views-list'), 'all')!.dispatch('click');
	await waitForBrowserCondition(() => renderedArticleIds(harness).includes('2'));
	findListButtonByItemId(harness.elements.get('articles-list'), '2')!.dispatch('click');
	await flushBrowserTasks();
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-2'").get()!.is_read, 0);
	assert.equal(mutations.length, 3);
	await finishArticleMutation(harness, 'mark-unread-button');
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-2'").get()!.is_read, 1);
});

test('60% policy marks read only after sufficient article content is visible and permits undo', async (t) => {
	const { database, harness, mutations } = await createStatefulArticleBrowser({ policy: 'progress', frameHeight: 1000, viewportHeight: 200 });
	t.after(() => database.close());
	assert.equal(mutations.length, 0);
	harness.dispatchReaderFrameScroll(399);
	await flushBrowserTasks();
	assert.equal(mutations.length, 0);
	harness.dispatchReaderFrameScroll(400);
	await waitForBrowserCondition(() => harness.elements.get('mark-unread-button')!.textContent === 'Mark unread');
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-3'").get()!.is_read, 1);
	assert.equal(mutations.length, 1);
	await finishArticleMutation(harness, 'undo-article-button');
	harness.dispatchReaderFrameScroll(700);
	await flushBrowserTasks();
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-3'").get()!.is_read, 0);
	assert.equal(mutations.length, 2);
});

test('reading preferences persist and invalid preferences safely fall back to manual', async (t) => {
	const { database, harness, mutations } = await createStatefulArticleBrowser({ policy: 'invalid' });
	t.after(() => database.close());
	assert.equal(harness.elements.get('auto-read-select')!.value, 'manual');
	assert.equal(mutations.length, 0);
	harness.elements.get('auto-read-select')!.value = 'opened';
	harness.elements.get('auto-read-select')!.dispatch('change');
	await waitForBrowserCondition(() => harness.elements.get('mark-unread-button')!.textContent === 'Mark unread');
	assert.equal(harness.localStorageState.get('pigeon.browser.auto-read'), 'opened');
	assert.equal(harness.elements.get('reading-preference-status')!.textContent, 'Reading preference saved.');
});

test('automatic read failures do not retry indefinitely and manual retry remains available', async (t) => {
	let failing = true;
	const { database, harness, mutations } = await createStatefulArticleBrowser({ policy: 'opened', fetchOverride: async (input, _init, next) =>
		input.endsWith('/edit-tag') && failing ? new Response('Error', { status: 503 }) : next() });
	t.after(() => database.close());
	await waitForBrowserCondition(() => harness.elements.get('reader-action-status')!.textContent === 'Could not mark read. Try again.');
	harness.elements.get('theme-toggle-button')!.dispatch('click');
	await flushBrowserTasks();
	assert.equal(mutations.length, 1);
	failing = false;
	await finishArticleMutation(harness, 'mark-unread-button');
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-3'").get()!.is_read, 1);
});

test('read and star keyboard shortcuts work in the article and ignore editable inputs and modifiers', async (t) => {
	const { database, harness, mutations } = await createStatefulArticleBrowser();
	t.after(() => database.close());
	assert.equal(harness.dispatchKeydown('m', harness.elements.get('password-input') as never), false);
	assert.equal(harness.dispatchKeydown('s', undefined, { ctrlKey: true }), false);
	assert.equal(mutations.length, 0);
	assert.equal(harness.dispatchFrameKeydown('s'), true);
	await waitForBrowserCondition(() => harness.elements.get('star-article-button')!.getAttribute('aria-pressed') === 'true');
	assert.equal(harness.dispatchFrameKeydown('m'), true);
	await waitForBrowserCondition(() => harness.elements.get('mark-unread-button')!.textContent === 'Mark unread');
	assert.equal(database.prepare("SELECT is_read,is_starred FROM items WHERE id='today-3'").get()!.is_starred, 1);
});

test('failed undo leaves saved state and undo available for a retry', async (t) => {
	let failing = false;
	const { database, harness } = await createStatefulArticleBrowser({ fetchOverride: async (input, _init, next) =>
		input.endsWith('/edit-tag') && failing ? new Response('Error', { status: 503 }) : next() });
	t.after(() => database.close());
	await finishArticleMutation(harness, 'star-article-button');
	failing = true;
	await finishArticleMutation(harness, 'undo-article-button');
	assert.equal(harness.elements.get('reader-action-status')!.textContent, 'Could not undo. Try again.');
	assert.equal(database.prepare("SELECT is_starred FROM items WHERE id='today-3'").get()!.is_starred, 1);
	assert.equal(harness.elements.get('undo-article-button')!.disabled, false);
	failing = false;
	await finishArticleMutation(harness, 'undo-article-button');
	assert.equal(database.prepare("SELECT is_starred FROM items WHERE id='today-3'").get()!.is_starred, 0);
});

test('Undo targets the original article after navigating to another story', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser();
	t.after(() => database.close());
	await finishArticleMutation(harness, 'star-article-button');
	harness.dispatchKeydown('j');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 2');
	assert.match(harness.elements.get('undo-article-button')!.getAttribute('aria-label')!, /Story 3/);
	await finishArticleMutation(harness, 'undo-article-button');
	assert.equal(database.prepare("SELECT is_starred FROM items WHERE id='today-3'").get()!.is_starred, 0);
	assert.equal(database.prepare("SELECT is_starred FROM items WHERE id='today-2'").get()!.is_starred, 0);
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 2');
});

test('an old Starred root cannot restore a story after it is unstarred', async (t) => {
	const heldRoot = createDeferred<Response>();
	let hold = false;
	const { database, harness } = await createStatefulArticleBrowser({ fetchOverride: async (input, _init, next) => {
		if (hold && input.includes('stream/items/ids?') && input.includes('com.google%2Fstarred')) {
			hold = false;
			const oldResponse = await next();
			return heldRoot.promise.then(() => oldResponse);
		}
		return next();
	} });
	t.after(() => database.close());
	await finishArticleMutation(harness, 'star-article-button');
	findListButtonByViewId(harness.elements.get('views-list'), 'starred')!.dispatch('click');
	await waitForBrowserCondition(() => renderedArticleIds(harness).join() === '3');
	hold = true;
	harness.dispatchDocumentEvent('visibilitychange');
	await flushBrowserTasks();
	await finishArticleMutation(harness, 'star-article-button');
	heldRoot.resolve(new Response('release'));
	await flushBrowserTasks();
	assert.equal(renderedArticleIds(harness).length, 0);
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 3');
	assert.equal(harness.elements.get('star-article-button')!.getAttribute('aria-pressed'), 'false');
});

async function finishBulkRead(harness: Awaited<ReturnType<typeof createBrowserHarness>>, mode: string) {
	harness.elements.get('article-bulk-select')!.value = mode;
	harness.elements.get('article-bulk-button')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('article-bulk-button')!.disabled === false, 1000);
	await waitForBrowserCondition(() => {
		const cache = harness.getCacheSizes();
		return cache.active === 0 && cache.pending === 0 && cache.membership === 0;
	}, 1000);
}

test('server search finds matching titles and text beyond the loaded article page, with literal punctuation', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({ count: 105 });
	t.after(() => database.close());
	assert.equal(renderedArticleIds(harness).includes('1'), false);
	database.prepare("UPDATE items SET subject=?,text_content=? WHERE id='today-1'").run('100%_literal Needle', 'The full text contains hidden quartz');
	await setBrowserQuery(harness, '100%_literal');
	await waitForBrowserCondition(() => renderedArticleIds(harness).join() === '1', 100);
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === '100%_literal Needle', 100);
	assert.equal(harness.elements.get('reader-title')!.textContent, '100%_literal Needle');
	await setBrowserQuery(harness, 'hidden quartz');
	await waitForBrowserCondition(() => renderedArticleIds(harness).join() === '1', 100);
	assert.match(harness.elements.get('reader-frame')!.srcdoc, /Body 1/);
	harness.elements.get('clear-article-search-button')!.dispatch('click');
	await waitForBrowserCondition(() => renderedArticleIds(harness).length === 50, 100);
	assert.equal(harness.elements.get('article-search-input')!.value, '');
});

test('server read filters and oldest sorting apply to the whole stream and keep their cache separate', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({ count: 65 });
	t.after(() => database.close());
	database.exec("UPDATE items SET is_read=1 WHERE id IN ('today-1','today-2','today-3')");
	harness.elements.get('article-read-filter')!.value = 'read';
	harness.elements.get('article-read-filter')!.dispatch('change');
	await waitForBrowserCondition(() => renderedArticleIds(harness).join() === '3,2,1', 100);
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 3', 100);
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 3');
	harness.elements.get('article-sort-select')!.value = 'oldest';
	harness.elements.get('article-sort-select')!.dispatch('change');
	await waitForBrowserCondition(() => renderedArticleIds(harness).join() === '1,2,3', 100);
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 1', 100);
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 1');
	harness.elements.get('article-read-filter')!.value = 'unread';
	harness.elements.get('article-read-filter')!.dispatch('change');
	await waitForBrowserCondition(() => renderedArticleIds(harness)[0] === '67', 100);
	assert.equal(renderedArticleIds(harness).includes('1'), false);
	harness.elements.get('article-sort-select')!.value = 'newest';
	harness.elements.get('article-sort-select')!.dispatch('change');
	await waitForBrowserCondition(() => renderedArticleIds(harness)[0] === '66', 100);
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 66');
});

test('a held old search response cannot replace a newer query or its error status', async (t) => {
	const oldQuery = createDeferred<Response>();
	let held = false;
	const { database, harness } = await createStatefulArticleBrowser({ fetchOverride: async (input, _init, next) => {
		if (input.startsWith('/api/v1/browser/articles?') && new URL(`https://pigeon.example${input}`).searchParams.get('q') === 'Story 1') {
			held = true;
			return oldQuery.promise;
		}
		return next();
	} });
	t.after(() => database.close());
	await setBrowserQuery(harness, 'Story 1');
	await waitForBrowserCondition(() => held);
	await setBrowserQuery(harness, 'Story 2');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 2', 100);
	oldQuery.resolve(new Response('Temporary failure', { status: 503 }));
	await flushBrowserTasks();
	assert.deepEqual(renderedArticleIds(harness), ['2']);
	assert.equal(harness.elements.get('articles-status')!.textContent, '1 article');
	assert.match(harness.elements.get('article-query-status')!.textContent, /Story 2/);
});

test('revisiting a search restores its own cached selected story while offline', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser();
	t.after(() => database.close());
	await setBrowserQuery(harness, 'Story 1');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 1', 100);
	await setBrowserQuery(harness, 'Story 2');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 2', 100);
	harness.setOnline(false);
	await setBrowserQuery(harness, 'Story 1');
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 1');
	assert.deepEqual(renderedArticleIds(harness), ['1']);
	assert.equal(harness.elements.get('articles-status')!.textContent, 'Offline · showing cached articles.');
});

test('searched oldest-first pagination keeps every match reachable past the first page', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({ count: 205 });
	t.after(() => database.close());
	harness.elements.get('article-sort-select')!.value = 'oldest';
	harness.elements.get('article-search-input')!.value = 'Story';
	harness.elements.get('article-query-form')!.dispatch('submit');
	await waitForBrowserCondition(() => renderedArticleIds(harness)[0] === '207', 100);
	const ids = await collectBrowserWindowIds(harness);
	assert.deepEqual(ids, ['207', ...Array.from({ length: 205 }, (_, index) => String(index + 1)), '206']);
	assert.ok(harness.getCacheSizes().bodies <= 500);
});

test('Today search resets its query-bound continuation when the local day rolls over', async (t) => {
	let now = new Date(2026, 9, 12, 12).getTime();
	const queryRequests: Array<{ since: string | null; continuation: string | null }> = [];
	const { database, harness } = await createStatefulArticleBrowser({ count: 65, now: () => now,
		fetchOverride: async (input, _init, next) => {
			if (input.startsWith('/api/v1/browser/articles?')) {
				const params = new URL(`https://pigeon.example${input}`).searchParams;
				queryRequests.push({ since: params.get('since'), continuation: params.get('continuation') });
			}
			return next();
		} });
	t.after(() => database.close());
	await setBrowserQuery(harness, 'Story');
	findListButtonByViewId(harness.elements.get('views-list'), 'today')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 65', 100);
	await waitForBrowserCondition(() => harness.getCacheSizes().active === 0 && harness.getCacheSizes().pending === 0, 100);
	const previousSince = queryRequests.at(-1)!.since;
	now += 86_400_000;
	harness.elements.get('load-more-button')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 66', 100);
	assert.deepEqual(renderedArticleIds(harness), ['66']);
	const newDayRequests = queryRequests.filter((query) => query.since !== previousSince && query.since !== null);
	assert.ok(newDayRequests.length > 0);
	assert.ok(newDayRequests.every((query) => query.continuation === null), 'no old cursor is sent with the new day bounds');
	assert.doesNotMatch(harness.elements.get('articles-status')!.textContent, /failed|Could not/);
});

test('native bulk Undo retries the same idempotency key after an applied response is lost', async (t) => {
	const undoMutationIds: string[] = [];
	let loseFirstUndo = true;
	const { database, harness } = await createStatefulArticleBrowser({ fetchOverride: async (input, init, next) => {
		if (input.endsWith('/mutations')) {
			const mutation = JSON.parse(init!.body as string).mutations[0];
			if (!mutation.value) {
				undoMutationIds.push(mutation.id);
				if (loseFirstUndo) { loseFirstUndo = false; await next(); return new Response('Lost response', { status: 503 }); }
			}
		}
		return next();
	} });
	t.after(() => database.close());
	await finishBulkRead(harness, 'below');
	await finishArticleMutation(harness, 'undo-article-button');
	assert.match(harness.elements.get('article-query-status')!.textContent, /Could not finish undo/);
	await finishArticleMutation(harness, 'undo-article-button');
	assert.equal(undoMutationIds[0], undoMutationIds[1]);
	assert.equal(database.prepare('SELECT COUNT(*) AS count FROM items WHERE is_read=1').get()!.count, 0);
	assert.equal(database.prepare("SELECT COUNT(*) AS count FROM engagement_events WHERE event_type='unread'").get()!.count, 3);
});

test('bulk below uses the complete matching stream, bounded writes and exact prior read states for Undo', async (t) => {
	const { database, harness, mutations } = await createStatefulArticleBrowser({ count: 65 });
	t.after(() => database.close());
	database.exec("UPDATE items SET is_read=1 WHERE id='today-5'");
	findListButtonByItemId(harness.elements.get('articles-list'), '60')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 60');
	await finishBulkRead(harness, 'below');
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-1'").get()!.is_read, 1, 'outside initial page');
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-60'").get()!.is_read, 0, 'selected story excluded');
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-61'").get()!.is_read, 0, 'above excluded');
	assert.ok(mutations.every((mutation) => mutation.itemIds.length <= 20));
	assert.match(harness.elements.get('article-query-status')!.textContent, /Marked 59 articles read/);
	await finishArticleMutation(harness, 'undo-article-button');
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-1'").get()!.is_read, 0);
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-5'").get()!.is_read, 1, 'prior read state preserved');
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 60');
	assert.match(harness.elements.get('article-query-status')!.textContent, /Restored previous read status for 59/);
});

test('bulk above follows the displayed oldest-first order and respects the current search', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({ count: 65 });
	t.after(() => database.close());
	harness.elements.get('article-sort-select')!.value = 'oldest';
	harness.elements.get('article-search-input')!.value = 'Story 2';
	harness.elements.get('article-query-form')!.dispatch('submit');
	await waitForBrowserCondition(() => renderedArticleIds(harness).includes('25'), 100);
	findListButtonByItemId(harness.elements.get('articles-list'), '25')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 25');
	await finishBulkRead(harness, 'above');
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-2'").get()!.is_read, 1);
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-24'").get()!.is_read, 1);
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-25'").get()!.is_read, 0);
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-26'").get()!.is_read, 0);
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-1'").get()!.is_read, 0, 'outside search');
});

function openArticleContextMenu(harness: Awaited<ReturnType<typeof createBrowserHarness>>, itemId: string, event: Record<string, unknown> = { clientX: 120, clientY: 240 }) {
	let prevented = false;
	findListButtonByItemId(harness.elements.get('articles-list'), itemId)!.dispatch('contextmenu', { ...event, preventDefault() { prevented = true; } });
	return prevented;
}

async function finishContextBulkRead(harness: Awaited<ReturnType<typeof createBrowserHarness>>, buttonId: string) {
	harness.elements.get(buttonId)!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('article-bulk-button')!.disabled === false, 1000);
	await waitForBrowserCondition(() => {
		const cache = harness.getCacheSizes();
		return cache.active === 0 && cache.pending === 0 && cache.membership === 0;
	}, 1000);
}

test('right-clicking a list row marks everything above it read without opening it, with Undo', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({ count: 65 });
	t.after(() => database.close());
	const menu = harness.elements.get('article-context-menu')!;
	assert.equal(openArticleContextMenu(harness, '60'), true, 'browser menu suppressed on article rows');
	assert.equal(menu.classList.contains('hidden'), false);
	assert.equal(menu.style.getPropertyValue('left'), '120px');
	assert.equal(menu.style.getPropertyValue('top'), '240px');
	assert.equal(harness.elements.get('context-mark-above-button')!.disabled, false);
	assert.equal(harness.getActiveElement(), harness.elements.get('context-mark-above-button'));
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 66', 'right-click does not open the row');
	await finishContextBulkRead(harness, 'context-mark-above-button');
	assert.equal(menu.classList.contains('hidden'), true);
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 66', 'open article unchanged');
	for (const id of [61, 63, 66]) assert.equal(database.prepare(`SELECT is_read FROM items WHERE id='today-${id}'`).get()!.is_read, 1, 'above ' + id);
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-60'").get()!.is_read, 0, 'clicked row excluded');
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-59'").get()!.is_read, 0, 'below untouched');
	assert.match(harness.elements.get('article-query-status')!.textContent, /Marked 6 articles read/);
	await finishArticleMutation(harness, 'undo-article-button');
	assert.equal(database.prepare('SELECT COUNT(*) AS count FROM items WHERE is_read=1').get()!.count, 0);
});

test('right-click Mark below as read uses the clicked row, and the top row cannot mark above', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({ count: 65 });
	t.after(() => database.close());
	findListButtonByItemId(harness.elements.get('articles-list'), '30')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 30');
	openArticleContextMenu(harness, '66');
	assert.equal(harness.elements.get('context-mark-above-button')!.disabled, true, 'nothing above the first row');
	assert.equal(harness.elements.get('context-mark-below-button')!.disabled, false);
	assert.equal(harness.getActiveElement(), harness.elements.get('context-mark-below-button'), 'focus skips the disabled item');
	openArticleContextMenu(harness, '62');
	await finishContextBulkRead(harness, 'context-mark-below-button');
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 30');
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-62'").get()!.is_read, 0, 'clicked row excluded');
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-63'").get()!.is_read, 0, 'above untouched');
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-1'").get()!.is_read, 1, 'beyond the loaded page');
	assert.match(harness.elements.get('article-query-status')!.textContent, /Marked 62 articles read/);
});

test('the article context menu tracks a pending write and never lets Enter fall through to the row', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({ count: 65 });
	t.after(() => database.close());
	const menu = harness.elements.get('article-context-menu')!;
	const above = harness.elements.get('context-mark-above-button')!;
	const below = harness.elements.get('context-mark-below-button')!;
	openArticleContextMenu(harness, '40');
	below.dispatch('click');
	openArticleContextMenu(harness, '62');
	assert.equal(above.disabled && below.disabled, true, 'both items wait for the running write');
	const row = findListButtonByItemId(harness.elements.get('articles-list'), '62')!;
	assert.equal(harness.dispatchKeydown('Enter', row), true, 'Enter is consumed, not passed to the row');
	assert.equal(menu.classList.contains('hidden'), true);
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 66', 'the row did not open');
	openArticleContextMenu(harness, '62');
	await waitForBrowserCondition(() => harness.elements.get('article-bulk-button')!.disabled === false, 1000);
	assert.equal(menu.classList.contains('hidden'), false);
	assert.equal(above.disabled, false, 'items re-enable once the write finishes');
	assert.equal(below.disabled, false);
	harness.dispatchKeydown('Escape');
	await waitForBrowserCondition(() => {
		const cache = harness.getCacheSizes();
		return cache.active === 0 && cache.pending === 0 && cache.membership === 0;
	}, 1000);
});

test('the article context menu closes on Escape, outside clicks and query changes, holds scroll, and never writes stale', async (t) => {
	const { database, harness, mutations } = await createStatefulArticleBrowser({ count: 65 });
	t.after(() => database.close());
	const menu = harness.elements.get('article-context-menu')!;
	const row = findListButtonByItemId(harness.elements.get('articles-list'), '60')!;
	openArticleContextMenu(harness, '60');
	assert.equal(harness.dispatchKeydown('Escape'), true);
	assert.equal(menu.classList.contains('hidden'), true);
	assert.equal(harness.getActiveElement(), row, 'focus returns to the row');
	openArticleContextMenu(harness, '60');
	harness.dispatchKeydown('ArrowDown');
	assert.equal(harness.getActiveElement(), harness.elements.get('context-mark-below-button'));
	harness.dispatchKeydown('ArrowUp');
	assert.equal(harness.getActiveElement(), harness.elements.get('context-mark-above-button'));
	for (const key of ['Enter', ' ', 'Shift']) {
		assert.equal(harness.dispatchKeydown(key), false, key + ' is left to the focused menu item');
		assert.equal(menu.classList.contains('hidden'), false, key + ' keeps the menu open so the item can activate');
	}
	harness.dispatchKeydown('j');
	assert.equal(menu.classList.contains('hidden'), true, 'other keys dismiss it');
	openArticleContextMenu(harness, '60');
	harness.dispatchDocumentPointer('pointerdown', 10);
	assert.equal(menu.classList.contains('hidden'), true);
	openArticleContextMenu(harness, '60');
	harness.elements.get('articles-list-shell')!.dispatch('scroll');
	assert.equal(menu.classList.contains('hidden'), false, 'a late scroll event from before opening does not close it');
	assert.equal(harness.dispatchDocumentPointer('wheel', 10), true, 'like a native menu, the list does not scroll under it');
	harness.dispatchKeydown('Escape');
	assert.throws(() => harness.dispatchDocumentPointer('wheel', 10), /No wheel handler/, 'no wheel listener once it closes, so scrolling stays off the main thread');
	let nativePrevented = false;
	openArticleContextMenu(harness, '60');
	menu.dispatch('contextmenu', { preventDefault() { nativePrevented = true; } });
	assert.equal(nativePrevented, true, 'a late native contextmenu (Windows Menu key keyup) does not stack on top');
	harness.dispatchKeydown('Escape');
	openArticleContextMenu(harness, '60', { clientX: 0, clientY: 0 });
	assert.equal(menu.classList.contains('hidden'), false, 'a keyboard-triggered contextmenu event opens it too');
	assert.equal(menu.style.getPropertyValue('top'), '900px', 'anchored to the row when there is no pointer position');
	harness.dispatchKeydown('Escape');
	// macOS Chrome never turns Shift+F10 into a contextmenu event, so the app handles it.
	assert.equal(harness.dispatchKeydown('F10', row, { shiftKey: true }), true);
	assert.equal(menu.classList.contains('hidden'), false, 'Shift+F10 on a focused row');
	harness.dispatchKeydown('Escape');
	assert.equal(harness.dispatchKeydown('ContextMenu', row), true);
	assert.equal(menu.classList.contains('hidden'), false, 'context-menu key on a focused row');
	harness.dispatchKeydown('Escape');
	assert.equal(harness.dispatchKeydown('F10', harness.elements.get('reader-shell'), { shiftKey: true }), false, 'only on article rows');
	assert.equal(menu.classList.contains('hidden'), true);
	openArticleContextMenu(harness, '60');
	await setBrowserQuery(harness, 'Story 6');
	harness.elements.get('context-mark-above-button')!.dispatch('click');
	await flushBrowserTasks();
	assert.equal(menu.classList.contains('hidden'), true);
	assert.equal(mutations.length, 0, 'a stale menu never writes');
	assert.equal(database.prepare('SELECT COUNT(*) AS count FROM items WHERE is_read=1').get()!.count, 0);
});

test('bulk older-than 1, 7 and 30 days use exact age cutoffs and support Undo', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser();
	t.after(() => database.close());
	const insert = database.prepare('INSERT INTO items(id,feed_key,subject,html_content,message_id,received_at) VALUES(?,?,?,?,?,?)');
	const now = new Date(2026, 9, 12, 12).getTime();
	for (const days of [2, 8, 31]) insert.run('age-' + days, 'today-source', 'Old ' + days, '<p>Old story</p>', 'age-message-' + days, new Date(now - days * 86_400_000).toISOString());
	for (const [mode, expectedCount] of [['age-1', 3], ['age-7', 2], ['age-30', 1]] as const) {
		await finishBulkRead(harness, mode);
		assert.equal(database.prepare('SELECT COUNT(*) AS count FROM items WHERE is_read=1').get()!.count, expectedCount);
		await finishArticleMutation(harness, 'undo-article-button');
		assert.equal(database.prepare('SELECT COUNT(*) AS count FROM items WHERE is_read=1').get()!.count, 0);
	}
});

test('partial bulk failure reports confirmed changes and Undo restores even an uncertain failed batch', async (t) => {
	let writes = 0;
	let failSecond = true;
	const { database, harness } = await createStatefulArticleBrowser({ count: 65, fetchOverride: async (input, _init, next) => {
		if (input.endsWith('/mutations') && ++writes === 2 && failSecond) {
			await next();
			return new Response('Response lost after saving', { status: 503 });
		}
		return next();
	} });
	t.after(() => database.close());
	await finishBulkRead(harness, 'below');
	assert.equal(database.prepare('SELECT COUNT(*) AS count FROM items WHERE is_read=1').get()!.count, 40);
	assert.match(harness.elements.get('article-query-status')!.textContent, /Could not finish.*20 saved changes confirmed/);
	failSecond = false;
	await finishArticleMutation(harness, 'undo-article-button');
	assert.equal(database.prepare('SELECT COUNT(*) AS count FROM items WHERE is_read=1').get()!.count, 0);
	assert.match(harness.elements.get('article-query-status')!.textContent, /Restored previous read status for 40/);
});

test('partial bulk Undo is retryable and never claims that unfinished batches were restored', async (t) => {
	let writes = 0;
	const { database, harness } = await createStatefulArticleBrowser({ count: 65, fetchOverride: async (input, _init, next) => {
		if (input.endsWith('/mutations') && ++writes === 6) return new Response('Undo failed', { status: 503 });
		return next();
	} });
	t.after(() => database.close());
	await finishBulkRead(harness, 'below');
	assert.equal(writes, 4);
	await finishArticleMutation(harness, 'undo-article-button');
	assert.equal(database.prepare('SELECT COUNT(*) AS count FROM items WHERE is_read=1').get()!.count, 46);
	assert.match(harness.elements.get('article-query-status')!.textContent, /Restored 20 articles. Could not finish undo/);
	assert.equal(harness.elements.get('undo-article-button')!.disabled, false);
	await finishArticleMutation(harness, 'undo-article-button');
	assert.equal(database.prepare('SELECT COUNT(*) AS count FROM items WHERE is_read=1').get()!.count, 0);
});

test('bulk snapshot failure sends no mutations and clearly reports that selection could not be checked', async (t) => {
	let failSnapshots = false;
	const { database, harness, mutations } = await createStatefulArticleBrowser({ fetchOverride: async (input, _init, next) =>
		failSnapshots && input.endsWith('/contents') ? new Response('Unavailable', { status: 503 }) : next() });
	t.after(() => database.close());
	failSnapshots = true;
	await finishBulkRead(harness, 'below');
	assert.equal(mutations.length, 0);
	assert.equal(database.prepare('SELECT COUNT(*) AS count FROM items WHERE is_read=1').get()!.count, 0);
	assert.match(harness.elements.get('article-query-status')!.textContent, /No read changes were sent/);
});

test('a held bulk enumeration cannot send writes or clear a new session mutation after logout', async (t) => {
	const enumeration = createDeferred<Response>();
	const newMutation = createDeferred<Response>();
	let held = false;
	let holdMutation = false;
	const { database, harness, mutations } = await createStatefulArticleBrowser({ fetchOverride: async (input, _init, next) => {
		if (input.startsWith('/api/v1/browser/articles?') && !held) { held = true; return enumeration.promise; }
		if (input.endsWith('/edit-tag') && holdMutation) return newMutation.promise;
		return next();
	} });
	t.after(() => database.close());
	harness.elements.get('article-bulk-select')!.value = 'below';
	harness.elements.get('article-bulk-button')!.dispatch('click');
	await waitForBrowserCondition(() => held);
	harness.elements.get('logout-button')!.dispatch('click');
	await harness.elements.get('login-form')!.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 3', 100);
	holdMutation = true;
	harness.elements.get('mark-unread-button')!.dispatch('click');
	enumeration.resolve(Response.json({ itemIds: ['3', '2', '1', '4'], continuation: null }));
	await flushBrowserTasks();
	assert.equal(mutations.length, 1);
	assert.equal(harness.elements.get('mark-unread-button')!.disabled, true);
	assert.equal(harness.elements.get('reader-action-status')!.textContent, 'Marking article read…');
	newMutation.resolve(new Response('OK'));
	await waitForBrowserCondition(() => harness.elements.get('mark-unread-button')!.disabled === false, 100);
});

async function waitForArticleRows(harness: Awaited<ReturnType<typeof createBrowserHarness>>, ids: string[]) {
	await waitForBrowserCondition(() => renderedArticleIds(harness).join() === ids.join(), 200);
	await waitForBrowserCondition(() => {
		const cache = harness.getCacheSizes();
		return cache.active === 0 && cache.pending === 0 && cache.membership === 0 && !cache.paging;
	}, 1000);
	assert.deepEqual(renderedArticleIds(harness), ids);
}

async function openUnreadAndReadStory2(harness: Awaited<ReturnType<typeof createBrowserHarness>>) {
	findListButtonByViewId(harness.elements.get('views-list'), 'unread')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('articles-heading')!.textContent === 'Unread' && renderedArticleIds(harness).length === 4);
	findListButtonByItemId(harness.elements.get('articles-list'), '2')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 2' && harness.elements.get('mark-unread-button')!.disabled === false);
	await finishArticleMutation(harness, 'mark-unread-button');
	assert.equal(harness.elements.get('mark-unread-button')!.textContent, 'Mark unread');
}

function articleRowIsRead(harness: Awaited<ReturnType<typeof createBrowserHarness>>, itemId: string) {
	const row = findListButtonByItemId(harness.elements.get('articles-list'), itemId)!;
	assert.equal(row.classList.contains('is-read'), row.getAttribute('data-read') === 'true');
	return row.getAttribute('data-read') === 'true';
}

test('an article read in Unread stays in place, styled read, through background reloads and keeps j/k order', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser();
	t.after(() => database.close());
	await openUnreadAndReadStory2(harness);
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-2'").get()!.is_read, 1);
	await waitForArticleRows(harness, ['3', '2', '1', '4']);
	assert.equal(articleRowIsRead(harness, '2'), true);
	assert.equal(articleRowIsRead(harness, '1'), false);
	harness.dispatchDocumentEvent('visibilitychange');
	await flushBrowserTasks();
	await waitForArticleRows(harness, ['3', '2', '1', '4']);
	harness.setOnline(false); harness.setOnline(true);
	await flushBrowserTasks();
	await waitForArticleRows(harness, ['3', '2', '1', '4']);
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 2');
	harness.dispatchKeydown('j');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 1');
	harness.dispatchKeydown('k');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 2');
	harness.dispatchKeydown('k');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 3');
	assert.deepEqual(renderedArticleIds(harness), ['3', '2', '1', '4']);
	findListButtonByViewId(harness.elements.get('views-list'), 'all')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('articles-heading')!.textContent !== 'Unread');
	findListButtonByViewId(harness.elements.get('views-list'), 'unread')!.dispatch('click');
	await waitForArticleRows(harness, ['3', '1', '4']);
});

test('opening an article with when-opened auto-read keeps its row in Unread', async (t) => {
	const { database, harness, mutations } = await createStatefulArticleBrowser({ policy: 'opened' });
	t.after(() => database.close());
	findListButtonByViewId(harness.elements.get('views-list'), 'unread')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('articles-heading')!.textContent === 'Unread' && renderedArticleIds(harness).length === 3);
	const unreadIds = renderedArticleIds(harness);
	const opened = mutations.length;
	findListButtonByItemId(harness.elements.get('articles-list'), '1')!.dispatch('click');
	await waitForBrowserCondition(() => mutations.length === opened + 1 && harness.elements.get('mark-unread-button')!.textContent === 'Mark unread', 200);
	await waitForArticleRows(harness, unreadIds);
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-1'").get()!.is_read, 1);
	assert.equal(articleRowIsRead(harness, '1'), true);
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 1');
});

test('marking a kept Unread article unread again restores its styling and keeps it after reloads', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser();
	t.after(() => database.close());
	await openUnreadAndReadStory2(harness);
	await finishArticleMutation(harness, 'mark-unread-button');
	assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-2'").get()!.is_read, 0);
	await waitForArticleRows(harness, ['3', '2', '1', '4']);
	assert.equal(articleRowIsRead(harness, '2'), false);
	harness.elements.get('refresh-view-button')!.dispatch('click');
	await flushBrowserTasks();
	await waitForArticleRows(harness, ['3', '2', '1', '4']);
	assert.equal(articleRowIsRead(harness, '2'), false);
});

test('an explicit refresh re-filters kept Unread rows while the open article stays in the reader', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser();
	t.after(() => database.close());
	await openUnreadAndReadStory2(harness);
	await waitForArticleRows(harness, ['3', '2', '1', '4']);
	harness.elements.get('refresh-view-button')!.dispatch('click');
	await flushBrowserTasks();
	await waitForArticleRows(harness, ['3', '1', '4']);
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 2');
});

test('mark all read clears kept Unread rows', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser();
	t.after(() => database.close());
	await openUnreadAndReadStory2(harness);
	await waitForArticleRows(harness, ['3', '2', '1', '4']);
	await finishBulkRead(harness, 'all');
	await waitForArticleRows(harness, []);
	assert.equal(database.prepare('SELECT COUNT(*) AS count FROM items WHERE is_read=0').get()!.count, 0);
});

test('a feed filtered to Unread keeps a read article until the read filter or sort changes', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser();
	t.after(() => database.close());
	findListButtonByViewId(harness.elements.get('feeds-list'), 'feed/1')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('articles-heading')!.textContent === 'Today source');
	harness.elements.get('article-read-filter')!.value = 'unread';
	harness.elements.get('article-read-filter')!.dispatch('change');
	await waitForArticleRows(harness, ['3', '2', '1', '4']);
	findListButtonByItemId(harness.elements.get('articles-list'), '2')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 2');
	await finishArticleMutation(harness, 'mark-unread-button');
	await waitForArticleRows(harness, ['3', '2', '1', '4']);
	assert.equal(articleRowIsRead(harness, '2'), true);
	harness.dispatchDocumentEvent('visibilitychange');
	await flushBrowserTasks();
	await waitForArticleRows(harness, ['3', '2', '1', '4']);
	harness.elements.get('article-read-filter')!.value = 'all';
	harness.elements.get('article-read-filter')!.dispatch('change');
	await waitForArticleRows(harness, ['3', '2', '1', '4']);
	harness.elements.get('article-read-filter')!.value = 'unread';
	harness.elements.get('article-read-filter')!.dispatch('change');
	await waitForArticleRows(harness, ['3', '1', '4']);
	findListButtonByItemId(harness.elements.get('articles-list'), '1')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 1');
	await finishArticleMutation(harness, 'mark-unread-button');
	await waitForArticleRows(harness, ['3', '1', '4']);
	harness.elements.get('article-sort-select')!.value = 'oldest';
	harness.elements.get('article-sort-select')!.dispatch('change');
	await waitForArticleRows(harness, ['4', '3']);
});

test('a feed filtered to Read keeps an article marked unread in place', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser();
	t.after(() => database.close());
	database.exec("UPDATE items SET is_read=1 WHERE id IN ('today-1','today-2','today-3')");
	findListButtonByViewId(harness.elements.get('feeds-list'), 'feed/1')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('articles-heading')!.textContent === 'Today source');
	harness.elements.get('article-read-filter')!.value = 'read';
	harness.elements.get('article-read-filter')!.dispatch('change');
	await waitForArticleRows(harness, ['3', '2', '1']);
	findListButtonByItemId(harness.elements.get('articles-list'), '2')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 2' && harness.elements.get('mark-unread-button')!.textContent === 'Mark unread');
	await finishArticleMutation(harness, 'mark-unread-button');
	await waitForArticleRows(harness, ['3', '2', '1']);
	assert.equal(articleRowIsRead(harness, '2'), false);
	harness.elements.get('refresh-view-button')!.dispatch('click');
	await flushBrowserTasks();
	await waitForArticleRows(harness, ['3', '1']);
});

test('unstarring a kept read row in Starred filtered to Unread removes it for good', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser();
	t.after(() => database.close());
	await finishArticleMutation(harness, 'star-article-button');
	findListButtonByViewId(harness.elements.get('views-list'), 'starred')!.dispatch('click');
	await waitForArticleRows(harness, ['3']);
	harness.elements.get('article-read-filter')!.value = 'unread';
	harness.elements.get('article-read-filter')!.dispatch('change');
	await waitForArticleRows(harness, ['3']);
	await finishArticleMutation(harness, 'mark-unread-button');
	await waitForArticleRows(harness, ['3']);
	await finishArticleMutation(harness, 'star-article-button');
	await waitForArticleRows(harness, []);
	harness.dispatchDocumentEvent('visibilitychange');
	await flushBrowserTasks();
	await waitForArticleRows(harness, []);
});

test('Not interested on a kept read row in For You filtered to Unread removes it for good', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({ fetchOverride: async (input, _init, next) => input.startsWith('/api/v1/recommendations?')
		? Response.json({ items: [recommendationFixture(1), recommendationFixture(2)], continuation: null }) : next() });
	t.after(() => database.close());
	findListButtonByViewId(harness.elements.get('views-list'), 'for-you')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Recommended 1', 100);
	harness.elements.get('article-read-filter')!.value = 'unread';
	harness.elements.get('article-read-filter')!.dispatch('change');
	await waitForArticleRows(harness, ['1', '2']);
	await finishArticleMutation(harness, 'mark-unread-button');
	await waitForArticleRows(harness, ['1', '2']);
	harness.elements.get('not-interested-button')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-action-status')!.textContent === 'Preference saved: not interested.', 100);
	await waitForArticleRows(harness, ['2']);
	harness.dispatchDocumentEvent('visibilitychange');
	await flushBrowserTasks();
	await waitForArticleRows(harness, ['2']);
});

test('a Today day change re-filters kept read rows in the cached previous-day list', async (t) => {
	let now = new Date(2026, 9, 12, 12).getTime();
	const { database, harness } = await createStatefulArticleBrowser({ now: () => now });
	t.after(() => database.close());
	findListButtonByViewId(harness.elements.get('views-list'), 'today')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('articles-heading')!.textContent === 'Today');
	harness.elements.get('article-read-filter')!.value = 'unread';
	harness.elements.get('article-read-filter')!.dispatch('change');
	await waitForArticleRows(harness, ['2', '1']);
	findListButtonByItemId(harness.elements.get('articles-list'), '1')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 1');
	await finishArticleMutation(harness, 'mark-unread-button');
	await waitForArticleRows(harness, ['2', '1']);
	now += 86_400_000;
	harness.dispatchDocumentEvent('visibilitychange');
	await flushBrowserTasks();
	await waitForArticleRows(harness, ['3']);
	harness.setOnline(false);
	now -= 86_400_000;
	harness.dispatchDocumentEvent('visibilitychange');
	await flushBrowserTasks();
	assert.deepEqual(renderedArticleIds(harness), ['2']);
});

test('a kept Unread row survives loading the next membership page at its sorted position', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({ count: 60 });
	t.after(() => database.close());
	findListButtonByViewId(harness.elements.get('views-list'), 'unread')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('articles-heading')!.textContent === 'Unread' && renderedArticleIds(harness).length === 50, 200);
	const firstPage = renderedArticleIds(harness);
	const keptId = firstPage.at(-1)!;
	findListButtonByItemId(harness.elements.get('articles-list'), keptId)!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story ' + keptId, 200);
	await finishArticleMutation(harness, 'mark-unread-button');
	// The reloaded root page omits the read story; it stays at its sorted
	// position and the next unread story moves up into the page.
	await waitForArticleRows(harness, [...firstPage, '11']);
	harness.elements.get('load-more-button')!.dispatch('click');
	await waitForBrowserCondition(() => renderedArticleIds(harness).length > 51, 200);
	await waitForArticleRows(harness, renderedArticleIds(harness));
	const ids = renderedArticleIds(harness);
	assert.deepEqual(ids, [...firstPage, ...Array.from({ length: 11 }, (_, index) => String(11 - index)), '62']);
	assert.equal(articleRowIsRead(harness, keptId), true);
});
