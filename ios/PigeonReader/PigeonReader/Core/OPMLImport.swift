import Foundation

nonisolated struct OPMLFeedEntry: Equatable, Identifiable, Sendable {
	let title: String
	let url: URL
	let folders: [String]
	var id: String { OPMLImportPlanner.normalizedURL(url) }
}

nonisolated struct OPMLImportPreview: Equatable, Sendable {
	let entries: [OPMLFeedEntry]
	let duplicateIDs: Set<String>
	let folderMerges: [OPMLFolderMerge]

	var newEntries: [OPMLFeedEntry] { entries.filter { duplicateIDs.contains($0.id) == false } }
	var duplicateCount: Int { entries.count - newEntries.count }
}

nonisolated struct OPMLFolderMerge: Equatable, Sendable {
	let subscriptionID: String
	let addingFolders: [String]
}

nonisolated struct OPMLImportResult: Equatable, Sendable {
	let importedCount: Int
	let updatedCount: Int
	let duplicateCount: Int
}

nonisolated enum OPMLImportFileOutcome: Equatable, Sendable {
	case keepExisting
	case ready(OPMLImportPreview)
	case failed(String)
}

nonisolated struct OPMLImportScreenState: Equatable, Sendable {
	var preview: OPMLImportPreview?
	var message: String?

	mutating func apply(_ outcome: OPMLImportFileOutcome) {
		switch outcome {
		case .keepExisting:
			break
		case .ready(let preview):
			self.preview = preview
			self.message = nil
		case .failed(let message):
			self.preview = nil
			self.message = message
		}
	}
}

nonisolated enum OPMLImportError: LocalizedError, Equatable, Sendable {
	case invalidDocument
	case noFeeds
	case documentTooLarge
	case tooManyFeeds
	case importFailed(rolledBack: Int)

	var errorDescription: String? {
		switch self {
		case .invalidDocument: "This file is not a valid OPML subscription list."
		case .noFeeds: "No HTTP or HTTPS feeds were found in this OPML file."
		case .documentTooLarge: "This OPML file is larger than Pigeon's 5 MB import limit."
		case .tooManyFeeds: "This OPML file contains more than Pigeon's 2,000-feed import limit."
		case .importFailed(let count): "Import failed. Pigeon rolled back \(count) feed\(count == 1 ? "" : "s") added in this attempt."
		}
	}
}

nonisolated enum OPMLImportPlanner {
	static let maximumDocumentBytes = 5 * 1_024 * 1_024
	static let maximumFeedCount = 2_000

	static func parse(data: Data) throws -> [OPMLFeedEntry] {
		guard data.count <= maximumDocumentBytes else { throw OPMLImportError.documentTooLarge }
		let delegate = OPMLParserDelegate()
		let parser = XMLParser(data: data)
		parser.delegate = delegate
		parser.shouldResolveExternalEntities = false
		guard parser.parse(), delegate.sawOPMLRoot else { throw OPMLImportError.invalidDocument }
		var deduplicated: [String: OPMLFeedEntry] = [:]
		for entry in delegate.entries {
			if let current = deduplicated[entry.id] {
				deduplicated[entry.id] = OPMLFeedEntry(
					title: current.title,
					url: current.url,
					folders: Array(Set(current.folders + entry.folders)).filter { $0.isEmpty == false }.sorted(),
				)
			} else {
				deduplicated[entry.id] = entry
			}
		}
		guard deduplicated.count <= maximumFeedCount else { throw OPMLImportError.tooManyFeeds }
		let entries = deduplicated.values.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
		guard entries.isEmpty == false else { throw OPMLImportError.noFeeds }
		return entries
	}

	static func outcome(of result: Result<Data, Error>, existing: [FeedSubscription]) -> OPMLImportFileOutcome {
		switch result {
		case .success(let data):
			do {
				return .ready(preview(entries: try parse(data: data), existing: existing))
			} catch {
				return .failed(error.localizedDescription)
			}
		case .failure(let error) where isUserCancellation(error):
			return .keepExisting
		case .failure(let error):
			return .failed(error.localizedDescription)
		}
	}

	static func isUserCancellation(_ error: Error) -> Bool {
		if error is CancellationError {
			return true
		}
		if let cocoaError = error as? CocoaError {
			return cocoaError.code == .userCancelled
		}
		let nsError = error as NSError
		return nsError.domain == NSCocoaErrorDomain && nsError.code == NSUserCancelledError
	}

	static func preview(entries: [OPMLFeedEntry], existing: [FeedSubscription]) -> OPMLImportPreview {
		let existingByURL = Dictionary(existing.map { (normalizedURL($0.sourceUrl ?? $0.url), $0) }, uniquingKeysWith: { first, _ in first })
		let duplicateIDs = Set(entries.map(\.id)).intersection(existingByURL.keys)
		let folderMerges = entries.compactMap { entry -> OPMLFolderMerge? in
			guard let subscription = existingByURL[entry.id] else { return nil }
			let missing = Set(entry.folders.filter { $0.isEmpty == false }).subtracting(Set(subscription.folderNames)).sorted()
			return missing.isEmpty ? nil : OPMLFolderMerge(subscriptionID: subscription.id, addingFolders: missing)
		}
		return OPMLImportPreview(entries: entries, duplicateIDs: duplicateIDs, folderMerges: folderMerges)
	}

	static func normalizedURL(_ url: URL) -> String {
		guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url.absoluteString }
		components.scheme = components.scheme?.lowercased()
		components.host = components.host?.lowercased()
		components.fragment = nil
		if (components.scheme == "https" && components.port == 443) || (components.scheme == "http" && components.port == 80) {
			components.port = nil
		}
		if components.path.count > 1 && components.path.hasSuffix("/") { components.path.removeLast() }
		return components.string ?? url.absoluteString
	}
}

