import Foundation

enum StructuredHTMLSanitizer {
	private static let allowedTags: Set<String> = [
		"a", "article", "aside", "blockquote", "br", "caption", "code", "col", "colgroup", "dd", "del",
		"div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr",
		"i", "img", "li", "main", "ol", "p", "pre", "q", "section", "small", "span", "strong", "sub", "sup",
		"table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
	]
	private static let blockedTags: Set<String> = [
		"audio", "base", "button", "canvas", "embed", "form", "frame", "frameset", "head", "iframe", "input",
		"link", "math", "meta", "noscript", "object", "option", "script", "select", "source", "style", "svg",
		"template", "textarea", "title", "track", "video",
	]
	private static let voidTags: Set<String> = ["br", "col", "hr"]
	private static let allowedAttributes: Set<String> = [
		"alt", "aria-label", "cite", "colspan", "datetime", "decoding", "height", "href", "loading", "rowspan",
		"scope", "src", "srcset", "title", "width",
	]
	private static let imageSourceAttributePrecedence = ["src", "data-src", "data-original", "data-lazy-src"]
	private static let imageSrcsetAttributePrecedence = ["srcset", "data-srcset", "data-lazy-srcset"]

	static func sanitize(html: String, baseURL: URL?) -> String {
		var output = ""
		var cursor = html.startIndex
		var blockedTag: String?
		var blockedDepth = 0

		while cursor < html.endIndex {
			guard let tagStart = html[cursor...].firstIndex(of: "<") else {
				if blockedTag == nil {
					output += String(html[cursor...])
				}
				break
			}

			if blockedTag == nil, cursor < tagStart {
				output += String(html[cursor..<tagStart])
			}

			if html[tagStart...].hasPrefix("<!--"), let commentEnd = html[tagStart...].range(of: "-->")?.upperBound {
				cursor = commentEnd
				continue
			}

			guard let tagEnd = findTagEnd(in: html, startingAt: tagStart) else {
				if blockedTag == nil {
					output += String(html[tagStart...])
				}
				break
			}
			let rawTag = String(html[tagStart...tagEnd])
			cursor = html.index(after: tagEnd)

			guard let parsed = parseTag(rawTag) else {
				continue
			}

			if let activeBlockedTag = blockedTag {
				if parsed.name == activeBlockedTag {
					if parsed.isClosing {
						blockedDepth -= 1
						if blockedDepth == 0 {
							blockedTag = nil
						}
					} else if parsed.isOpening, parsed.isSelfClosing == false {
						blockedDepth += 1
					}
				}
				continue
			}

			if blockedTags.contains(parsed.name) {
				if parsed.isOpening, parsed.isSelfClosing == false {
					blockedTag = parsed.name
					blockedDepth = 1
				}
				continue
			}

			guard allowedTags.contains(parsed.name) else {
				continue
			}

			if parsed.isClosing {
				guard voidTags.contains(parsed.name) == false else { continue }
				output += "</\(parsed.name)>"
				continue
			}

			let attributes = sanitizedAttributes(parsed.attributes, baseURL: baseURL, tagName: parsed.name)
			if parsed.name == "img", attributes.contains(where: { $0.name == "src" || $0.name == "srcset" }) == false {
				continue
			}
			let serializedAttributes = attributes.map { "\($0.name)=\"\(escapeAttribute($0.value))\"" }.joined(separator: " ")
			output += "<\(parsed.name)\(serializedAttributes.isEmpty ? "" : " \(serializedAttributes)")\(voidTags.contains(parsed.name) ? " />" : ">")"
		}

		return output.trimmingCharacters(in: .whitespacesAndNewlines)
	}

	static func imageURLs(in html: String, baseURL: URL?) -> [URL] {
		let sanitized = sanitize(html: html, baseURL: baseURL)
		var urls: [URL] = []
		var remaining = sanitized[...]
		while let imageRange = remaining.range(of: "<img", options: [.caseInsensitive]) {
			guard let tagEnd = remaining[imageRange.lowerBound...].firstIndex(of: ">") else { break }
			let tag = String(remaining[imageRange.lowerBound...tagEnd])
			if let source = attribute(named: "src", in: tag), let url = safeWebURL(source, relativeTo: baseURL) {
				if urls.contains(url) == false { urls.append(url) }
			}
			if let srcset = attribute(named: "srcset", in: tag) {
				for url in srcsetURLs(srcset, relativeTo: baseURL) where urls.contains(url) == false {
					urls.append(url)
				}
			}
			let nextIndex = remaining.index(after: tagEnd)
			guard nextIndex < remaining.endIndex else { break }
			remaining = remaining[nextIndex...]
		}
		return urls
	}

