import Foundation
import Testing
@testable import PigeonReader

struct PlatformIntegrationTests {
	@Test func backgroundRefreshLaunchHandlerRunsOnTheMainQueue() {
		#expect(BackgroundRefreshRegistrationPolicy.launchQueue === DispatchQueue.main)
	}

	@Test func backgroundRefreshSkipsOfflineAndConstrainedNetworksByDefault() {
		#expect(BackgroundRefreshPolicy.shouldRefresh(pathIsSatisfied: false, isConstrained: false, allowsLowDataMode: true) == false)
		#expect(BackgroundRefreshPolicy.shouldRefresh(pathIsSatisfied: true, isConstrained: true, allowsLowDataMode: false) == false)
		#expect(BackgroundRefreshPolicy.shouldRefresh(pathIsSatisfied: true, isConstrained: true, allowsLowDataMode: true))
		#expect(BackgroundRefreshPolicy.shouldRefresh(pathIsSatisfied: true, isConstrained: false, allowsLowDataMode: false))
	}

	@Test func backgroundRefreshNotifiesOnlyArticlesAbsentFromMemoryAndTheDiskCache() {
		let cached = Self.article(id: "cached", receivedAt: 1)
		let inMemory = Self.article(id: "memory", receivedAt: 2)
		let new = Self.article(id: "new", receivedAt: 3)
		let known = BackgroundRefreshArticlePlanner.knownIDs(inMemory: [inMemory], cached: [cached])
		let delta = BackgroundRefreshArticlePlanner.newArticles(
			knownIDs: known,
			current: [cached, inMemory, new, new],
		)
		#expect(delta.map(\.id) == ["new"])
	}

	@Test func notificationActionsPersistAcrossATerminatedLaunch() throws {
		let action = ReaderNotificationAction.markRead(articleID: "article-7")
		let restored = try JSONDecoder().decode(
			ReaderNotificationAction.self,
			from: JSONEncoder().encode(action),
		)
		#expect(restored == action)
	}

	@Test func deepLinksRoundTripFeedFolderArticleAndAddTargets() throws {
		let website = try #require(URL(string: "https://example.com/feed.xml?kind=full"))
		let links: [PigeonDeepLink] = [
			.feed("feed/7"),
			.folder("user/-/label/Design Notes"),
			.article("article/with/slashes"),
			.add(website),
		]
		for link in links {
			#expect(PigeonDeepLink(url: link.url) == link)
		}
		#expect(PigeonDeepLink(url: try #require(URL(string: "https://example.com"))) == nil)
	}

	@Test @MainActor func deepLinksSelectExistingFeedFolderAndArticleDestinations() async {
		let model = PreviewData.makeModel()
		await model.handleDeepLink(PigeonDeepLink.feed("dense-discovery").url)
		#expect(model.selectedCollection.feedKey == "dense-discovery")
		await model.handleDeepLink(PigeonDeepLink.folder("Design").url)
		#expect(model.selectedCollection.title == "Design")
		await model.handleDeepLink(PigeonDeepLink.article("preview-2").url)
		#expect(model.selectedArticle?.id == "preview-2")
	}

	@Test func opmlPreviewPreservesNestedFoldersAndDetectsNormalizedDuplicates() throws {
		let data = Data(
			"""
			<?xml version="1.0"?><opml version="2.0"><body>
			<outline text="Design"><outline title="Studio Notes" xmlUrl="HTTPS://Example.com:443/feed/" /></outline>
			<outline text="Work"><outline title="Studio Notes Copy" xmlUrl="https://example.com/feed" /></outline>
			<outline text="Independent" xmlUrl="https://other.example/rss" />
			</body></opml>
			""".utf8,
		)
		let entries = try OPMLImportPlanner.parse(data: data)
		#expect(entries.first(where: { $0.title == "Studio Notes" })?.folders == ["Design", "Work"])
		let existing = FeedSubscription(
			id: "feed/7", title: "Existing", categories: [FeedCategory(id: "user/-/label/Design", label: "Design")],
			url: try #require(URL(string: "https://pigeon.test/feed/existing")),
			sourceUrl: URL(string: "https://example.com/feed"), htmlUrl: nil, iconUrl: nil,
		)
		let preview = OPMLImportPlanner.preview(entries: entries, existing: [existing])
		#expect(preview.duplicateCount == 1)
		#expect(preview.newEntries.map(\.title) == ["Independent"])
		#expect(preview.folderMerges == [OPMLFolderMerge(subscriptionID: "feed/7", addingFolders: ["Work"])])
	}

