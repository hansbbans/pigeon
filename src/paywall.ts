// Newsletter platforms end a free subscriber's copy of a paid post with a
// recognizable paywall block. Match those blocks, not words like "paid
// subscriber", which also appear in the footer of every free post.
const PAYWALL_MARKERS = [
	// Substack. A paying subscriber's full copy carries "PaywallToDOM" instead.
	/data-component-name=["']Paywall["']/i,
	// beehiiv premium posts.
	/class=["'][^"']*\bemail-paywall-break\b/i,
	// Ghost members-only posts.
	/Upgrade to continue reading\.?\s*<\/h[1-6]>[\s\S]{0,400}?Become a paid member of/i,
];

/** Whether an email body is a teaser that stops at the publisher's paywall. */
export function isPaywalledHtml(html: string | null | undefined): boolean {
	return !!html && PAYWALL_MARKERS.some((marker) => marker.test(html));
}
