import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPaywalledHtml } from '../src/paywall';

test('isPaywalledHtml flags a Substack teaser that ends at the paywall', () => {
	const html = `<p>Let&#8217;s get into the risers and fallers...</p></div></div>
		<div class="paywall paywall-white-background" data-testid="paywall" data-component-name="Paywall" role="region" aria-label="Paywall">
		<h2>Keep reading with a 7-day free trial</h2></div>`;
	assert.equal(isPaywalledHtml(html), true);
});

test('isPaywalledHtml ignores the jump marker in a full post sent to a paying subscriber', () => {
	const html = `<p>The last 16 minutes gave us a lot to chew on.</p>
		<div class="paywall-jump" data-component-name="PaywallToDOM" style="display: none;"></div>
		<p>The rest of the paid post is right here.</p>`;
	assert.equal(isPaywalledHtml(html), false);
});

test('isPaywalledHtml flags a beehiiv premium teaser', () => {
	const html = `<p>They are running the apps.</p>
		<table class="email-paywall-break-body"><tr><td><h2>Subscribe to Premium to read the rest.</h2></td></tr></table>`;
	assert.equal(isPaywalledHtml(html), true);
});

test('isPaywalledHtml flags a Ghost members teaser', () => {
	const html = `<p>Among others.</p>
		<h3 style="font-size: 26px;">Upgrade to continue reading.</h3>
		<p>Become a paid member of Platformer to get access to all premium content.</p>`;
	assert.equal(isPaywalledHtml(html), true);
});

test('isPaywalledHtml ignores ordinary subscription prompts and articles about paywalls', () => {
	for (const html of [
		'<p>To receive new posts and support my work, consider becoming a free or paid subscriber.</p><a>Upgrade to paid</a>',
		'<p>He switched from a hard paywall to a free trial.</p>',
		'<h4><p>Upgrade to continue</p></h4><div>Big Fat Grilled Asparagus is on Patreon</div>',
		'<p>Try Goodnotes for free with a 30-day free trial.</p>',
		'',
	]) {
		assert.equal(isPaywalledHtml(html), false, html);
	}
	assert.equal(isPaywalledHtml(null), false);
});
