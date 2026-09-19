import CryptoKit
import Foundation

/// The body that is safe to hand to the structured HTML renderer.
///
/// This is deliberately separate from `ReaderViewDocument`: feed content is
/// prepared without a network request, while Reader View content is produced
/// by the extractor and cached by the same store.
struct PreparedReaderBody: Equatable, Sendable {
	let sanitizedHTML: String
	let imageURLs: [URL]

	nonisolated init(sanitizedHTML: String, imageURLs: [URL]) {
		self.sanitizedHTML = sanitizedHTML
		self.imageURLs = imageURLs
	}
}

/// A small, in-memory cache for content needed by the article reader.
///
/// The key contains a digest of the complete downloaded article body and its
/// source URL. This makes a refresh that changes either value a cache miss even
/// when the server reuses an item identifier. Only the most recently used
/// entries are kept so a long reading session cannot retain every newsletter
/// body.
@MainActor
final class ReaderPreparationStore {
	static let defaultCapacity = 3
	static let defaultByteCapacity = 12_000_000

	private struct Key: Hashable, Sendable {
		let articleID: String
		let bodyDigest: String
		let originalURL: String?

		init(article: Recommendation) {
			articleID = article.id
			bodyDigest = Self.digest(article.html)
			originalURL = article.originalURL?.absoluteString
		}

		private static func digest(_ html: String) -> String {
			SHA256.hash(data: Data(html.utf8)).map { byte in
				let value = String(byte, radix: 16)
				return value.count == 1 ? "0\(value)" : value
			}.joined()
		}
	}

	private struct Entry {
		var preparedBody: PreparedReaderBody?
		var readerDocument: ReaderViewDocument?
		var scrollAnchors: [String: ReaderScrollAnchor] = [:]
		var byteCost = 0
	}

	private let capacity: Int
	private let byteCapacity: Int
	private var entries: [Key: Entry] = [:]
	private var leastRecentlyUsed: [Key] = []
	private var inFlight: [Key: Task<PreparedReaderBody?, Never>] = [:]
	private var inFlightIDs: [Key: UUID] = [:]
	private var generation = UUID()
	private var cachedBytes = 0
	private var memoizedKey: (articleID: String, html: String, originalURL: URL?, value: Key)?

	init(
		capacity: Int = ReaderPreparationStore.defaultCapacity,
		byteCapacity: Int = ReaderPreparationStore.defaultByteCapacity,
	) {
		self.capacity = max(capacity, 1)
		self.byteCapacity = max(byteCapacity, 1)
	}

	/// Prepares only the already-downloaded feed body. It never follows the
	/// article URL or otherwise performs network I/O.
	func prepare(article: Recommendation) async {
		let key = contentKey(for: article)
		if entries[key]?.preparedBody != nil {
			touch(key)
			return
		}

		let startedGeneration = generation
		let task: Task<PreparedReaderBody?, Never>
		let taskID: UUID
		if let existingTask = inFlight[key] {
			task = existingTask
			taskID = inFlightIDs[key] ?? UUID()
		} else {
			let html = article.html
			let baseURL = article.safeOriginalURL
			task = Task.detached(priority: .utility) {
				PreparedReaderBody.make(sanitizedHTML: html, baseURL: baseURL)
			}
			taskID = UUID()
			inFlight[key] = task
			inFlightIDs[key] = taskID
		}

		let preparedBody = await task.value
		guard Task.isCancelled == false, generation == startedGeneration else {
			finishInFlight(key: key, taskID: taskID)
			return
		}

		if let preparedBody {
			var entry = entries[key] ?? Entry()
			cachedBytes -= entry.byteCost
			entry.preparedBody = preparedBody
			entry.byteCost = byteCost(for: key, entry: entry)
			entries[key] = entry
			cachedBytes += entry.byteCost
			touch(key)
		}
		finishInFlight(key: key, taskID: taskID)
		trimToCapacity()
	}

	func preparedBody(for article: Recommendation) -> PreparedReaderBody? {
		let key = contentKey(for: article)
		let preparedBody = entries[key]?.preparedBody
		if preparedBody != nil { touch(key) }
		return preparedBody
	}

	func cachedReaderDocument(for article: Recommendation) -> ReaderViewDocument? {
		let key = contentKey(for: article)
		let readerDocument = entries[key]?.readerDocument
		if readerDocument != nil { touch(key) }
		return readerDocument
	}

