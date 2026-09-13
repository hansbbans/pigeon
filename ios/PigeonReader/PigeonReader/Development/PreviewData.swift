#if DEBUG
import Foundation

@MainActor
enum PreviewData {
	enum LaunchFixtureScenario: String, Sendable {
		case emptyColdToday = "empty-cold-today"
		case cachedSelectedList = "cached-selected-list"
		case replayFailure = "replay-failure"
	}

	/// Returns the opt-in DEBUG launch fixture selected by UI tests or a local
	/// `simctl launch` invocation. The normal preview and production launch paths
	/// do not enter this branch.
	static var launchFixtureScenario: LaunchFixtureScenario? {
		let arguments = ProcessInfo.processInfo.arguments
		guard arguments.contains("-reader-real-startup") else { return nil }
		if arguments.contains("-reader-real-startup-cached-selected-list") {
			return .cachedSelectedList
		}
		if arguments.contains("-reader-real-startup-replay-failure") {
			return .replayFailure
		}
		return .emptyColdToday
	}

	@MainActor
	static func makeRealStartupModel(for scenario: LaunchFixtureScenario) -> ReaderAppModel {
		guard let baseURL = URL(string: "https://pigeon.launch-fixture") else {
			preconditionFailure("The launch fixture URL must be valid")
		}
		let session = PigeonSession(baseURL: baseURL, token: "debug-launch-fixture-token")
		let selectedFeedID = "feed/launch-fixture"
		let cachedArticles = launchCachedArticles
		let subscriptions = [
			FeedSubscription(
				id: selectedFeedID,
				title: "Launch Fixture Reads",
				categories: [],
				url: baseURL.appending(path: "feed/launch-fixture"),
				sourceUrl: URL(string: "https://example.invalid/launch-fixture"),
				htmlUrl: URL(string: "https://example.invalid/launch-fixture"),
				iconUrl: nil,
			),
		]
		let navigation = ReaderNavigationCatalog.make(
			subscriptions: subscriptions.map { subscription in
				ReaderSubscription(
					id: subscription.id,
					title: subscription.title,
					url: subscription.url.absoluteString,
				)
			},
			unreadCounts: [
				ReaderUnreadCount(id: selectedFeedID, count: cachedArticles.count),
				ReaderUnreadCount(id: "user/-/state/com.google/reading-list", count: cachedArticles.count),
			],
			smartCounts: ReaderNavigationSmartCounts(
				forYou: 0,
				today: 0,
				unread: cachedArticles.count,
				starred: cachedArticles.count(where: \.isStarred),
			),
		)

		let offlineStore: any OfflineLibraryStoring
		switch scenario {
		case .emptyColdToday:
			// This is intentionally an empty real store. The visible Today page
			// must come from the bounded live request before full sync completes.
			offlineStore = LaunchFixtureOfflineStore(
				store: OfflineLibraryStore.inMemory(),
				restoration: ReaderRestorationState(
					selectedNavigationID: ReaderSection.today.rawValue,
					selectedArticleIDs: [:],
					sortOrders: [:],
					articleFilters: [:],
					sidebarFilter: ReaderSidebarFilter.all.rawValue,
					expandedFolderIDs: [],
					compactColumn: .content,
					readerModes: [:],
					articleScrollOffsets: [:],
				),
			)
		case .cachedSelectedList, .replayFailure:
			offlineStore = LaunchFixtureOfflineStore(
				store: OfflineLibraryStore.inMemory(),
				navigation: navigation,
				subscriptions: subscriptions,
				articlesByCollection: [selectedFeedID: cachedArticles],
				selectedCollectionID: selectedFeedID,
				pendingMutations: scenario == .replayFailure
					? [OfflineMutation(kind: .setRead, itemIds: [cachedArticles[0].id], value: true)]
					: [],
			)
		}

		let model = ReaderAppModel(
			sessionStore: PreviewSessionStore(session: session),
			httpClient: LaunchFixtureHTTPClient(
				scenario: scenario,
				articles: scenario == .emptyColdToday ? launchTodayArticles : cachedArticles,
			),
			readwiseTokenStore: PreviewReadwiseTokenStore(),
			offlineStore: offlineStore,
			offlineSynchronizationEnabled: true,
		)
		if scenario == .emptyColdToday {
			model.select(section: .today)
		}
		return model
	}

