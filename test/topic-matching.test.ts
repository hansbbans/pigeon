import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	buildTopicProfile,
	scoreTopics,
	matchMonitoredTopics,
} from '../src/topic-matching';

const NOW = '2026-09-15T12:00:00.000Z';

test('monitored topics use token boundaries, aliases, and phrases beyond the headline prefix', () => {
	assert.deepEqual(
		matchMonitoredTopics(
			{ title: 'A guide to choosing a home gym for a paid newsletter', text: null },
			['home   gyms', 'AI'],
		),
		[{ key: 'home gym', label: 'home   gyms' }],
	);
	assert.deepEqual(
		matchMonitoredTopics({ title: 'Artificial Intelligence changes chip design', text: null }, ['AI']),
		[{ key: 'ai', label: 'AI' }],
	);
	assert.deepEqual(
		matchMonitoredTopics({ title: 'Paid newsletter operations', text: null }, ['AI']),
		[],
	);
});

test('an empty topic profile returns without scanning candidate text', () => {
	const article = {
		get title(): string {
			throw new Error('title should not be read when no topic signals exist');
		},
		get text(): string {
			throw new Error('text should not be read when no topic signals exist');
		},
	} as unknown as { title: string; text: string };

	assert.deepEqual(
		scoreTopics(article, [], { entries: new Map(), evidenceCount: 0 }),
		{
			monitoredMatches: [],
			learnedMatches: [],
			learnedNegativeMatches: [],
			monitoredBoost: 0,
			learnedBoost: 0,
			evidenceCount: 0,
		},
	);
});

test('repeated deliberate topic signals transfer across publishers and cap per item', () => {
	const repeated = Array.from({ length: 20 }, (_, index) => ({
		itemId: 'liked-ai',
		eventType: 'star',
		occurredAt: NOW,
		title: 'AI research changes software development',
		text: 'AI helps teams reason over data and automate repetitive analysis.',
		id: `duplicate-${index}`,
	}));
	const one = [repeated[0]];
	const repeatedProfile = buildTopicProfile(repeated, NOW);
	const oneProfile = buildTopicProfile(one, NOW);
	const repeatedScore = scoreTopics({ title: 'Fresh AI chip benchmarks', text: 'Processor results.' }, [], repeatedProfile);
	const oneScore = scoreTopics({ title: 'Fresh AI chip benchmarks', text: 'Processor results.' }, [], oneProfile);

	assert.ok(repeatedScore.learnedMatches.includes('AI'));
	assert.ok(repeatedScore.learnedBoost > 3, 'headline topic should beat a ±3 source tie-breaker');
	assert.equal(repeatedScore.learnedBoost, oneScore.learnedBoost);
});

test('distinct liked stories retain a consistent topic, while rejected topics transfer negatively and decay with age', () => {
	const distinctLikes = Array.from({ length: 10 }, (_, index) => ({
		itemId: `liked-${index}`,
		eventType: 'star',
		occurredAt: NOW,
		title: `AI research result ${index}`,
		text: 'A short report about model and chip progress.',
	}));
	const likedProfile = buildTopicProfile(distinctLikes, NOW);
	const likedScore = scoreTopics(
		{ title: 'Hardware advances in artificial intelligence', text: 'New benchmark results.' },
		[],
		likedProfile,
	);
	assert.ok(likedScore.learnedMatches.includes('AI'));
	assert.ok(likedScore.learnedBoost > 3);

	const rejectedProfile = buildTopicProfile([{
		itemId: 'rejected-ai',
		eventType: 'not_interested',
		occurredAt: NOW,
		title: 'AI hype scams',
		text: 'A short report about misleading AI claims.',
	}], NOW);
	const rejectedScore = scoreTopics({ title: 'AI hype analysis', text: null }, [], rejectedProfile);
	assert.ok(rejectedScore.learnedNegativeMatches.includes('AI'));
	assert.ok(rejectedScore.learnedBoost < 0);

	const oldProfile = buildTopicProfile([{
		...distinctLikes[0],
		occurredAt: '2026-03-15T12:00:00.000Z',
	}], NOW);
	const oldScore = scoreTopics({ title: 'Fresh AI chip benchmarks', text: null }, [], oldProfile);
	const freshScore = scoreTopics({ title: 'Fresh AI chip benchmarks', text: null }, [], buildTopicProfile([distinctLikes[0]], NOW));
	assert.ok(oldScore.learnedBoost < freshScore.learnedBoost);
});