	func cacheReaderDocument(_ document: ReaderViewDocument, for article: Recommendation) {
		let key = contentKey(for: article)
		var entry = entries[key] ?? Entry()
		cachedBytes -= entry.byteCost
		entry.readerDocument = document
		entry.byteCost = byteCost(for: key, entry: entry)
		entries[key] = entry
		cachedBytes += entry.byteCost
		touch(key)
		trimToCapacity()
	}

	func scrollAnchor(for article: Recommendation, mode: String) -> ReaderScrollAnchor? {
		let key = contentKey(for: article)
		let anchor = entries[key]?.scrollAnchors[mode]
		if anchor != nil { touch(key) }
		return anchor
	}

	func cacheScrollAnchor(_ anchor: ReaderScrollAnchor, for article: Recommendation, mode: String) {
		let key = contentKey(for: article)
		var entry = entries[key] ?? Entry()
		cachedBytes -= entry.byteCost
		entry.scrollAnchors[mode] = anchor
		entry.byteCost = byteCost(for: key, entry: entry)
		entries[key] = entry
		cachedBytes += entry.byteCost
		touch(key)
		trimToCapacity()
	}

	func contentIdentity(for article: Recommendation) -> String {
		let key = contentKey(for: article)
		return "\(key.articleID)|\(key.bodyDigest)|\(key.originalURL ?? "")"
	}

	private func contentKey(for article: Recommendation) -> Key {
		// Swift strings share their storage. Equal content can reuse its digest
		// during scroll updates without hashing the entire newsletter each frame.
		if let memoizedKey, memoizedKey.articleID == article.id,
			memoizedKey.originalURL == article.originalURL, memoizedKey.html == article.html {
			return memoizedKey.value
		}
		let key = Key(article: article)
		memoizedKey = (article.id, article.html, article.originalURL, key)
		return key
	}

	func reset() {
		generation = UUID()
		memoizedKey = nil
		inFlight.values.forEach { $0.cancel() }
		inFlight.removeAll()
		inFlightIDs.removeAll()
		entries.removeAll()
		leastRecentlyUsed.removeAll()
		cachedBytes = 0
	}

	private func touch(_ key: Key) {
		leastRecentlyUsed.removeAll { $0 == key }
		leastRecentlyUsed.append(key)
	}

	private func trimToCapacity() {
		while (entries.count > capacity || cachedBytes > byteCapacity), let oldest = leastRecentlyUsed.first {
			leastRecentlyUsed.removeFirst()
			if let entry = entries.removeValue(forKey: oldest) {
				cachedBytes -= entry.byteCost
			}
		}
		leastRecentlyUsed.removeAll { entries[$0] == nil }
	}

	private func finishInFlight(key: Key, taskID: UUID) {
		guard inFlightIDs[key] == taskID else { return }
		inFlight[key] = nil
		inFlightIDs[key] = nil
	}

	private func byteCost(for key: Key, entry: Entry) -> Int {
		key.articleID.utf8.count
			+ key.bodyDigest.utf8.count
			+ (key.originalURL?.utf8.count ?? 0)
			+ (entry.preparedBody?.sanitizedHTML.utf8.count ?? 0)
			+ (entry.preparedBody?.imageURLs.reduce(0) { $0 + $1.absoluteString.utf8.count } ?? 0)
			+ (entry.readerDocument?.contentHTML.utf8.count ?? 0)
			+ (entry.readerDocument?.title?.utf8.count ?? 0)
			+ (entry.readerDocument?.byline?.utf8.count ?? 0)
			+ (entry.readerDocument?.excerpt?.utf8.count ?? 0)
			+ entry.scrollAnchors.reduce(0) { partialResult, item in
				partialResult + item.key.utf8.count + MemoryLayout<Double>.size
			}
	}
}

extension PreparedReaderBody {
	static nonisolated func make(sanitizedHTML: String, baseURL: URL?) -> PreparedReaderBody? {
		let trimmedHTML = sanitizedHTML.trimmingCharacters(in: .whitespacesAndNewlines)
		guard trimmedHTML.isEmpty == false else {
			return nil
		}

		let sanitizedHTML = StructuredHTMLSanitizer.sanitize(html: trimmedHTML, baseURL: baseURL)
		guard sanitizedHTML.isEmpty == false else {
			return nil
		}
		return PreparedReaderBody(
			sanitizedHTML: sanitizedHTML,
			imageURLs: StructuredHTMLSanitizer.imageURLs(in: sanitizedHTML, baseURL: nil),
		)
	}
}
