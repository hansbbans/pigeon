import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveFeedDisplayName } from '../src/normalize';

test('resolveFeedDisplayName strips quotes from a quoted List-Id phrase', () => {
	const headers = [{ key: 'list-id', value: '"Morning Brew" <morningbrew.list-id.example.com>' }];
	assert.equal(resolveFeedDisplayName(headers, undefined, 'crew@morningbrew.com'), 'Morning Brew');
});

test('resolveFeedDisplayName unescapes quoted-pair characters in a List-Id phrase', () => {
	const headers = [{ key: 'list-id', value: '"The \\"Daily\\" Note" <daily.example.com>' }];
	assert.equal(resolveFeedDisplayName(headers, undefined, 'a@example.com'), 'The "Daily" Note');
});

test('resolveFeedDisplayName keeps an unquoted List-Id phrase', () => {
	const headers = [{ key: 'list-id', value: 'Morning Brew <morningbrew.list-id.example.com>' }];
	assert.equal(resolveFeedDisplayName(headers, undefined, 'crew@morningbrew.com'), 'Morning Brew');
});
