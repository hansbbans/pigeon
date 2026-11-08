// Newsletter platforms end a free subscriber's copy of a paid post with a
// recognizable paywall block. Match those blocks, not words like "paid
// subscriber", which also appear in the footer of every free post.
const PAYWALL_MARKERS = [
	// Substack. A paying subscriber's full copy carries "PaywallToDOM" instead.
	/data-component-name=["']Paywall["']/i,
	// Substack paid-only post with the paywall above the first paragraph: no
	// Paywall block, just an empty body. The "free subscriber" CTA alone also
	// sits under free posts, so require the empty body before it. The CTA follows
	// about 750 characters later; the bounded gaps keep a crafted email linear.
	/<div class=["']body markup["'][^>]{0,1000}>\s*(?:<p[^>]{0,1000}>\s*<\/p>\s*)*<\/div>[\s\S]{0,2000}?You(?:'|&#39;|&#x27;|&#8217;|&rsquo;|’)re currently a free subscriber/i,
	// beehiiv premium posts.
	/class=["'][^"']*\bemail-paywall-break\b/i,
	// Ghost members-only posts.
	/Upgrade to continue reading\.?\s*<\/h[1-6]>[\s\S]{0,400}?Become a paid member of/i,
];

/** Whether an email body is a teaser that stops at the publisher's paywall. */
export function isPaywalledHtml(html: string | null | undefined): boolean {
	return !!html && PAYWALL_MARKERS.some((marker) => marker.test(html));
}