private nonisolated final class OPMLParserDelegate: NSObject, XMLParserDelegate {
	private(set) var entries: [OPMLFeedEntry] = []
	private(set) var sawOPMLRoot = false
	private var folderStack: [String] = []
	private var outlineWasFolder: [Bool] = []

	func parser(
		_ parser: XMLParser,
		didStartElement elementName: String,
		namespaceURI: String?,
		qualifiedName qName: String?,
		attributes attributeDict: [String: String] = [:]
	) {
		if elementName.caseInsensitiveCompare("opml") == .orderedSame { sawOPMLRoot = true }
		guard elementName.caseInsensitiveCompare("outline") == .orderedSame else { return }
		let attributes = Dictionary(uniqueKeysWithValues: attributeDict.map { ($0.key.lowercased(), $0.value) })
		let rawURL = attributes["xmlurl"]
		if let rawURL, let url = URL(string: rawURL), let scheme = url.scheme?.lowercased(),
			["http", "https"].contains(scheme), url.host != nil {
			outlineWasFolder.append(false)
			let fallback = url.host ?? "Untitled Feed"
			let title = [attributes["title"], attributes["text"]]
				.compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
				.first(where: { $0.isEmpty == false }) ?? fallback
			entries.append(OPMLFeedEntry(title: title, url: url, folders: folderStack))
		} else {
			outlineWasFolder.append(true)
			let folder = [attributes["title"], attributes["text"]]
				.compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
				.first(where: { $0.isEmpty == false })
			folderStack.append(folder ?? "")
		}
	}

	func parser(
		_ parser: XMLParser,
		didEndElement elementName: String,
		namespaceURI: String?,
		qualifiedName qName: String?
	) {
		guard elementName.caseInsensitiveCompare("outline") == .orderedSame,
			let wasFolder = outlineWasFolder.popLast() else { return }
		if wasFolder, folderStack.isEmpty == false { folderStack.removeLast() }
	}
}

@MainActor
protocol OPMLImportServicing {
	func addSubscription(url: URL) async throws -> QuickAddResponse
	func editSubscription(id: String, title: String?, addingFolders: [String], removingFolders: [String]) async throws
	func unsubscribe(id: String) async throws
}

extension PigeonAPIClient: OPMLImportServicing {}

@MainActor
enum OPMLImportCoordinator {
	static func importPreview(_ preview: OPMLImportPreview, service: any OPMLImportServicing) async throws -> OPMLImportResult {
		var addedIDs: [String] = []
		var appliedMerges: [OPMLFolderMerge] = []
		var duplicateCount = preview.duplicateCount
		do {
			for merge in preview.folderMerges {
				try Task.checkCancellation()
				try await service.editSubscription(
					id: merge.subscriptionID, title: nil, addingFolders: merge.addingFolders, removingFolders: [],
				)
				appliedMerges.append(merge)
			}
			for entry in preview.newEntries {
				try Task.checkCancellation()
				let result = try await service.addSubscription(url: entry.url)
				if result.isNew == false {
					duplicateCount += 1
					continue
				}
				addedIDs.append(result.streamId)
				if entry.folders.isEmpty == false {
					try await service.editSubscription(
						id: result.streamId,
						title: nil,
						addingFolders: Array(Set(entry.folders.filter { $0.isEmpty == false })).sorted(),
						removingFolders: [],
					)
				}
			}
			return OPMLImportResult(
				importedCount: addedIDs.count,
				updatedCount: appliedMerges.count,
				duplicateCount: duplicateCount,
			)
		} catch {
			for id in addedIDs.reversed() { try? await service.unsubscribe(id: id) }
			for merge in appliedMerges.reversed() {
				try? await service.editSubscription(
					id: merge.subscriptionID, title: nil, addingFolders: [], removingFolders: merge.addingFolders,
				)
			}
			if error is CancellationError { throw error }
			throw OPMLImportError.importFailed(rolledBack: addedIDs.count)
		}
	}
}