	@Test func opmlRejectsOversizedAndNonOPMLDocuments() {
		#expect(throws: OPMLImportError.documentTooLarge) {
			try OPMLImportPlanner.parse(data: Data(repeating: 0, count: OPMLImportPlanner.maximumDocumentBytes + 1))
		}
		#expect(throws: OPMLImportError.invalidDocument) {
			try OPMLImportPlanner.parse(data: Data("<html><outline xmlUrl=\"https://example.com/feed\" /></html>".utf8))
		}
	}

	@Test func opmlImportRollsBackEveryFeedAddedBeforeAFailure() async throws {
		let service = RecordingImportService(failOnHost: "fail.example")
		let entries = [
			OPMLFeedEntry(title: "One", url: try #require(URL(string: "https://one.example/feed")), folders: []),
			OPMLFeedEntry(title: "Fail", url: try #require(URL(string: "https://fail.example/feed")), folders: []),
		]
		let merge = OPMLFolderMerge(subscriptionID: "feed/existing", addingFolders: ["Imported"])
		let preview = OPMLImportPreview(entries: entries, duplicateIDs: [], folderMerges: [merge])
		do {
			_ = try await OPMLImportCoordinator.importPreview(preview, service: service)
			Issue.record("Expected import failure")
		} catch OPMLImportError.importFailed(let rolledBack) {
			#expect(rolledBack == 1)
			#expect(service.unsubscribedIDs == ["feed/1"])
			#expect(service.addedFolders.count == 1)
			#expect(service.addedFolders.first?.0 == "feed/existing")
			#expect(service.addedFolders.first?.1 == ["Imported"])
			#expect(service.removedFolders.count == 1)
			#expect(service.removedFolders.first?.0 == "feed/existing")
			#expect(service.removedFolders.first?.1 == ["Imported"])
		} catch {
			Issue.record("Unexpected error: \(error)")
		}
	}

	@Test func opmlImportNeverRollsBackAServerDetectedDuplicate() async throws {
		let service = RecordingImportService(failOnHost: "never.example", existingHost: "existing.example")
		let preview = OPMLImportPreview(
			entries: [OPMLFeedEntry(
				title: "Existing", url: try #require(URL(string: "https://existing.example/feed")), folders: ["Imported"],
			)],
			duplicateIDs: [],
			folderMerges: [],
		)
		let result = try await OPMLImportCoordinator.importPreview(preview, service: service)
		#expect(result.importedCount == 0)
		#expect(result.duplicateCount == 1)
		#expect(service.unsubscribedIDs.isEmpty)
		#expect(service.addedFolders.isEmpty)
	}

	@Test func staleFeedClientDecodesEvidenceAndSendsBoundedArchiveRequest() async throws {
		let response = Data(
			#"{"cutoff":"2026-05-17T00:00:00.000Z","feeds":[{"feedKey":"quiet","streamId":"feed/7","title":"Quiet","sourceType":"rss","sourceURL":"https://example.com/feed","siteURL":null,"lastArticleAt":"2025-01-02T00:00:00.000Z","lastSuccessAt":"2025-01-01T00:00:00.000Z","httpStatus":304,"archived":false}]}"#.utf8,
		)
		let mock = MockHTTPClient(responseData: response)
		let client = PigeonAPIClient(
			session: PigeonSession(baseURL: try #require(URL(string: "https://pigeon.test")), token: "token"),
			httpClient: mock,
		)
		let snapshot = try await client.staleFeeds(days: 1)
		#expect(snapshot.feeds.first?.httpStatus == 304)
		let get = try #require(await mock.lastRequest())
		#expect(get.url.query?.contains("days=30") == true)

		let archiveMock = MockHTTPClient(responseData: Data(#"{"action":"archive","feedKeys":["quiet"]}"#.utf8))
		let archiveClient = PigeonAPIClient(session: client.session, httpClient: archiveMock)
		try await archiveClient.setStaleFeedsArchived(["quiet"], action: .archive)
		let post = try #require(await archiveMock.lastRequest())
		#expect(post.method == "POST")
		let body = try JSONDecoder().decode(StaleFeedArchiveRequest.self, from: try #require(post.body))
		#expect(body.action == .archive)
		#expect(body.feedKeys == ["quiet"])
	}

	private static func article(id: String, receivedAt: TimeInterval) -> Recommendation {
		Recommendation(
			id: id, readerId: "reader-\(id)", feedKey: "feed", source: "Feed", title: id,
			html: "<p>\(id)</p>", text: nil, originalURL: nil, receivedAt: Date(timeIntervalSince1970: receivedAt),
			isRead: false, isStarred: false, score: 0, confidence: 0, sampleCount: 0,
			explanation: "Test", learningState: "Test",
		)
	}
}

@MainActor
private final class RecordingImportService: OPMLImportServicing {
	let failOnHost: String
	let existingHost: String?
	private(set) var unsubscribedIDs: [String] = []
	private(set) var addedFolders: [(String, [String])] = []
	private(set) var removedFolders: [(String, [String])] = []
	private var nextID = 1

	init(failOnHost: String, existingHost: String? = nil) {
		self.failOnHost = failOnHost
		self.existingHost = existingHost
	}

	func addSubscription(url: URL) async throws -> QuickAddResponse {
		if url.host == failOnHost { throw URLError(.cannotConnectToHost) }
		if url.host == existingHost {
			return QuickAddResponse(
				query: url.absoluteString, numResults: 1, streamId: "feed/existing", streamName: "Existing", isNew: false,
			)
		}
		defer { nextID += 1 }
		return QuickAddResponse(query: url.absoluteString, numResults: 1, streamId: "feed/\(nextID)", streamName: url.host ?? "Feed")
	}

	func editSubscription(id: String, title: String?, addingFolders: [String], removingFolders: [String]) async throws {
		if addingFolders.isEmpty == false { addedFolders.append((id, addingFolders)) }
		if removingFolders.isEmpty == false { removedFolders.append((id, removingFolders)) }
	}
	func unsubscribe(id: String) async throws { unsubscribedIDs.append(id) }
}
