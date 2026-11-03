import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePublishedDate } from '../src/reader-published-date';

const now = new Date('2026-11-03T12:00:00Z');

test('normalizes absolute dates to ISO 8601 UTC', () => {
	assert.equal(normalizePublishedDate('2026-10-01', now), '2026-10-01T00:00:00.000Z');
	assert.equal(normalizePublishedDate('2026-10-01T09:30:00-04:00', now), '2026-10-01T13:30:00.000Z');
	assert.equal(normalizePublishedDate('Tue, 14 Oct 2025 08:00:00 GMT', now), '2025-10-14T08:00:00.000Z');
});

test('drops relative, empty, non-string, and out-of-range values', () => {
	for (const value of ['An hour ago', 'Updated', '', null, undefined, 42, '3000-01-01', '1989-12-31']) {
		assert.equal(normalizePublishedDate(value, now), null, String(value));
	}
});

test('allows up to one day in the future', () => {
	assert.equal(normalizePublishedDate('2026-11-04T11:00:00Z', now), '2026-11-04T11:00:00.000Z');
	assert.equal(normalizePublishedDate('2026-11-05T00:00:00Z', now), null);
});

test('reads naive and long-form dates as UTC, like iOS, and rejects loose text', () => {
	assert.equal(normalizePublishedDate('2025-04-02T10:00:00', now), '2025-04-02T10:00:00.000Z');
	assert.equal(normalizePublishedDate('April 2, 2025', now), '2025-04-02T00:00:00.000Z');
	assert.equal(normalizePublishedDate('2 April 2025', now), '2025-04-02T00:00:00.000Z');
	for (const value of ['Updated 2025', 'Tue 2021', '2025', 'Posted on 2025-04-02 by Ada']) {
		assert.equal(normalizePublishedDate(value, now), null, value);
	}
});
