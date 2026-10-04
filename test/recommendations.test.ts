import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { RecommendationSessions, selectDiverseRecommendations } from '../src/recommendations';

function candidate(index: number, feedKey: string, sampleCount = 2, title = `Topic ${index}`) {
	return {
		id: `item-${index}`,
		feedKey,
		source: `Source ${feedKey}`,
		title,
		receivedAt: new Date(Date.parse('2026-08-15T12:00:00Z') - index * 60_000).toISOString(),
		score: 100 - index,
		sampleCount,
		explanation: 'Ranked by preferences',
	};
}

test('For You selection caps source concentration and reserves a deterministic exploration slot', () => {
	const ranked = [
		...Array.from({ length: 8 }, (_, index) => candidate(index, 'dominant')),
		candidate(8, 'second'),
		candidate(9, 'third'),
		candidate(10, 'unseen', 0),
	];

	const selected = selectDiverseRecommendations(ranked, 6);
	assert.deepEqual(selected, selectDiverseRecommendations(ranked, 6));
	assert.equal(selected.filter((item) => item.feedKey === 'dominant').length <= 3, true);
	assert.equal(selected.at(-1)?.id, 'item-10');
	assert.match(selected.at(-1)?.explanation ?? '', /exploration|varied/i);
});

test('For You selection prevents one repeated topic from crowding out other fresh subjects', () => {
	const ranked = [
		candidate(0, 'one', 2, 'Artificial intelligence funding'),
		candidate(1, 'two', 2, 'Artificial intelligence models'),
		candidate(2, 'three', 2, 'Artificial intelligence hardware'),
		candidate(3, 'four', 2, 'Artificial intelligence policy'),
		candidate(4, 'five', 2, 'Urban transit design'),
		candidate(5, 'six', 2, 'Cooking seasonal vegetables'),
	];

	const selected = selectDiverseRecommendations(ranked, 5);
	assert.ok(selected.some((item) => item.title === 'Urban transit design'));
	assert.ok(selected.some((item) => item.title === 'Cooking seasonal vegetables'));
});

function snapshotEntry(id: string) {
	return { id, score: 65, confidence: 0, sampleCount: 0, explanation: 'Saved story',
		learningState: 'Starting with recency', matchedTopics: [], topicStrength: 0,
		html: 'Article body must not be retained', text: 'Nor plain text' };
}

function durableSessionStorage() {
	const values = new Map<string, unknown>();
	let writes = 0;
	let failWrites = false;
	const storage = {
		kv: {
			get: <T>(key: string) => values.get(key) as T | undefined,
			list: <T>({ prefix = '', limit = Infinity } = {}) => [...values.entries()]
				.filter(([key]) => key.startsWith(prefix)).slice(0, limit) as [string, T][],
			put: (key: string, value: unknown) => {
				writes += 1;
				values.set(key, structuredClone(value));
				if (failWrites) throw new Error('Storage unavailable');
			},
			delete: (key: string) => { writes += 1; return values.delete(key); },
		},
		transactionSync: <T>(callback: () => T): T => {
			const before = new Map(values);
			try { return callback(); } catch (error) {
				values.clear();
				for (const [key, value] of before) values.set(key, value);
				throw error;
			}
		},
	};
	return { storage, values, writes: () => writes, fail: (value: boolean) => { failWrites = value; } };
}

test('durable recommendation snapshots survive object restart without refreshing expiry or rewriting page metadata', () => {
	let clock = 1_000;
	const durable = durableSessionStorage();
	const options = { storage: durable.storage, clock: () => clock, ttlMs: 100 };
	const first = new RecommendationSessions(options);
	const id = first.create('2026-10-04T12:00:00.000Z', [snapshotEntry('one')]);
	assert.ok(id);
	clock = 1_020;
	const restarted = new RecommendationSessions(options);
	assert.equal(restarted.get(id)?.entries[0].id, 'one');
	assert.equal(restarted.get(id)?.expiresAt, 1_100);
	const writes = durable.writes();
	clock = 1_099;
	assert.ok(restarted.get(id));
	assert.equal(durable.writes(), writes, 'continuation reads do not rewrite snapshots');
	clock = 1_100;
	assert.equal(new RecommendationSessions(options).get(id), undefined);
	assert.equal(durable.values.size, 1, 'expiry removes chunks but retains the empty versioned manifest');
});