	static func makeModel() -> ReaderAppModel {
		let showsToday = ProcessInfo.processInfo.arguments.contains("-reader-today-data")
		let showsFolderRead = ProcessInfo.processInfo.arguments.contains("-reader-folder-read-data")
		var articles = showsToday ? todayArticles : Self.articles
		if showsFolderRead {
			articles[2].isRead = false
		}
		let secondFolder = showsFolderRead ? "Design" : "Technology"
		guard let baseURL = URL(string: "https://pigeon.preview") else {
			preconditionFailure("The preview URL must be valid")
		}
		let session = PigeonSession(baseURL: baseURL, token: "preview-token")
		let model = ReaderAppModel(
			sessionStore: PreviewSessionStore(session: session),
			httpClient: PreviewHTTPClient(recommendations: articles),
			readwiseTokenStore: PreviewReadwiseTokenStore(),
			offlineStore: OfflineLibraryStore.inMemory(
				seeding: articles,
				collectionID: ReaderSection.forYou.rawValue,
				accountID: session.storageIdentity,
			),
			offlineSynchronizationEnabled: false,
		)
		model.setArticles(articles, for: .forYou)
		model.setArticles(articles.filter { $0.isRead == false }, for: .unread)
		model.setArticles(articles.filter(\.isStarred), for: .starred)
		model.setSubscriptions([
			FeedSubscription(
				id: "feed/1", title: "Dense Discovery", categories: [FeedCategory(id: "user/-/label/Design", label: "Design")],
				url: baseURL.appending(path: "feed/dense-discovery"), sourceUrl: URL(string: "https://www.densediscovery.com/feed"),
				htmlUrl: URL(string: "https://www.densediscovery.com"), iconUrl: nil,
			),
			FeedSubscription(
				id: "feed/2", title: "Marginal Revolution", categories: [FeedCategory(id: "user/-/label/\(secondFolder)", label: secondFolder)],
				url: baseURL.appending(path: "feed/marginal-revolution"), sourceUrl: URL(string: "https://marginalrevolution.com/feed"),
				htmlUrl: URL(string: "https://marginalrevolution.com"), iconUrl: nil,
			),
			FeedSubscription(
				id: "feed/3", title: "Stratechery",
				categories: showsFolderRead ? [FeedCategory(id: "user/-/label/Technology", label: "Technology")] : [],
				url: baseURL.appending(path: "feed/stratechery"), sourceUrl: URL(string: "https://stratechery.com/feed"),
				htmlUrl: URL(string: "https://stratechery.com"), iconUrl: nil,
			),
		])
		model.setNavigation(
			ReaderNavigationCatalog.make(
				subscriptions: [
					ReaderSubscription(
						id: "feed/1",
						title: "Dense Discovery",
						categories: [ReaderSubscriptionCategory(id: "user/-/label/Design", label: "Design")],
						url: "https://pigeon.preview/feed/dense-discovery",
					),
					ReaderSubscription(
						id: "feed/2",
						title: "Marginal Revolution",
						categories: [ReaderSubscriptionCategory(id: "user/-/label/\(secondFolder)", label: secondFolder)],
						url: "https://pigeon.preview/feed/marginal-revolution",
					),
					ReaderSubscription(
						id: "feed/3",
						title: "Stratechery",
						categories: showsFolderRead ? [ReaderSubscriptionCategory(id: "user/-/label/Technology", label: "Technology")] : [],
						url: "https://pigeon.preview/feed/stratechery",
					),
				],
				unreadCounts: [
					ReaderUnreadCount(id: "feed/1", count: 1),
					ReaderUnreadCount(id: "feed/2", count: 1),
					ReaderUnreadCount(id: "feed/3", count: showsFolderRead ? 1 : 0),
					ReaderUnreadCount(id: "user/-/label/Design", count: showsFolderRead ? 2 : 1),
					ReaderUnreadCount(id: "user/-/label/Technology", count: 1),
					ReaderUnreadCount(id: "user/-/state/com.google/reading-list", count: showsFolderRead ? 3 : 2),
				],
				smartCounts: ReaderNavigationSmartCounts(forYou: showsFolderRead ? 3 : 2, today: 1, unread: showsFolderRead ? 3 : 2, starred: 1),
			),
				markAsLoaded: true,
			)
			if showsFolderRead {
				model.sidebarFilter = .all
				for folder in model.navigation.folderItems {
					if model.isFolderExpanded(folder) == false { model.toggleFolder(folder) }
					if folder.title == "Design" {
						// The selected page omits the second feed, which is present
						// in the saved library. Mark All must still reach both feeds.
						model.setArticles([articles[0]], for: folder)
					}
				}
			}
			model.select(section: showsToday ? .today : .forYou)
			return model
	}

