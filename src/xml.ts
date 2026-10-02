/** Remove characters forbidden by XML 1.0 while preserving valid Unicode. */
export function stripInvalidXmlCharacters(value: string): string {
	// Unicode mode matches lone surrogates without removing paired emoji.
	return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/gu, '');
}