test('durable snapshot chunks retain Unicode metadata and failed eviction transactions preserve live sessions', () => {
	const durable = durableSessionStorage();
	const options = { storage: durable.storage, maxSessions: 1 };
	const sessions = new RecommendationSessions(options);
	const largeEntry = { ...snapshotEntry('one'), explanation: 'Saved '.repeat(40_000) + '😀東京'.repeat(60_000) };
	const id = sessions.create('2026-10-04T12:00:00.000Z', [largeEntry]);
	assert.ok(id);
	const saved = new Map(durable.values);
	assert.ok(saved.size > 2, 'metadata above one value is sharded');
	for (const value of saved.values()) {
		if (typeof value === 'string') {
			assert.ok(value.length <= 200_000);
			assert.ok(new TextEncoder().encode(value).byteLength < 900_000);
			assert.ok(!value.includes('Article body must not be retained'));
		}
	}
	assert.equal(new RecommendationSessions(options).get(id)?.entries[0].explanation, largeEntry.explanation);
	durable.fail(true);
	assert.throws(() => sessions.create('2026-10-04T12:00:00.000Z', [snapshotEntry('two')]), /Storage unavailable/);
	assert.deepEqual(durable.values, saved, 'failed new snapshot and FIFO eviction roll back together');
	assert.ok(sessions.get(id), 'memory still agrees with disk after failure');
	durable.fail(false);
	assert.ok(new RecommendationSessions(options).get(id));
	const next = sessions.create('2026-10-04T12:00:00.000Z', [snapshotEntry('two')]);
	assert.ok(next);
	const restarted = new RecommendationSessions(options);
	assert.equal(restarted.get(id), undefined);
	assert.ok(restarted.get(next));
	assert.equal(durable.values.size, 2, 'FIFO eviction removes every old chunk');
});

test('durable snapshot restoration rejects corrupt chunks, incompatible versions and over-cap manifests', () => {
	for (const corrupt of ['missing', 'invalid-json', 'extra-body', 'version', 'count', 'bytes', 'chunk-size']) {
		const durable = durableSessionStorage();
		const id = new RecommendationSessions({ storage: durable.storage }).create('2026-10-04T12:00:00.000Z', [snapshotEntry('one')]);
		assert.ok(id);
		const indexKey = 'recommendations:snapshots:index';
		const chunkKey = `recommendations:snapshots:${id}:0`;
		const index = durable.values.get(indexKey) as { version: number; sessions: { id: string; bytes: number; parts: number }[] };
		if (corrupt === 'missing') durable.values.delete(chunkKey);
		if (corrupt === 'invalid-json') durable.values.set(chunkKey, '!'.repeat(index.sessions[0].bytes));
		if (corrupt === 'extra-body') {
			const payload = JSON.parse(durable.values.get(chunkKey) as string);
			payload.entries[0].html = 'Must not restore article bodies';
			const serialized = JSON.stringify(payload);
			index.sessions[0].bytes = new TextEncoder().encode(serialized).byteLength;
			durable.values.set(chunkKey, serialized);
		}
		if (corrupt === 'version') index.version = 2;
		if (corrupt === 'count') index.sessions = Array.from({ length: 9 }, () => index.sessions[0]);
		if (corrupt === 'bytes') index.sessions[0].bytes = 8_000_001;
		if (corrupt === 'chunk-size') durable.values.set(chunkKey, 'x'.repeat(200_001));
		assert.equal(new RecommendationSessions({ storage: durable.storage }).get(id), undefined, corrupt);
		assert.equal(durable.values.size, 1, `${corrupt}: unusable metadata removed`);
	}
});

