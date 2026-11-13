import Foundation
import Security
import Testing
import UniformTypeIdentifiers
@testable import PigeonReader

struct SavedItemsTests {
	// MARK: - Filters and sort

	@Test func lengthBucketsKeepUnknownLengthsOnlyUnderAny() {
		#expect(SavedLengthFilter.any.includes(minutes: nil))
		#expect(SavedLengthFilter.short.includes(minutes: nil) == false)
		#expect(SavedLengthFilter.medium.includes(minutes: nil) == false)
		#expect(SavedLengthFilter.long.includes(minutes: nil) == false)
		#expect(SavedLengthFilter.short.includes(minutes: 4))
		#expect(SavedLengthFilter.short.includes(minutes: 5) == false)
		#expect(SavedLengthFilter.medium.includes(minutes: 5))
		#expect(SavedLengthFilter.medium.includes(minutes: 14))
		#expect(SavedLengthFilter.medium.includes(minutes: 15) == false)
		#expect(SavedLengthFilter.long.includes(minutes: 15))
	}

	@Test func kindFilterSeparatesTextFromVideo() throws {
		let text = Self.saved("text", words: 1_200)
		let video = Self.saved("video", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", mediaKind: "video", duration: 600)
		#expect(SavedListFilter(kind: .text).includes(text, minutes: 6))
		#expect(SavedListFilter(kind: .text).includes(video, minutes: 10) == false)
		#expect(SavedListFilter(kind: .video).includes(video, minutes: 10))
		#expect(SavedListFilter(kind: .video, length: .short).includes(video, minutes: 10) == false)
		#expect(SavedLength.minutes(for: video) == 10)
		#expect(SavedLength.minutes(for: text) == 6)
	}

	@Test func lengthSortsPutUnknownLengthsLastThenNewestSaved() {
		let now = Date(timeIntervalSince1970: 1_800_000_000)
		let short = Self.saved("short", words: 300, receivedAt: now.addingTimeInterval(-60))
		let long = Self.saved("long", words: 5_000, receivedAt: now.addingTimeInterval(-120))
		let unknownNew = Self.saved("unknown-new", words: nil, receivedAt: now)
		let unknownOld = Self.saved("unknown-old", words: nil, receivedAt: now.addingTimeInterval(-600))
		let articles = [unknownOld, long, unknownNew, short]

		#expect(ArticleSortOrder.shortest.sorted(articles).map(\.id) == ["short", "long", "unknown-new", "unknown-old"])
		#expect(ArticleSortOrder.longest.sorted(articles).map(\.id) == ["long", "short", "unknown-new", "unknown-old"])
		#expect(ArticleSortOrder.oldest.sorted(articles).first?.id == "unknown-old")
	}

	@Test func lengthSortsAreOfferedOnlyInReadItLater() {
		#expect(ArticleSortOrder.available(for: .saved) == [.newest, .oldest, .shortest, .longest])
		#expect(ArticleSortOrder.available(for: .forYou).contains(.shortest) == false)
		#expect(ArticleSortOrder.available(for: nil) == [.newest, .oldest, .score])
	}

	@Test func listFilterPersistsPerDevice() throws {
		let defaults = try #require(UserDefaults(suiteName: "pigeon-saved-filter-\(UUID().uuidString)"))
		#expect(SavedListFilter.load(from: defaults) == SavedListFilter())
		SavedListFilter(kind: .video, length: .long).save(to: defaults)
		#expect(SavedListFilter.load(from: defaults) == SavedListFilter(kind: .video, length: .long))
	}

	// MARK: - Identity and local copies

	@Test func savedItemsAreRecognisedByFeedOrMetadata() {
		#expect(Self.saved("a").isSaved)
		let greaderSaved = Recommendation(
			id: "tag:google.com,2005:reader/item/0000000000000005", readerId: "tag:google.com,2005:reader/item/0000000000000005",
			feedKey: "feed/4", source: "Read It Later", title: "T", html: "", text: nil, originalURL: nil,
			receivedAt: .now, isRead: false, isStarred: false, score: 0, confidence: 0, sampleCount: 0,
			explanation: "", learningState: "",
			saved: SavedArticleMetadata(extractionState: "pending", publishedAt: nil, imageURL: nil, siteName: nil),
		)
		#expect(greaderSaved.isSaved)
		#expect(SavedItems.isRemovableItemID(greaderSaved.id) == false)
		#expect(SavedItems.isRemovableItemID("abde2a43-22dc-8734-9049-5cd424e03007"))
	}

	@Test func aReadableBodyWinsOverAStalePendingState() {
		let pending = Self.saved("a", html: "", state: .pending)
		#expect(pending.savedState == .pending)
		let extracted = pending.applyingSavedContent(SavedItemContent(
			html: "<p>Body</p>", text: "Body", title: "Real title", wordCount: 900, author: "Ada",
			image: "https://example.com/lead.jpg", site: "Example", mediaKind: "text",
		))
		#expect(extracted.savedState == .done)
		#expect(extracted.title == "Real title")
		#expect(extracted.text == "Body")
		#expect(extracted.author == "Ada")
		#expect(extracted.length?.wordCount == 900)
		#expect(extracted.saved?.siteName == "Example")
		#expect(extracted.saved?.imageURL?.absoluteString == "https://example.com/lead.jpg")
		// A later sync copy that still says pending does not hide the body.
		#expect(extracted.updatingSaved(saved: SavedArticleMetadata(extractionState: "pending", publishedAt: nil, imageURL: nil, siteName: nil)).savedState == .done)
	}

	@Test func uploadedImagesMustBeWebURLs() {
		let pending = Self.saved("a", html: "", state: .pending)
		let unsafe = pending.applyingSavedContent(SavedItemContent(html: "<p>B</p>", image: "javascript:alert(1)"))
		#expect(unsafe.saved?.imageURL == nil)
		#expect(unsafe.saved?.state == .done)
		let safe = pending.applyingSavedContent(SavedItemContent(html: "<p>B</p>", image: "https://example.com/a.jpg"))
		#expect(safe.saved?.imageURL?.absoluteString == "https://example.com/a.jpg")
		#expect(SavedArticleMetadata.with(state: .failed, from: nil).state == .failed)
		#expect(SavedArticleMetadata.with(state: .pending, from: safe.saved).imageURL == safe.saved?.imageURL)
	}

		@Test func placeholderUsesTheWorkersHostAndPathTitle() throws {
		let response = SavedItemResponse(
			id: "abde2a43-22dc-8734-9049-5cd424e03007",
			readerId: "tag:google.com,2005:reader/item/0000000000000005",
			url: "https://www.example.com/essays/slow-software",
			state: "pending",
		)
		let untitled = Recommendation.savedPlaceholder(response: response, title: nil, receivedAt: .now, state: .pending)
		#expect(untitled.title == "example.com/essays/slow-software")
		#expect(untitled.feedKey == SavedItems.feedKey)
		#expect(untitled.savedState == .pending)
		let titled = Recommendation.savedPlaceholder(response: response, title: "  Slow software ", receivedAt: .now, state: .pending)
		#expect(titled.title == "Slow software")
	}

	@Test func savedTextArchivesAtTheEndButNotOnOpenOrForVideos() {
		let text = Self.saved("text", words: 900)
		let pending = Self.saved("pending", html: "", state: .pending)
		let video = Self.saved("video", url: "https://youtu.be/aqz-KE-bpKQ", mediaKind: "video", duration: 600)
		let story = Recommendation(
			id: "story", readerId: "story", feedKey: "design", source: "Design", title: "Story", html: "<p>Body</p>",
			text: nil, originalURL: nil, receivedAt: .now, isRead: false, isStarred: false, score: 0, confidence: 0,
			sampleCount: 0, explanation: "", learningState: "",
		)
		#expect(ReaderAppModel.shouldMarkReadAfterScrolling(text, depth: 0.99, behavior: .onOpen))
		#expect(ReaderAppModel.shouldMarkReadAfterScrolling(text, depth: 0.8, behavior: .onScroll) == false)
		#expect(ReaderAppModel.shouldMarkReadAfterScrolling(text, depth: 1, behavior: .manually) == false)
		#expect(ReaderAppModel.shouldMarkReadAfterScrolling(pending, depth: 1, behavior: .onOpen) == false)
		#expect(ReaderAppModel.shouldMarkReadAfterScrolling(video, depth: 1, behavior: .onOpen) == false)
		#expect(ReaderAppModel.shouldMarkReadAfterScrolling(story, depth: 0.6, behavior: .onScroll))
		#expect(ReaderAppModel.shouldMarkReadAfterScrolling(story, depth: 1, behavior: .onOpen) == false)
	}

	// MARK: - Navigation

	@Test func catalogTurnsTheSavedFeedIntoTheReadItLaterSection() throws {
		let navigation = ReaderNavigationCatalog.make(
			subscriptions: [
				ReaderSubscription(id: "feed/1", title: "Design", url: "https://pigeon.test/feed/design"),
				ReaderSubscription(id: "feed/4", title: "Read It Later", url: "https://pigeon.test/feed/pigeon:saved", sourceType: "saved"),
			],
			unreadCounts: [ReaderUnreadCount(id: "feed/1", count: 2), ReaderUnreadCount(id: "feed/4", count: 3)],
			smartCounts: ReaderNavigationSmartCounts(forYou: 0, today: 0, unread: 2, starred: 0),
		)
		#expect(navigation.items.filter { $0.kind == .feed }.map(\.streamID) == ["feed/1"])
		let saved = try #require(navigation.item(withID: ReaderSection.saved.rawValue))
		#expect(saved.streamID == "feed/4")
		#expect(saved.unreadCount == 3)
		let smartIDs = navigation.smartItems.map(\.id)
		#expect(smartIDs.firstIndex(of: "saved") == smartIDs.firstIndex(of: "starred").map { $0 + 1 })
	}

	@Test func snapshotReadsTheSavedFeedsOwnCount() {
		let snapshot = ReaderNavigationSnapshot(
			subscriptions: [ReaderSubscription(id: "feed/4", title: "Read It Later", url: "https://pigeon.test/feed/pigeon:saved")],
			unreadCounts: [
				ReaderUnreadCount(id: "feed/4", count: 3),
				ReaderUnreadCount(id: "user/-/state/com.google/reading-list", count: 10),
			],
			starredUnreadCount: 0,
			todayUnreadCount: 4,
		)
		#expect(snapshot.savedUnreadCount == 3)
		// Requested with xs=saved: the server's reading-list total already leaves it out.
		#expect(snapshot.readingListUnreadCount == 10)
	}

	@Test func cachedNavigationFromOlderBuildsGainsTheSection() throws {
		let old = ReaderNavigationState(items: [.smart(.forYou), .smart(.unread), .smart(.starred), .smart(.today)])
		let decoded = try JSONDecoder().decode(ReaderNavigationState.self, from: JSONEncoder().encode(old))
		#expect(decoded.smartItems.map(\.id) == ["forYou", "unread", "starred", "saved", "today"])
		let partial = ReaderNavigationState(items: [.smart(.forYou)])
		#expect(try JSONDecoder().decode(ReaderNavigationState.self, from: JSONEncoder().encode(partial)) == partial)
	}

	// MARK: - Keychain migration

	@Test func legacySessionMovesToTheSharedAccessGroupOnce() throws {
		let keychain = FakeKeychain()
		let legacy = Data("legacy-session".utf8)
		keychain.items[FakeKeychain.Key(group: "TEAM.com.hans.pigeon.reader")] = legacy
		let store = SharedSessionKeychain(keychain: keychain, accessGroup: "group.com.hans.pigeon.reader")

		#expect(try store.load() == legacy)
		#expect(keychain.items[FakeKeychain.Key(group: "group.com.hans.pigeon.reader")] == legacy)
		#expect(keychain.items[FakeKeychain.Key(group: "TEAM.com.hans.pigeon.reader")] == nil)
		// The second launch reads the shared item without migrating again.
		#expect(try store.load() == legacy)
		#expect(keychain.addCount == 1)
	}

	@Test func theShareExtensionNeverMigrates() throws {
		let keychain = FakeKeychain()
		keychain.items[FakeKeychain.Key(group: "TEAM.com.hans.pigeon.reader")] = Data("legacy".utf8)
		let store = SharedSessionKeychain(keychain: keychain, accessGroup: "group.com.hans.pigeon.reader")
		#expect(try store.load(migratingLegacyItem: false) == nil)
		#expect(keychain.addCount == 0)
	}

	@Test func unsignedBuildsKeepThePrivateItem() throws {
		let keychain = FakeKeychain()
		keychain.missingEntitlementGroups = ["group.com.hans.pigeon.reader"]
		keychain.items[FakeKeychain.Key(group: "TEAM.com.hans.pigeon.reader")] = Data("legacy".utf8)
		let store = SharedSessionKeychain(keychain: keychain, accessGroup: "group.com.hans.pigeon.reader")
		#expect(try store.load() == Data("legacy".utf8))
		#expect(keychain.items[FakeKeychain.Key(group: "TEAM.com.hans.pigeon.reader")] != nil)

		try store.save(Data("new".utf8))
		#expect(keychain.items[FakeKeychain.Key(group: nil)] == Data("new".utf8))
		#expect(keychain.items[FakeKeychain.Key(group: "TEAM.com.hans.pigeon.reader")] == nil)
	}

	@Test func anyGroupErrorFallsBackToThePrivateItem() throws {
		let keychain = FakeKeychain()
		keychain.copyFailureGroups = ["group.com.hans.pigeon.reader"]
		keychain.missingEntitlementGroups = ["group.com.hans.pigeon.reader"]
		keychain.items[FakeKeychain.Key(group: "TEAM.com.hans.pigeon.reader")] = Data("legacy".utf8)
		let store = SharedSessionKeychain(keychain: keychain, accessGroup: "group.com.hans.pigeon.reader")
		#expect(try store.load() == Data("legacy".utf8), "A failing group read must not look signed out")
	}

	@Test func aFailedMigrationKeepsThePrivateItem() throws {
		let keychain = FakeKeychain()
		keychain.addFailureStatus = errSecInteractionNotAllowed
		keychain.items[FakeKeychain.Key(group: "TEAM.com.hans.pigeon.reader")] = Data("legacy".utf8)
		let store = SharedSessionKeychain(keychain: keychain, accessGroup: "group.com.hans.pigeon.reader")
		#expect(try store.load() == Data("legacy".utf8))
		#expect(keychain.items[FakeKeychain.Key(group: "TEAM.com.hans.pigeon.reader")] == Data("legacy".utf8))
		keychain.addFailureStatus = nil
		#expect(try store.load() == Data("legacy".utf8))
		#expect(keychain.items[FakeKeychain.Key(group: "group.com.hans.pigeon.reader")] == Data("legacy".utf8))
		#expect(keychain.items[FakeKeychain.Key(group: "TEAM.com.hans.pigeon.reader")] == nil)
	}

	@Test func savingAndRemovingUseTheSharedGroup() throws {
		let keychain = FakeKeychain()
		let store = SharedSessionKeychain(keychain: keychain, accessGroup: "group.com.hans.pigeon.reader")
		try store.save(Data("one".utf8))
		try store.save(Data("two".utf8))
		#expect(keychain.items == [FakeKeychain.Key(group: "group.com.hans.pigeon.reader"): Data("two".utf8)])
		try store.remove()
		#expect(keychain.items.isEmpty)
		#expect(try store.load() == nil)
	}

	@Test @MainActor func sessionStoreRoundTripsThroughTheSharedKeychain() throws {
		let keychain = FakeKeychain()
		let store = KeychainSessionStore(keychain: SharedSessionKeychain(keychain: keychain, accessGroup: "group.test"))
		let session = PigeonSession(baseURL: try #require(URL(string: "https://pigeon.test")), token: "token")
		try store.save(session)
		#expect(try store.load() == session)
		#expect(keychain.items.keys.map(\.group) == ["group.test"])
	}

	@Test func readwiseTokenIsDeletedOnce() throws {
		let keychain = FakeKeychain()
		keychain.items[FakeKeychain.Key(group: "TEAM.x", service: LegacyReadwiseCleanup.keychainService, account: LegacyReadwiseCleanup.keychainAccount)] = Data("rw".utf8)
		let defaults = try #require(UserDefaults(suiteName: "pigeon-readwise-cleanup-\(UUID().uuidString)"))
		defaults.set("upload", forKey: LegacyReadwiseCleanup.pendingServerSyncKey)

		LegacyReadwiseCleanup.run(keychain: keychain, defaults: defaults)
		#expect(keychain.items.isEmpty)
		#expect(defaults.string(forKey: LegacyReadwiseCleanup.pendingServerSyncKey) == nil)
		#expect(defaults.bool(forKey: LegacyReadwiseCleanup.completedKey))

		LegacyReadwiseCleanup.run(keychain: keychain, defaults: defaults)
		#expect(keychain.deleteCount == 1)
	}

	// MARK: - Offline share queue

	@Test func queueDedupesByURLAndDropsSentLinks() throws {
		let queue = Self.temporaryQueue()
		let first = try #require(URL(string: "https://example.com/a"))
		let second = try #require(URL(string: "https://example.com/b"))
		let start = Date(timeIntervalSince1970: 1_800_000_000)
		let queued = try #require(queue.enqueue(url: first, title: "A", now: start))
		queue.enqueue(url: second, title: nil, now: start.addingTimeInterval(1))
		let requeued = try #require(queue.enqueue(url: first, title: "A again", now: start.addingTimeInterval(2)))

		#expect(requeued.id == queued.id)
		#expect(queue.all().map(\.url) == [second, first])
		#expect(queue.all().last?.title == "A again")
		#expect(queue.enqueue(url: try #require(URL(string: "file:///tmp/a")), title: nil) == nil)

		queue.remove(ids: [queued.id])
		#expect(queue.all().map(\.url) == [second])
	}

	/// The app and the share extension are separate processes: each writes its
	/// own file, so concurrent writers and a flush never drop a link.
	@Test func concurrentWritersNeverDropALink() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-queue-race-\(UUID().uuidString)", directoryHint: .isDirectory)
		let urls = try (0..<60).map { try #require(URL(string: "https://example.com/\($0)")) }
		let flushed = PendingSavedLinkQueue(directory: directory)
		flushed.enqueue(url: try #require(URL(string: "https://example.com/flushed")), title: nil)
		let flushedIDs = Set(flushed.all().map(\.id))

		await withTaskGroup(of: Void.self) { group in
			for (index, url) in urls.enumerated() {
				group.addTask {
					// A separate instance per writer, as a separate process would have.
					PendingSavedLinkQueue(directory: directory).enqueue(url: url, title: "\(index)")
				}
			}
			group.addTask {
				PendingSavedLinkQueue(directory: directory).remove(ids: flushedIDs)
			}
		}

		let remaining = PendingSavedLinkQueue(directory: directory).all()
		#expect(Set(remaining.map(\.url)) == Set(urls))
	}

	@Test func queueKeepsTheNewestLinksWithinItsLimit() throws {
		let queue = Self.temporaryQueue()
		let start = Date(timeIntervalSince1970: 1_800_000_000)
		for index in 0..<(PendingSavedLinkQueue.limit + 3) {
			queue.enqueue(url: try #require(URL(string: "https://example.com/\(index)")), title: nil, now: start.addingTimeInterval(Double(index)))
		}
		let links = queue.all()
		#expect(links.count == PendingSavedLinkQueue.limit)
		#expect(links.first?.url.absoluteString == "https://example.com/3")
	}

	private static func temporaryQueue() -> PendingSavedLinkQueue {
		PendingSavedLinkQueue(directory: FileManager.default.temporaryDirectory
			.appending(path: "pigeon-saved-queue-\(UUID().uuidString)", directoryHint: .isDirectory))
	}

	@Test func onlyRefusedLinksLeaveTheQueueOnFailure() {
		#expect(SavedLinkFailure.classify(statusCode: nil) == .retryLater)
		#expect(SavedLinkFailure.classify(statusCode: 503) == .retryLater)
		#expect(SavedLinkFailure.classify(statusCode: 400) == .rejected)
		#expect(SavedLinkFailure.classify(statusCode: 413) == .rejected)
		#expect(SavedLinkFailure.classify(statusCode: 401) == .unauthorized)
		#expect(SavedLinkFailure.classify(statusCode: 403) == .unauthorized)
	}

	@Test func shareExtensionDoesNotClaimSuccessWhenTheAppGroupIsMissing() {
		#expect(
			SharedShareHandoff.queue(hasSharedContainer: false, enqueued: false, noSession: true)
				== .rejected("Open Pigeon and sign in, then try again."),
		)
		#expect(
			SharedShareHandoff.queue(hasSharedContainer: false, enqueued: false, noSession: false)
				== .rejected("Pigeon couldn’t save this link. Open the app and try again."),
		)
		#expect(SharedShareHandoff.queue(hasSharedContainer: true, enqueued: true, noSession: false) == .queued)
		#expect(
			SharedShareHandoff.queue(hasSharedContainer: true, enqueued: false, noSession: false)
				== .rejected("Only web links can be saved."),
		)
	}

	@Test func shareExtensionShowsAuthAndServerFailuresInsteadOfQueueingThem() {
		#expect(SavedLinkFailure.shareExtensionMessage(statusCode: 401) == "Open Pigeon and sign in, then try again.")
		#expect(SavedLinkFailure.shareExtensionMessage(statusCode: 403) == "Open Pigeon and sign in, then try again.")
		let body = Data(#"{"error":"url must use http or https"}"#.utf8)
		#expect(SavedLinkFailure.shareExtensionMessage(statusCode: 400, body: body) == "url must use http or https")
		#expect(SavedLinkFailure.shareExtensionMessage(statusCode: 422) == "Pigeon can’t save this kind of link.")
	}

	@Test func sharePayloadReadsSafariStringsAttributedTextAndWrappedLinks() throws {
		let safari = try #require(SharedShareItem.webURL(from: "https://example.com/from-safari" as NSString))
		#expect(safari.absoluteString == "https://example.com/from-safari")

		let attributed = try #require(SharedShareItem.webURL(from: NSAttributedString(string: "https://example.com/from-messages")))
		#expect(attributed.absoluteString == "https://example.com/from-messages")

		let wrapped = try #require(SharedShareItem.firstWebURL(in: "Look at this: https://example.com/in-a-sentence?utm_source=share"))
		#expect(wrapped.absoluteString == "https://example.com/in-a-sentence?utm_source=share")

		#expect(SharedShareItem.webURL(from: URL(filePath: "/tmp/page.html")) == nil)
		#expect(SharedShareItem.firstWebURL(in: "no link here") == nil)
		#expect(SharedShareItem.webURL(from: Data("https://example.com/from-data".utf8))?.absoluteString == "https://example.com/from-data")

		let itemLink = try #require(SharedShareItem.link(
			fromItemText: "Slow software",
			contentText: "https://example.com/essays/slow-software",
		))
		#expect(itemLink.url.absoluteString == "https://example.com/essays/slow-software")
		#expect(itemLink.title == "Slow software")

		let jsLink = try #require(SharedShareItem.webURLFromJavaScriptShare(
			["NSExtensionJavaScriptPreprocessingResultsKey": ["URL": "https://example.com/from-js"]],
		))
		#expect(jsLink.absoluteString == "https://example.com/from-js")
	}

	@Test func sharePayloadLoadsAStringRegisteredAsAURL() async throws {
		let provider = NSItemProvider(item: "https://example.com/safari-string-url" as NSString, typeIdentifier: UTType.url.identifier)
		let loaded = try await provider.loadItem(forTypeIdentifier: UTType.url.identifier)
		#expect(
			SharedShareItem.webURL(from: loaded)?.absoluteString == "https://example.com/safari-string-url",
			"Safari registers a string under public.url; the share extension used to keep only URL objects",
		)
	}

	@Test func aPendingSharedSaveLandsInReadItLaterAfterSync() async throws {
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .custom { decoder in
			let value = try decoder.singleValueContainer().decode(String.self)
			let formatter = ISO8601DateFormatter()
			formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
			if let date = formatter.date(from: value) { return date }
			formatter.formatOptions = [.withInternetDateTime]
			guard let date = formatter.date(from: value) else {
				throw DecodingError.dataCorruptedError(
					in: try decoder.singleValueContainer(),
					debugDescription: "Expected an ISO 8601 date",
				)
			}
			return date
		}
		let page = try decoder.decode(IncrementalSyncPage.self, from: Data("""
		{
		  "cursor": "v1:2",
		  "hasMore": false,
		  "changes": [
		    {
		      "sequence": 1,
		      "entityType": "feed",
		      "entityId": "pigeon:saved",
		      "operation": "upsert",
		      "changedAt": "2026-11-13T12:00:00.000Z",
		      "payload": {
		        "feedKey": "pigeon:saved",
		        "streamId": "feed/4",
		        "title": "Read It Later",
		        "isActive": true,
		        "sourceType": "saved",
		        "folders": []
		      }
		    },
		    {
		      "sequence": 2,
		      "entityType": "article",
		      "entityId": "abde2a43-22dc-8734-9049-5cd424e03007",
		      "operation": "upsert",
		      "changedAt": "2026-11-13T12:00:00.000Z",
		      "payload": {
		        "id": "abde2a43-22dc-8734-9049-5cd424e03007",
		        "readerId": "tag:google.com,2005:reader/item/0000000000000005",
		        "feedKey": "pigeon:saved",
		        "source": "Read It Later",
		        "title": "example.com/from-share",
		        "html": "",
		        "originalURL": "https://example.com/from-share",
		        "receivedAt": "2026-11-13T12:00:00.000Z",
		        "isRead": false,
		        "isStarred": false,
		        "extractionState": "pending"
		      }
		    }
		  ]
		}
		""".utf8))
		let store = OfflineLibraryStore.inMemory()
		try await store.apply(page, accountID: "share-later")
		let snapshot = try await store.loadSnapshot(accountID: "share-later")
		let saved = try #require(snapshot.articlesByCollection[ReaderSection.saved.rawValue]?.first)
		#expect(saved.title == "example.com/from-share")
		#expect(saved.savedState == .pending)
		#expect(saved.isRead == false)
		#expect(snapshot.articlesByCollection[ReaderSection.unread.rawValue, default: []].isEmpty)
	}

	@Test func feedLikeLinksOfferAddAsFeedFirst() throws {
		for feed in [
			"https://example.com/feed", "https://example.com/blog/rss.xml", "https://example.com/atom.xml",
			"https://example.com/index.xml", "https://www.youtube.com/@mkbhd", "https://www.youtube.com/channel/UC123",
			"https://example.com/?feed=rss2",
		] {
			#expect(SharedLinkClassifier.looksLikeFeed(try #require(URL(string: feed))), "\(feed)")
		}
		for article in [
			"https://example.com/essays/slow-software", "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
			"https://youtu.be/aqz-KE-bpKQ", "https://example.com/feedback-matters",
		] {
			#expect(SharedLinkClassifier.looksLikeFeed(try #require(URL(string: article))) == false, "\(article)")
		}
	}

	@Test func shareExtensionPostsOnlyTheBareLink() throws {
		let request = try SharedLinkClassifier.saveRequest(
			baseURL: try #require(URL(string: "https://pigeon.test")),
			token: "token",
			url: try #require(URL(string: "https://example.com/a")),
			title: "A",
		)
		#expect(request.url?.absoluteString == "https://pigeon.test/api/v1/saved")
		#expect(request.httpMethod == "POST")
		#expect(request.value(forHTTPHeaderField: "Authorization") == "GoogleLogin auth=pigeon/token")
		let body = try JSONSerialization.jsonObject(with: try #require(request.httpBody)) as? [String: String]
		#expect(body == ["url": "https://example.com/a", "title": "A"])
	}

	// MARK: - Helpers

	static func saved(
		_ id: String,
		url: String = "https://example.com/saved",
		html: String = "<p>Body</p>",
		words: Int? = 500,
		receivedAt: Date = .now,
		state: SavedExtractionState = .done,
		mediaKind: String = "text",
		duration: Int? = nil,
	) -> Recommendation {
		Recommendation(
			id: id, readerId: "reader-\(id)", feedKey: SavedItems.feedKey, source: SavedItems.title, title: id,
			html: html, text: nil, originalURL: URL(string: url), receivedAt: receivedAt, isRead: false, isStarred: false,
			score: 0, confidence: 0, sampleCount: 0, explanation: "", learningState: "",
			length: ArticleLength(wordCount: words, mediaKind: mediaKind, durationSeconds: duration),
			saved: SavedArticleMetadata(extractionState: state.rawValue, publishedAt: nil, imageURL: nil, siteName: nil),
		)
	}
}