	// Keep the Today UI fixture inside the current local day across test dates.
	private static var todayArticles: [Recommendation] {
		let start = Calendar.current.startOfDay(for: .now)
		return articles.prefix(2).map { article in
			Recommendation(
				id: article.id,
				readerId: article.readerId,
				feedKey: article.feedKey,
				source: article.source,
				title: article.title,
				html: article.html,
				text: article.text,
				originalURL: article.originalURL,
				receivedAt: start,
				isRead: false,
				isStarred: article.isStarred,
				score: article.score,
				confidence: article.confidence,
				sampleCount: article.sampleCount,
				explanation: article.explanation,
				learningState: article.learningState,
			)
		}
	}

	static let articles: [Recommendation] = [
		Recommendation(
			id: "preview-1",
			readerId: "tag:google.com,2005:reader/item/0000000000000001",
			feedKey: "dense-discovery",
			source: "Dense Discovery",
			title: "Designing calmer tools for people who read every day",
			html: """
			<article>
				<h1>The quiet craft of a good reading surface</h1>
				<p>Good reading software gets out of the way. It keeps navigation predictable, typography quiet, and the original source one deliberate action away.</p>
				<p><strong>Rich content should still feel calm.</strong> A useful reader makes hierarchy visible without shouting.</p>
				<figure>
					<a href="https://example.com/design/photo"><img src="https://images.unsplash.com/photo-1499750310107-5fef28a66643?auto=format&amp;fit=crop&amp;w=1200&amp;q=80" srcset="https://images.unsplash.com/photo-1499750310107-5fef28a66643?auto=format&amp;fit=crop&amp;w=640&amp;q=80 640w, https://images.unsplash.com/photo-1499750310107-5fef28a66643?auto=format&amp;fit=crop&amp;w=1200&amp;q=80 1200w" alt="A notebook beside a cup of coffee" width="1200" height="800"></a>
					<figcaption>A clear page gives attention somewhere to land.</figcaption>
				</figure>
				<h2>Small decisions compound</h2>
				<ul><li>Headings make a long story navigable.</li><li>Lists let the eye move quickly.</li><li><em>Emphasis</em> keeps the voice human.</li></ul>
				<hr>
				<blockquote>Make the next useful action obvious, then get out of the way.</blockquote>
				<pre><code>reader.mode = .calm\nreader.distraction = .low</code></pre>
				<table><caption>A tiny reading checklist</caption><thead><tr><th>Signal</th><th>Question</th></tr></thead><tbody><tr><td>Rhythm</td><td>Can the eye find the next paragraph?</td></tr><tr><td>Images</td><td>Do they stay inside the column?</td></tr></tbody></table>
				<p><a href="https://example.com/design?private=ignored">Read the design notes</a> for the longer argument.</p>
				<img src="/images/missing-preview-image.png" alt="A missing preview image">
				<script>alert('should not run')</script><form><input value="unsafe"></form>
			</article>
			""",
			text: "Good reading software gets out of the way.",
			originalURL: URL(string: "https://example.com/design"),
			receivedAt: Date(timeIntervalSince1970: 1_786_272_000),
			isRead: false,
			isStarred: true,
			score: 91,
			confidence: 0.82,
			sampleCount: 14,
			explanation: "You often finish and save stories from this source.",
			learningState: "High confidence"
		),
		Recommendation(
			id: "preview-2",
			readerId: "tag:google.com,2005:reader/item/0000000000000002",
			feedKey: "marginal-revolution",
			source: "Marginal Revolution",
			title: "A short note on cities, attention, and useful density",
			html: "<p>Compact systems reward clear hierarchy and fast movement between context and detail.</p>",
			text: "Compact systems reward clear hierarchy.",
			originalURL: URL(string: "https://example.com/cities"),
			receivedAt: Date(timeIntervalSince1970: 1_786_268_400),
			isRead: false,
			isStarred: false,
			score: 78,
			confidence: 0.64,
			sampleCount: 8,
			explanation: "Recent and similar to stories you read for several minutes.",
			learningState: "Learning your interests",
		),
		Recommendation(
			id: "preview-3",
			readerId: "tag:google.com,2005:reader/item/0000000000000003",
			feedKey: "stratechery",
			source: "Stratechery",
			title: "The durable advantage of software with a clear point of view",
			html: "<p>A focused product can be smaller than its competitors and still feel substantially more complete.</p>",
			text: "A focused product can feel more complete.",
			originalURL: URL(string: "https://example.com/focus"),
			receivedAt: Date(timeIntervalSince1970: 1_786_182_000),
			isRead: true,
			isStarred: false,
			score: 66,
			confidence: 0.48,
			sampleCount: 5,
			explanation: "This source is still new to your reading history.",
			learningState: "Still learning"
		),
		Recommendation(
			id: "preview-youtube",
			readerId: "tag:google.com,2005:reader/item/0000000000000004",
			feedKey: "youtube-creators",
			source: "YouTube Creators",
			title: "A practical guide to making better videos",
			html: """
			<article>
				<p>This deterministic fixture represents a video entry from a YouTube channel feed.</p>
				<p>The official player appears above this feed content and starts only when you press play.</p>
			</article>
			""",
			text: "A practical guide to making better videos.",
			originalURL: URL(string: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
			receivedAt: Date(timeIntervalSince1970: 1_786_172_000),
			isRead: false,
			isStarred: false,
			score: 72,
			confidence: 0.61,
			sampleCount: 7,
			explanation: "A recent video from a source you follow.",
			learningState: "Learning your interests",
		),
	]

	private static var launchTodayArticles: [Recommendation] {
		let startOfDay = Calendar.current.startOfDay(for: .now)
		return [
			Recommendation(
				id: "launch-today-1",
				readerId: "tag:google.com,2005:reader/item/launch-today-1",
				feedKey: "launch-fixture",
				source: "Launch Fixture",
				title: "Cold-start story appears before sync finishes",
				html: "<p>This article proves the visible Today page does not wait for full sync.</p>",
				text: "This article proves the visible Today page does not wait for full sync.",
				originalURL: URL(string: "https://example.invalid/launch-today-1"),
				receivedAt: startOfDay.addingTimeInterval(60 * 60),
				isRead: false,
				isStarred: false,
				score: 0,
				confidence: 0,
				sampleCount: 0,
				explanation: "Debug startup fixture",
				learningState: "Debug startup fixture",
			),
		]
	}

	private static var launchCachedArticles: [Recommendation] {
		[
			Recommendation(
				id: "launch-cached-1",
				readerId: "tag:google.com,2005:reader/item/launch-cached-1",
				feedKey: "launch-fixture",
				source: "Launch Fixture",
				title: "Saved story remains visible during slow updates",
				html: "<p>This saved article remains available while incremental sync is deliberately slow.</p>",
				text: "This saved article remains available while incremental sync is deliberately slow.",
				originalURL: URL(string: "https://example.invalid/launch-cached-1"),
				receivedAt: Date.now.addingTimeInterval(-300),
				isRead: false,
				isStarred: true,
				score: 0,
				confidence: 0,
				sampleCount: 0,
				explanation: "Debug cached startup fixture",
				learningState: "Debug cached startup fixture",
			),
			Recommendation(
				id: "launch-cached-2",
				readerId: "tag:google.com,2005:reader/item/launch-cached-2",
				feedKey: "launch-fixture",
				source: "Launch Fixture",
				title: "A second saved story proves the list is real",
				html: "<p>The complete cached list is rendered by the normal ArticleList task.</p>",
				text: "The complete cached list is rendered by the normal ArticleList task.",
				originalURL: URL(string: "https://example.invalid/launch-cached-2"),
				receivedAt: Date.now.addingTimeInterval(-600),
				isRead: false,
				isStarred: false,
				score: 0,
				confidence: 0,
				sampleCount: 0,
				explanation: "Debug cached startup fixture",
				learningState: "Debug cached startup fixture",
			),
		]
	}
}

/// A DEBUG-only adapter that seeds the production OfflineLibraryStore API with a
/// complete cache, then forwards every operation to that real SQLite-backed
/// implementation. Keeping the adapter here avoids changing production storage
/// behavior just to make launch timing reproducible.
private actor LaunchFixtureOfflineStore: OfflineLibraryStoring, OfflineLibraryBootstrapProviding {
	private struct Seed: Sendable {
		let navigation: ReaderNavigationState
		let subscriptions: [FeedSubscription]
		let articlesByCollection: [String: [Recommendation]]
		let restoration: ReaderRestorationState
		let pendingMutations: [OfflineMutation]
	}

	private enum SeedMode: Sendable {
		case complete(Seed)
		case restorationOnly(ReaderRestorationState)
	}

	private let store: OfflineLibraryStore
	private let seedMode: SeedMode
	nonisolated private let bootstrapSeed: Seed?
	private var didSeed = false
	private var didDelayInitialSnapshot = false

	init(
		store: OfflineLibraryStore,
		navigation: ReaderNavigationState,
		subscriptions: [FeedSubscription],
		articlesByCollection: [String: [Recommendation]],
		selectedCollectionID: String,
		pendingMutations: [OfflineMutation],
	) {
		self.store = store
		let seed = Seed(
			navigation: navigation,
			subscriptions: subscriptions,
			articlesByCollection: articlesByCollection,
			restoration: ReaderRestorationState(
				selectedNavigationID: selectedCollectionID,
				selectedArticleIDs: [:],
				sortOrders: [:],
				articleFilters: [:],
				sidebarFilter: ReaderSidebarFilter.all.rawValue,
				expandedFolderIDs: [],
				compactColumn: .content,
				readerModes: [:],
				articleScrollOffsets: [:],
			),
			pendingMutations: pendingMutations,
		)
		self.seedMode = .complete(seed)
		self.bootstrapSeed = seed
	}

	init(store: OfflineLibraryStore, restoration: ReaderRestorationState) {
		self.store = store
		self.seedMode = .restorationOnly(restoration)
		self.bootstrapSeed = nil
	}

	nonisolated func loadBootstrapSnapshot(accountID: String) -> OfflineLibraryBootstrapSnapshot? {
		guard let bootstrapSeed else { return nil }
		return OfflineLibraryBootstrapSnapshot(
			accountID: accountID,
			generatedAt: .now,
			navigation: bootstrapSeed.navigation,
			subscriptions: bootstrapSeed.subscriptions,
			preferences: OfflineLibraryBootstrapPreferences(
				sortOrders: bootstrapSeed.restoration.sortOrders,
				articleFilters: bootstrapSeed.restoration.articleFilters,
				sidebarFilter: bootstrapSeed.restoration.sidebarFilter,
				expandedFolderIDs: bootstrapSeed.restoration.expandedFolderIDs,
			),
			todayDayStart: ReaderLocalDayBounds.localDay(containing: .now).start,
		)
	}

	private func seedIfNeeded(accountID: String) async throws {
		guard didSeed == false else { return }
		if case let .restorationOnly(restoration) = seedMode {
			try await store.saveRestoration(restoration, accountID: accountID)
			didSeed = true
			return
		}
		guard case let .complete(seed) = seedMode else { return }
		let seededAt = Date(timeIntervalSince1970: 1_788_000_000)
		try await store.beginFullRebuild(accountID: accountID, at: seededAt)
		try await store.apply(
			IncrementalSyncPage(
				cursor: "launch-fixture-cursor",
				hasMore: false,
				changes: seedChanges(seed, at: seededAt),
			),
			accountID: accountID,
			dayBounds: nil,
		)
		try await store.saveNavigation(seed.navigation, accountID: accountID)
		try await store.saveSubscriptions(seed.subscriptions, accountID: accountID)
		try await store.finishSynchronization(accountID: accountID, at: seededAt, dayBounds: nil)
		try await store.saveRestoration(seed.restoration, accountID: accountID)
		for mutation in seed.pendingMutations {
			try await store.enqueue(mutation, accountID: accountID)
		}
		didSeed = true
	}

	private func seedChanges(_ seed: Seed, at date: Date) -> [IncrementalSyncChange] {
		let feedChange = IncrementalSyncChange(
			sequence: 1,
			entityType: .feed,
			entityId: "launch-fixture",
			operation: .upsert,
			changedAt: date,
			payload: IncrementalSyncPayload(
				feedKey: "launch-fixture",
				streamId: "feed/launch-fixture",
				title: "Launch Fixture Reads",
				feedURL: URL(string: "https://example.invalid/launch-fixture/feed"),
				siteURL: URL(string: "https://example.invalid/launch-fixture"),
				iconURL: nil,
				isActive: true,
				folders: [],
				id: nil,
				readerId: nil,
				source: nil,
				author: nil,
				html: nil,
				text: nil,
				originalURL: nil,
				receivedAt: nil,
				isRead: nil,
				isStarred: nil,
				isBodyPruned: nil,
				itemId: nil,
				updatedAt: nil,
				version: nil,
				mutationId: nil,
			),
		)
		let articleChanges = seed.articlesByCollection.values
			.flatMap { $0 }
			.reduce(into: [String: Recommendation]()) { articles, article in
				articles[article.id] = article
			}
			.values
			.sorted { $0.id < $1.id }
			.enumerated()
			.map { offset, article in
				IncrementalSyncChange(
					sequence: Int64(offset + 2),
					entityType: .article,
					entityId: article.id,
					operation: .upsert,
					changedAt: date,
					payload: IncrementalSyncPayload(
						feedKey: article.feedKey,
						streamId: nil,
						title: article.title,
						feedURL: nil,
						siteURL: nil,
						iconURL: nil,
						isActive: nil,
						folders: nil,
						id: article.id,
						readerId: article.readerId,
						source: article.source,
						author: article.author,
						html: article.html,
						text: article.text,
						originalURL: article.originalURL,
						receivedAt: article.receivedAt,
						isRead: article.isRead,
						isStarred: article.isStarred,
						isBodyPruned: false,
						itemId: nil,
						updatedAt: date,
						version: 1,
						mutationId: nil,
					),
				)
			}
		return [feedChange] + articleChanges
	}

	func loadSnapshot(accountID: String) async throws -> CachedLibrarySnapshot {
		if didDelayInitialSnapshot == false,
			ProcessInfo.processInfo.arguments.contains("-reader-delay-initial-snapshot") {
			didDelayInitialSnapshot = true
			// Amplify the disk-read window so UI tests can inspect the first
			// frame before the real cached library is returned to the model.
			try await Task.sleep(for: .seconds(15))
		}
		try await seedIfNeeded(accountID: accountID)
		return try await store.loadSnapshot(accountID: accountID)
	}

	func saveNavigation(_ navigation: ReaderNavigationState, accountID: String) async throws {
		try await store.saveNavigation(navigation, accountID: accountID)
	}

	func saveSubscriptions(_ subscriptions: [FeedSubscription], accountID: String) async throws {
		try await store.saveSubscriptions(subscriptions, accountID: accountID)
	}

	func saveArticles(_ articles: [Recommendation], collectionID: String, accountID: String) async throws {
		try await store.saveArticles(articles, collectionID: collectionID, accountID: accountID)
	}

	func saveCollectionContinuation(_ continuation: String?, collectionID: String, accountID: String) async throws {
		try await store.saveCollectionContinuation(continuation, collectionID: collectionID, accountID: accountID)
	}

	func saveRestoration(_ restoration: ReaderRestorationState, accountID: String) async throws {
		try await store.saveRestoration(restoration, accountID: accountID)
	}

	func enqueue(_ mutation: OfflineMutation, accountID: String) async throws {
		try await store.enqueue(mutation, accountID: accountID)
	}

	func pendingMutations(accountID: String, limit: Int) async throws -> [PendingOfflineMutation] {
		try await store.pendingMutations(accountID: accountID, limit: limit)
	}

	func markMutationApplied(id: String, accountID: String) async throws {
		try await store.markMutationApplied(id: id, accountID: accountID)
	}

	func recordMutationFailure(id: String, message: String, accountID: String) async throws {
		try await store.recordMutationFailure(id: id, message: message, accountID: accountID)
	}

	func apply(_ page: IncrementalSyncPage, accountID: String) async throws {
		try await store.apply(page, accountID: accountID)
	}

	func apply(_ page: IncrementalSyncPage, accountID: String, dayBounds: ReaderLocalDayBounds?) async throws {
		try await store.apply(page, accountID: accountID, dayBounds: dayBounds)
	}

	func beginFullRebuild(accountID: String, at date: Date) async throws {
		try await store.beginFullRebuild(accountID: accountID, at: date)
	}

	func abandonFullRebuild(accountID: String, startedAt: Date) async throws {
		try await store.abandonFullRebuild(accountID: accountID, startedAt: startedAt)
	}

	func finishSynchronization(accountID: String, at date: Date, dayBounds: ReaderLocalDayBounds?) async throws {
		try await store.finishSynchronization(accountID: accountID, at: date, dayBounds: dayBounds)
	}

	func finishWarmSynchronization(accountID: String, at date: Date, dayBounds: ReaderLocalDayBounds?) async throws {
		try await store.finishWarmSynchronization(accountID: accountID, at: date, dayBounds: dayBounds)
	}

	func markDataSynchronizedWithoutNavigation(accountID: String, at date: Date, dayBounds: ReaderLocalDayBounds?) async throws {
		try await store.markDataSynchronizedWithoutNavigation(accountID: accountID, at: date, dayBounds: dayBounds)
	}

	func markCacheRepairNeeded(accountID: String, message: String, at date: Date) async throws {
		try await store.markCacheRepairNeeded(accountID: accountID, message: message, at: date)
	}

	func recordSynchronizationFailure(accountID: String, message: String, at date: Date) async throws {
		try await store.recordSynchronizationFailure(accountID: accountID, message: message, at: date)
	}

	func storageStats(accountID: String) async throws -> OfflineStorageStats {
		try await store.storageStats(accountID: accountID)
	}

	func cleanupReadBodies(accountID: String, keepingNewest count: Int) async throws -> Int {
		try await store.cleanupReadBodies(accountID: accountID, keepingNewest: count)
	}

	func clearCachedArticles(accountID: String) async throws {
		try await store.clearCachedArticles(accountID: accountID)
	}

	func searchArticles(query: String, collectionID: String?, accountID: String, limit: Int) async throws -> [Recommendation] {
		try await store.searchArticles(query: query, collectionID: collectionID, accountID: accountID, limit: limit)
	}
}
#endif
