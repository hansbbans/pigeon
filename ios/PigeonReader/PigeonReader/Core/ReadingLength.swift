import Foundation

/// Reading-length metadata the server sends with an article. `wordCount` is
/// present only when the server knows better than the body (a reader-mode
/// extraction or a saved page); otherwise the app estimates from the body.
nonisolated struct ArticleLength: Codable, Equatable, Hashable, Sendable {
	var wordCount: Int?
	var mediaKind: String?
	var durationSeconds: Int?

	/// Nil when the server sent none of the fields, so older payloads stay nil.
	init?(wordCount: Int?, mediaKind: String?, durationSeconds: Int?) {
		guard wordCount != nil || mediaKind != nil || durationSeconds != nil else { return nil }
		self.wordCount = wordCount
		self.mediaKind = mediaKind
		self.durationSeconds = durationSeconds
	}

	var isVideo: Bool { mediaKind == "video" }
}

/// "12 min read" / "1 hr 5 min video" labels, shared rules with the web client
/// (`formatReadingLength` and `shouldReportWordCount` in src/browser-app-client.ts).
nonisolated enum ReadingLength {
	static let wordsPerMinute = 238
	/// Only items longer than 10 minutes are worth flagging.
	static let minimumLabelledMinutes = 11

	static func label(wordCount: Int?, estimatedWordCount: Int?, mediaKind: String?, durationSeconds: Int?) -> String? {
		if mediaKind == "video" {
			guard let seconds = durationSeconds, seconds > 0 else { return nil }
			let minutes = max(1, (seconds + 59) / 60)
			guard minutes >= minimumLabelledMinutes else { return nil }
			if minutes < 60 { return "\(minutes) min video" }
			let hours = minutes / 60
			let rest = minutes % 60
			return rest == 0 ? "\(hours) hr video" : "\(hours) hr \(rest) min video"
		}
		guard let words = wordCount ?? estimatedWordCount, words > 0 else { return nil }
		let minutes = max(1, (words + wordsPerMinute - 1) / wordsPerMinute)
		return minutes >= minimumLabelledMinutes ? "\(minutes) min read" : nil
	}

	/// Reader mode reports Defuddle's count when the known one looks like a
	/// feed snippet: unknown, or at least 1.5x shorter than the extraction.
	/// The server accepts 1...2,000,000.
	static func shouldReport(stored: Int?, extracted: Int?, mediaKind: String?) -> Bool {
		guard mediaKind != "video", let extracted, (50...2_000_000).contains(extracted) else { return false }
		guard let stored, stored > 0 else { return true }
		return extracted * 2 >= stored * 3
	}

	@MainActor private static var estimateCache: [String: Int] = [:]

	/// The label for an article, estimating from its body when the server
	/// sent no count. Estimates are cached per body so list rows never rescan.
	@MainActor static func label(for article: Recommendation) -> String? {
		label(
			wordCount: article.length?.wordCount,
			estimatedWordCount: article.length?.isVideo == true ? nil : estimatedWordCount(for: article),
			mediaKind: article.length?.mediaKind,
			durationSeconds: article.length?.durationSeconds
		)
	}

	/// The count reader mode compares an extraction against.
	@MainActor static func knownWordCount(for article: Recommendation) -> Int? {
		article.length?.wordCount ?? estimatedWordCount(for: article)
	}

	/// Estimated from the HTML body, or from the kept plain text once the
	/// body has been pruned.
	@MainActor static func estimatedWordCount(for article: Recommendation) -> Int? {
		let body = article.html.isEmpty ? (article.text ?? "") : article.html
		guard body.isEmpty == false else { return nil }
		let key = "\(article.id)#\(article.contentVersion ?? "")#\(article.html.isEmpty ? "t" : "h")\(body.utf8.count)"
		if let cached = estimateCache[key] { return cached }
		let count = countWords(inHTML: body)
		if estimateCache.count >= 4_000 { estimateCache.removeAll(keepingCapacity: true) }
		estimateCache[key] = count
		return count
	}

	/// Same limit as the web: 300 000 UTF-16 code units.
	static let sourceLimit = 300_000

	/// Port of `countWordsInHtml` (src/word-count.ts): one linear scan over at
	/// most 300 000 UTF-16 code units of the body, read as UTF-8 bytes in place.
	/// Tags are word boundaries; head, script, style and template content and
	/// comments are skipped unless their closer is missing, and a missing closer
	/// is remembered so the scan never repeats.
	static func countWords(inHTML html: String) -> Int {
		var source = html
		if html.utf16.count > sourceLimit {
			// Back off one unit rather than split a surrogate pair.
			let prefix = html.utf16.prefix(sourceLimit)
			source = String(prefix) ?? String(prefix.dropLast()) ?? ""
		}
		source.makeContiguousUTF8()
		if let count = source.utf8.withContiguousStorageIfAvailable({ countWords(in: $0) }) { return count }
		return Array(source.utf8).withUnsafeBufferPointer { countWords(in: $0) }
	}

	private static let rawTextElements: [[UInt8]] = ["head", "script", "style", "template"].map { Array($0.utf8) }
	private static let spaceEntities: [[UInt8]] = ["&nbsp;", "&#160;", "&#xa0;"].map { Array($0.utf8) }

	private static func countWords(in bytes: UnsafeBufferPointer<UInt8>) -> Int {
		let length = bytes.count
		var noTagCloseFrom = length
		var noCommentCloseFrom = length
		var noRawCloseFrom = [Int](repeating: length, count: rawTextElements.count)
		var count = 0
		var inWord = false
		var index = 0

		func find(_ byte: UInt8, from start: Int) -> Int? {
			var position = start
			while position < length {
				if bytes[position] == byte { return position }
				position += 1
			}
			return nil
		}
		/// ASCII case folding applies to letters only, like a case-insensitive regex.
		func folded(_ byte: UInt8) -> UInt8 {
			byte >= 0x41 && byte <= 0x5A ? byte | 0x20 : byte
		}
		func matches(_ text: [UInt8], at position: Int) -> Bool {
			guard position + text.count <= length else { return false }
			for offset in 0..<text.count where folded(bytes[position + offset]) != text[offset] { return false }
			return true
		}
		func isSpace(_ byte: UInt8) -> Bool {
			byte == 0x20 || (byte >= 0x09 && byte <= 0x0D)
		}
		/// The index after the next "</name" + optional whitespace + ">".
		func findCloser(_ name: [UInt8], from start: Int) -> Int? {
			var position = start
			while let open = find(0x3C, from: position) {
				if open + 1 < length, bytes[open + 1] == 0x2F, matches(name, at: open + 2) {
					var end = open + 2 + name.count
					while end < length, isSpace(bytes[end]) { end += 1 }
					if end < length, bytes[end] == 0x3E { return end + 1 }
				}
				position = open + 1
			}
			return nil
		}
		let commentOpen: [UInt8] = Array("<!--".utf8)
		let commentClose: [UInt8] = Array("-->".utf8)

		while index < length {
			let byte = bytes[index]
			if byte == 0x3C, index + 1 < length {
				let next = folded(bytes[index + 1])
				let opensTag = (next >= 0x61 && next <= 0x7A) || next == 0x2F || next == 0x21 || next == 0x3F
				if opensTag {
					let close = index + 1 >= noTagCloseFrom ? nil : find(0x3E, from: index + 1)
					if close == nil { noTagCloseFrom = min(noTagCloseFrom, index + 1) }
					if let close {
						inWord = false
						if matches(commentOpen, at: index) {
							var end: Int?
							if index + 4 < noCommentCloseFrom {
								var position = index + 4
								while let dash = find(0x2D, from: position) {
									if matches(commentClose, at: dash) { end = dash; break }
									position = dash + 1
								}
								if end == nil { noCommentCloseFrom = index + 4 }
							}
							index = end.map { $0 + 3 } ?? close + 1
							continue
						}
						var nameEnd = index + 1
						while nameEnd < length, nameEnd - index <= 10 {
							let letter = folded(bytes[nameEnd])
							if letter < 0x61 || letter > 0x7A { break }
							nameEnd += 1
						}
						let nameLength = nameEnd - index - 1
						if let element = rawTextElements.firstIndex(where: { $0.count == nameLength && matches($0, at: index + 1) }),
							bytes[close - 1] != 0x2F {
							var resume = close + 1
							if close + 1 < noRawCloseFrom[element] {
								if let end = findCloser(rawTextElements[element], from: close + 1) {
									resume = end
								} else {
									noRawCloseFrom[element] = close + 1
								}
							}
							index = resume
							continue
						}
						index = close + 1
						continue
					}
				}
			}
			if byte == 0x26, let entity = spaceEntities.first(where: { matches($0, at: index) }) {
				inWord = false
				index += entity.count
				continue
			}
			// Whitespace: ASCII controls and space, U+00A0, U+2000–U+200B, U+3000.
			var spaceWidth = 0
			if byte <= 0x20 {
				spaceWidth = 1
			} else if byte == 0xC2, index + 1 < length, bytes[index + 1] == 0xA0 {
				spaceWidth = 2
			} else if byte == 0xE2, index + 2 < length, bytes[index + 1] == 0x80, bytes[index + 2] <= 0x8B {
				spaceWidth = 3
			} else if byte == 0xE3, index + 2 < length, bytes[index + 1] == 0x80, bytes[index + 2] == 0x80 {
				spaceWidth = 3
			}
			if spaceWidth > 0 {
				inWord = false
				index += spaceWidth
				continue
			}
			if !inWord {
				inWord = true
				count += 1
			}
			index += 1
		}
		return count
	}
}