	static func safeWebURL(_ rawValue: String, relativeTo baseURL: URL?) -> URL? {
		let trimmed = decodeHTMLAttributeReferences(rawValue)
			.trimmingCharacters(in: .whitespacesAndNewlines)
		guard trimmed.isEmpty == false else { return nil }
		guard let url = URL(string: trimmed, relativeTo: baseURL)?.absoluteURL,
			let scheme = url.scheme?.lowercased(), (scheme == "http" || scheme == "https"), url.host != nil else {
			return nil
		}
		return url
	}

	private struct ParsedTag {
		let name: String
		let attributes: String
		let isOpening: Bool
		let isClosing: Bool
		let isSelfClosing: Bool
	}

	private struct SanitizedAttribute {
		let name: String
		let value: String
	}

	private static func parseTag(_ rawTag: String) -> ParsedTag? {
		guard rawTag.first == "<", rawTag.last == ">" else { return nil }
		var inner = String(rawTag.dropFirst().dropLast()).trimmingCharacters(in: .whitespacesAndNewlines)
		if inner.hasPrefix("!") || inner.hasPrefix("?") { return nil }
		let isClosing = inner.hasPrefix("/")
		if isClosing { inner.removeFirst() }
		let isSelfClosing = inner.hasSuffix("/")
		if isSelfClosing { inner.removeLast() }
		inner = inner.trimmingCharacters(in: .whitespacesAndNewlines)
		guard let nameEnd = inner.firstIndex(where: { $0.isWhitespace || $0 == "/" }) else {
			return ParsedTag(name: inner.lowercased(), attributes: "", isOpening: !isClosing, isClosing: isClosing, isSelfClosing: isSelfClosing)
		}
		let name = String(inner[..<nameEnd]).lowercased()
		guard name.isEmpty == false else { return nil }
		return ParsedTag(
			name: name,
			attributes: String(inner[nameEnd...]),
			isOpening: !isClosing,
			isClosing: isClosing,
			isSelfClosing: isSelfClosing,
		)
	}

