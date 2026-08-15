import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseGoogleReaderItemRowid } from '../src/item-identity';

test('parseGoogleReaderItemRowid accepts valid stream, hex, and numeric IDs', () => {
	assert.equal(parseGoogleReaderItemRowid('tag:google.com,2005:reader/item/0000000000000001'), 1);
	const maximumSafeHexID = Number.MAX_SAFE_INTEGER.toString(16).padStart(16, '0');
	assert.equal(parseGoogleReaderItemRowid('tag:google.com,2005:reader/item/' + maximumSafeHexID), Number.MAX_SAFE_INTEGER);
	assert.equal(parseGoogleReaderItemRowid('000000000000000a'), 10);
	assert.equal(parseGoogleReaderItemRowid('42'), 42);
});

test('parseGoogleReaderItemRowid rejects malformed suffixes and trailing junk', () => {
	for (const itemId of [
		'item-1',
		'8f3c1d2a-4b5e-6789-abcd-ef0123456789',
		'tag:google.com,2005:reader/item/',
		'tag:google.com,2005:reader/item/1fffffffffffff',
		'tag:google.com,2005:reader/item/0x1',
		'tag:google.com,2005:reader/item/0000000000000001junk',
		'tag:google.com,2005:reader/item/1-2',
		'tag:google.com,2005:reader/item/1_2',
		'tag:google.com,2005:reader/item/g',
		'tag:google.com,2005:reader/item/0',
	]) {
		assert.equal(parseGoogleReaderItemRowid(itemId), null, itemId);
	}
});

test('parseGoogleReaderItemRowid preserves the safe-integer boundary and rejects unsafe values', () => {
	const maximumSafeDecimalID = String(Number.MAX_SAFE_INTEGER).padStart(17, '0');
	assert.equal(parseGoogleReaderItemRowid(maximumSafeDecimalID), Number.MAX_SAFE_INTEGER);
	assert.equal(parseGoogleReaderItemRowid('9007199254740992'), null);
	assert.equal(parseGoogleReaderItemRowid('tag:google.com,2005:reader/item/0020000000000000'), null);
	assert.equal(parseGoogleReaderItemRowid('ffffffffffffffff'), null);
	assert.equal(parseGoogleReaderItemRowid('900719925474099199999999999999'), null);
});