test('durable snapshot restoration enforces aggregate bytes and eight-session FIFO across restarts', () => {
	const durable = durableSessionStorage();
	let sessions = new RecommendationSessions({ storage: durable.storage });
	const ids: string[] = [];
	for (let index = 0; index < 9; index += 1) {
		const id = sessions.create('2026-10-04T12:00:00.000Z', [snapshotEntry(String(index))]);
		assert.ok(id);
		ids.push(id);
		sessions = new RecommendationSessions({ storage: durable.storage });
	}
	assert.equal(sessions.get(ids[0]), undefined);
	assert.ok(ids.slice(1).every((id) => sessions.get(id)));
	const byteBound = { storage: durable.storage, maxBytes: 400 };
	sessions = new RecommendationSessions(byteBound);
	assert.equal(durable.values.size, 1, 'over-budget restored aggregate is discarded before loading payloads');
	const first = sessions.create('2026-10-04T12:00:00.000Z', [snapshotEntry('one')]);
	const second = sessions.create('2026-10-04T12:00:00.000Z', [snapshotEntry('two')]);
	assert.ok(first && second);
	sessions = new RecommendationSessions(byteBound);
	assert.equal(sessions.get(first), undefined);
	assert.ok(sessions.get(second));
	assert.equal(sessions.create('2026-10-04T12:00:00.000Z', [{ ...snapshotEntry('large'), explanation: 'x'.repeat(401) }]), null);
	assert.ok(new RecommendationSessions(byteBound).get(second), 'rejected oversized snapshots preserve current disk state');
});

test('recommendation sessions store only bounded scoring metadata and expire without extending on reads', () => {
	let clock = 1_000;
	const sessions = new RecommendationSessions({ clock: () => clock, ttlMs: 100, maxSessions: 2 });
	const id = sessions.create('2026-10-04T12:00:00.000Z', [snapshotEntry('one')]);
	assert.ok(id);
	const entry = sessions.get(id)?.entries[0];
	assert.equal('html' in (entry ?? {}), false);
	assert.equal('text' in (entry ?? {}), false);
	clock = 1_099;
	assert.ok(sessions.get(id));
	clock = 1_100;
	assert.equal(sessions.get(id), undefined);
	assert.equal(sessions.create('2026-10-04T12:00:00.000Z', Array.from({ length: 1_101 }, (_, index) => snapshotEntry(String(index)))), null);
});

test('recommendation sessions evict the oldest snapshot at the entry or aggregate byte bound', () => {
	const countBound = new RecommendationSessions({ maxSessions: 2 });
	const first = countBound.create('2026-10-04T12:00:00.000Z', [snapshotEntry('one')]);
	const second = countBound.create('2026-10-04T12:00:00.000Z', [snapshotEntry('two')]);
	const third = countBound.create('2026-10-04T12:00:00.000Z', [snapshotEntry('three')]);
	assert.ok(first && second && third);
	assert.equal(countBound.get(first), undefined);
	assert.ok(countBound.get(second));
	assert.ok(countBound.get(third));

	const sample = new RecommendationSessions();
	const sampleId = sample.create('2026-10-04T12:00:00.000Z', [snapshotEntry('one')]);
	assert.ok(sampleId);
	const bytes = sample.get(sampleId)?.bytes ?? 0;
	assert.ok(bytes > 0);
	const byteBound = new RecommendationSessions({ maxSessions: 8, maxBytes: bytes * 2 - 1 });
	const oldest = byteBound.create('2026-10-04T12:00:00.000Z', [snapshotEntry('one')]);
	const latest = byteBound.create('2026-10-04T12:00:00.000Z', [snapshotEntry('two')]);
	assert.ok(oldest && latest);
	assert.equal(byteBound.get(oldest), undefined);
	assert.ok(byteBound.get(latest));
	assert.equal(byteBound.create('2026-10-04T12:00:00.000Z', [snapshotEntry('x'.repeat(bytes * 2))]), null);
	assert.ok(byteBound.get(latest), 'an oversized new snapshot preserves current sessions');
});
