import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectDiverseRecommendations } from '../src/recommendations';

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
