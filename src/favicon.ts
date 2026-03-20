/**
 * Favicon helper utilities
 * Generates favicon URLs using Google's favicon service
 */

/**
 * Generate a favicon URL for an email address
 * Extracts the domain from the email and uses Google's favicon service
 */
export function getFaviconForEmail(email: string): string {
	const domain = email.split('@')[1] || email;
	return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
}

/**
 * Generate a favicon URL for a website URL
 * Extracts the domain from the URL and uses Google's favicon service
 */
export function getFaviconForUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=32`;
	} catch {
		// If URL parsing fails, try to extract domain from string
		const domain = url.replace(/^https?:\/\//, '').split('/')[0];
		return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
	}
}
