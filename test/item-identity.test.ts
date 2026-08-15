import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseGoogleReaderItemRowid } from '../src/item-identity';

test('parseGoogleReaderItemRowid accepts stream, hex, and numeric IDs', () => {
	assert.equal(parseGoogleReaderItemRowid('tag:google.com,2005:reader/item/0000000000000001'), 1);
	assert.equal(parseGoogleReaderItemRowid('000000000000000a'), 10);
	assert.equal(parseGoogleReaderItemRowid('42'), 42);
	assert.equal(parseGoogleReaderItemRowid('item-1'), null);
	assert.equal(parseGoogleReaderItemRowid('8f3c1d2a-4b5e-6789-abcd-ef0123456789'), null);
	assert.equal(parseGoogleReaderItemRowid('tag:google.com,2005:reader/item/0'), null);
});
