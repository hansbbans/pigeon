import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	buildTopicProfile,
	extractTopicFeatures,
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

test('dotted A.I. aliases match symmetrically without joining sentence initials or hostnames', () => {
	for (const title of ['A.I. reshapes healthcare', 'A.I reshapes healthcare', 'Applied a.i. research', 'Applied Ａ．Ｉ． research', 'A.I.-powered robotics']) {
		assert.deepEqual(matchMonitoredTopics({ title }, ['AI']), [{ key: 'ai', label: 'AI' }], title);
	}
	for (const title of ['AI reshapes healthcare', 'Artificial intelligence reshapes healthcare']) {
		assert.deepEqual(matchMonitoredTopics({ title }, ['A.I.']), [{ key: 'ai', label: 'A.I.' }], title);
	}
	for (const title of ['A. I. Smith discusses healthcare', 'A sentence ends with a. I begin another.', 'A.Ignite healthcare', 'Visit a.i.example.com', 'Contact a.i.user@example.com', 'Contact a.i@example.com', 'Contact a.i.@example.com', 'Visit user@a.i', 'Contact a.i+garden@example.com', 'Contact a.i-garden@example.com', 'Contact \"a.i\"@example.com', 'Paid newsletter operations']) {
		assert.deepEqual(matchMonitoredTopics({ title }, ['AI']), [], title);
	}
	const profile = buildTopicProfile([{ itemId: 'dotted-ai', eventType: 'star', occurredAt: NOW,
		title: 'A.I. research advances', text: null }], NOW);
	assert.ok(scoreTopics({ title: 'Artificial intelligence research' }, [], profile).learnedMatches.includes('AI'));
});

test('long unbroken topic tokens retain bounded features and neighboring dotted acronyms', () => {
	const token = 'q'.repeat(2_000);
	assert.deepEqual([...extractTopicFeatures({ title: null, text: token })], [token]);
	assert.deepEqual([...extractTopicFeatures({ title: null, text: token + 'A.I. research' })], [token],
		'text past the bounded excerpt does not become a topic');
	for (const prefix of [
		'q'.repeat(1_700),
		'https://example.com/' + 'abcdef0123456789'.repeat(100),
		'q'.repeat(1_700) + '@',
	]) {
		assert.deepEqual(matchMonitoredTopics({ title: null, text: `${prefix}; A.I.-powered robotics` }, ['AI']),
			[{ key: 'ai', label: 'AI' }], 'an adjacent long token does not swallow the acronym');
	}
});

test('email token boundaries preserve quoted and punctuated addresses without hiding a separate acronym', () => {
	for (const address of [
		'a.i+garden@example.com', 'a.i-garden@example.com', '"a.i"@example.com',
		'"a.i garden"@example.com', '"a.i@example.com"',
		'q'.repeat(1_600) + '.a.i+garden@example.com',
	]) {
		assert.deepEqual(matchMonitoredTopics({ title: null, text: `Contact (${address}), about gardening.` }, ['AI']), [], address);
		assert.deepEqual(matchMonitoredTopics({ title: null, text: `Contact (${address}); A.I.-powered robotics.` }, ['AI']),
			[{ key: 'ai', label: 'AI' }], address);
	}
	for (const wrapper of ["'", '+', '-', 'café', '東京']) {
		assert.deepEqual(matchMonitoredTopics({ title: null, text: `Contact ${wrapper}"a.i"@example.com${wrapper} about gardens.` }, ['AI']), [],
			'quoted local parts do not inherit an unquoted local-part boundary');
	}
});

test('topic markup stripping preserves first-opening through next-closing semantics and unmatched text', () => {
	for (const text of ['<A.I.<broken> Gardens', '<A.I.\n<broken> Gardens', '<A.I.> Gardens', '<A.I.<>', '<A.I.>']) {
		assert.deepEqual(matchMonitoredTopics({ title: null, text }, ['AI']), [], text);
	}
	for (const text of ['<A.I.<broken> A.I. research', '<unclosed A.I. research', 'A.I.> research', '<>A.I. research', '<<>A.I. research']) {
		assert.deepEqual(matchMonitoredTopics({ title: null, text }, ['AI']), [{ key: 'ai', label: 'AI' }], text);
	}
	assert.deepEqual([...extractTopicFeatures({ title: null, text: '<'.repeat(2_000) })], []);
	assert.deepEqual(matchMonitoredTopics({ title: null, text: '<'.repeat(1_700) + ' A.I. research' }, ['AI']),
		[{ key: 'ai', label: 'AI' }], 'an unmatched opening-marker run preserves the remaining excerpt');
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