	private static func sanitizedAttributes(_ rawAttributes: String, baseURL: URL?, tagName: String) -> [SanitizedAttribute] {
		guard let expression = try? NSRegularExpression(
			pattern: #"([A-Za-z_:][A-Za-z0-9:._-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#,
		) else {
			return []
		}
		let range = NSRange(rawAttributes.startIndex..<rawAttributes.endIndex, in: rawAttributes)
		var attributes: [SanitizedAttribute] = []
		var imageSourceValues: [String: String] = [:]
		var imageSrcsetValues: [String: String] = [:]

		for match in expression.matches(in: rawAttributes, range: range) {
			guard let nameRange = Range(match.range(at: 1), in: rawAttributes),
				let valueRange = Range(match.range(at: 2), in: rawAttributes) ?? Range(match.range(at: 3), in: rawAttributes) ?? Range(match.range(at: 4), in: rawAttributes) else {
				continue
			}
			let name = String(rawAttributes[nameRange]).lowercased()
			let value = decodeHTMLAttributeReferences(String(rawAttributes[valueRange]))
				.trimmingCharacters(in: .whitespacesAndNewlines)
			guard value.isEmpty == false else { continue }

			if tagName == "img", imageSourceAttributePrecedence.contains(name) {
				if let safeURL = safeWebURL(value, relativeTo: baseURL) {
					imageSourceValues[name] = safeURL.absoluteString
				}
				continue
			}
			if tagName == "img", imageSrcsetAttributePrecedence.contains(name) {
				let safeSrcset = sanitizedSrcset(value, baseURL: baseURL)
				if safeSrcset.isEmpty == false {
					imageSrcsetValues[name] = safeSrcset
				}
				continue
			}

			guard allowedAttributes.contains(name), name.hasPrefix("on") == false else { continue }

			switch name {
			case "href", "src", "cite":
				guard let safeURL = safeWebURL(value, relativeTo: baseURL) else { continue }
				attributes.append(SanitizedAttribute(name: name, value: safeURL.absoluteString))
			case "srcset":
				let safeSrcset = sanitizedSrcset(value, baseURL: baseURL)
				if safeSrcset.isEmpty == false {
					attributes.append(SanitizedAttribute(name: name, value: safeSrcset))
				}
			case "width", "height", "colspan", "rowspan":
				guard value.range(of: #"^[0-9]{1,5}$"#, options: .regularExpression) != nil else { continue }
				attributes.append(SanitizedAttribute(name: name, value: value))
			case "loading":
				guard value == "lazy" || value == "eager" else { continue }
				attributes.append(SanitizedAttribute(name: name, value: value))
			case "decoding":
				guard ["async", "sync", "auto"].contains(value) else { continue }
				attributes.append(SanitizedAttribute(name: name, value: value))
			default:
				attributes.append(SanitizedAttribute(name: name, value: value))
			}
		}

		guard tagName == "img" else { return attributes }
		if let source = imageSourceAttributePrecedence.lazy.compactMap({ imageSourceValues[$0] }).first {
			attributes.append(SanitizedAttribute(name: "src", value: source))
		}
		if let srcset = imageSrcsetAttributePrecedence.lazy.compactMap({ imageSrcsetValues[$0] }).first {
			attributes.append(SanitizedAttribute(name: "srcset", value: srcset))
		}
		return attributes
	}

	private static func sanitizedSrcset(_ srcset: String, baseURL: URL?) -> String {
		decodeHTMLAttributeReferences(srcset).split(separator: ",").compactMap { candidate in
			let parts = candidate.split(whereSeparator: \.isWhitespace)
			guard let rawURL = parts.first, let url = safeWebURL(String(rawURL), relativeTo: baseURL) else { return nil }
			let descriptor = parts.dropFirst().joined(separator: " ")
			return descriptor.isEmpty ? url.absoluteString : "\(url.absoluteString) \(descriptor)"
		}.joined(separator: ", ")
	}

	private static func srcsetURLs(_ srcset: String, relativeTo baseURL: URL?) -> [URL] {
		srcset.split(separator: ",").compactMap { candidate in
			guard let rawURL = candidate.split(whereSeparator: \.isWhitespace).first else { return nil }
			return safeWebURL(String(rawURL), relativeTo: baseURL)
		}
	}

	private static func attribute(named name: String, in tag: String) -> String? {
		guard let expression = try? NSRegularExpression(
			pattern: #"\b\#(name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#,
			options: .caseInsensitive,
		) else {
			return nil
		}
		let range = NSRange(tag.startIndex..<tag.endIndex, in: tag)
		guard let match = expression.firstMatch(in: tag, range: range) else { return nil }
		for index in 1...3 {
			if let valueRange = Range(match.range(at: index), in: tag) {
				return decodeHTMLAttributeReferences(String(tag[valueRange]))
			}
		}
		return nil
	}

	private static func decodeHTMLAttributeReferences(_ value: String) -> String {
		var decoded = value
		for _ in 0..<4 {
			let next = decodeHTMLAttributeReferencePass(decoded)
			guard next != decoded else { break }
			decoded = next
		}
		return decoded
	}

	private static func decodeHTMLAttributeReferencePass(_ value: String) -> String {
		var output = ""
		var cursor = value.startIndex
		while cursor < value.endIndex {
			guard value[cursor] == "&", let semicolon = value[cursor...].firstIndex(of: ";") else {
				output.append(value[cursor])
				cursor = value.index(after: cursor)
				continue
			}

			let entityStart = value.index(after: cursor)
			let entity = String(value[entityStart..<semicolon])
			guard let replacement = htmlEntityReplacement(entity) else {
				output.append(value[cursor])
				cursor = value.index(after: cursor)
				continue
			}

			output.append(replacement)
			cursor = value.index(after: semicolon)
		}
		return output
	}

	private static func htmlEntityReplacement(_ entity: String) -> String? {
		switch entity.lowercased() {
		case "amp": return "&"
		case "quot": return "\""
		case "apos": return "'"
		case "lt": return "<"
		case "gt": return ">"
		case "nbsp": return "\u{00A0}"
		default:
			if entity.hasPrefix("#x") || entity.hasPrefix("#X"),
				let scalar = UInt32(entity.dropFirst(2), radix: 16),
				let unicodeScalar = UnicodeScalar(scalar) {
				return String(unicodeScalar)
			}
			if entity.hasPrefix("#"),
				let scalar = UInt32(entity.dropFirst(), radix: 10),
				let unicodeScalar = UnicodeScalar(scalar) {
				return String(unicodeScalar)
			}
			return nil
		}
	}

	private static func findTagEnd(in html: String, startingAt start: String.Index) -> String.Index? {
		var quote: Character?
		var index = html.index(after: start)
		while index < html.endIndex {
			let character = html[index]
			if let currentQuote = quote {
				if character == currentQuote { quote = nil }
			} else if character == "\"" || character == "'" {
				quote = character
			} else if character == ">" {
				return index
			}
			index = html.index(after: index)
		}
		return nil
	}

	private static func escapeAttribute(_ value: String) -> String {
		value
			.replacing("&", with: "&amp;")
			.replacing("\"", with: "&quot;")
			.replacing("<", with: "&lt;")
			.replacing(">", with: "&gt;")
	}
}