/// Models keychain access groups: a nil group reads the first match from any
/// group and deletes from every group.
final class FakeKeychain: KeychainItemAccessing, @unchecked Sendable {
	struct Key: Hashable {
		var group: String?
		var service = SharedSessionKeychain.service
		var account = SharedSessionKeychain.account
	}

	var items: [Key: Data] = [:]
	var missingEntitlementGroups: Set<String> = []
	var copyFailureGroups: Set<String> = []
	var addFailureStatus: OSStatus?
	private(set) var addCount = 0
	private(set) var deleteCount = 0

	func copyItem(service: String, account: String, accessGroup: String?) throws -> KeychainItem? {
		if let accessGroup, copyFailureGroups.contains(accessGroup) {
			throw KeychainAccessError(status: errSecMissingEntitlement)
		}
		let match = items
			.filter { $0.key.service == service && $0.key.account == account && (accessGroup == nil || $0.key.group == accessGroup) }
			.sorted { ($0.key.group ?? "") < ($1.key.group ?? "") }
			.first
		return match.map { KeychainItem(data: $0.value, accessGroup: $0.key.group) }
	}

	func addItem(_ data: Data, service: String, account: String, accessGroup: String?) throws {
		if let accessGroup, missingEntitlementGroups.contains(accessGroup) {
			throw KeychainAccessError(status: errSecMissingEntitlement)
		}
		if let addFailureStatus { throw KeychainAccessError(status: addFailureStatus) }
		let key = Key(group: accessGroup, service: service, account: account)
		guard items[key] == nil else { throw KeychainAccessError(status: errSecDuplicateItem) }
		addCount += 1
		items[key] = data
	}

	func deleteItems(service: String, account: String, accessGroup: String?) throws {
		deleteCount += 1
		items = items.filter { entry in
			!(entry.key.service == service && entry.key.account == account && (accessGroup == nil || entry.key.group == accessGroup))
		}
	}
}
