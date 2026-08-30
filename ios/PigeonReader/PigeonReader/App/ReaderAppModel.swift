import Foundation
import Observation
import SwiftUI
import WidgetKit

struct PendingFeedRequest: Identifiable, Equatable {
	let id = UUID()
	let url: URL
}

@MainActor
@Observable
final class ReaderAppModel {
	private enum ReadBoundary: Sendable {
		case above
		case below
	}

	private struct ArticleFilterKey: Hashable {
		let sessionIdentity: String
		let collectionID: String
	}

	private struct BulkReadUndo: Sendable {
		let articles: [Recommendation]
		let title: String
	}

	private struct CollectionFreshness: Sendable {
		let updatedAt: Date
		let isCached: Bool
	}

	private struct OperationContext: Sendable, Equatable {
		let accountID: String
		let generation: UUID
		let preparationID: UUID?
	}

	private enum StaleFeedUndo: Sendable {
		case archive([String])
		case unarchive([String])
		case unsubscribe([FeedSubscription])
	}

	var session: PigeonSession?
	var serverURLText = ""
	var password = ""
	private(set) var selectedNavigationID = ReaderSection.forYou.rawValue
	var selectedArticleID: String?
	var preferredCompactColumn: NavigationSplitViewColumn = .sidebar {
		didSet {
			if preferredCompactColumn != oldValue { scheduleRestorationSave() }
		}
	}
	var isConnecting = false
	var errorMessage: String?
	var isShowingSettings = false
	private(set) var subscriptions: [FeedSubscription] = []
	var isLoadingLibrary = false
	private(set) var hasReadwiseToken = false
	private(set) var navigation = ReaderNavigationState.initial
	private(set) var enabledSmartViewSections: Set<ReaderSection>
	private(set) var isLoadingNavigation = false
	var articleFilter: ReaderArticleFilter {
		get { articleFilter(for: selectedNavigationID) }
		set { setArticleFilter(newValue, for: selectedNavigationID) }
	}
	var sidebarFilter = ReaderSidebarFilter.all {
		didSet {
			if sidebarFilter != oldValue { scheduleRestorationSave() }
		}
	}

	private let sessionStore: any SessionStore
	private let httpClient: any HTTPClient
	private let readwiseTokenStore: any ReadwiseTokenStore
	private let readwiseAPIClient: ReadwiseAPIClient
	private let readerModeStore: ReaderModeStore
	private let articleFilterStore: ReaderArticleFilterStore
	private let smartViewStore: ReaderSmartViewStore
	private let offlineStore: any OfflineLibraryStoring
	private let mutationReplayer: OfflineMutationReplayer
	private let offlineSynchronizationEnabled: Bool
	let readerTypography: ReaderTypographySettings
	let keyboardShortcuts: ReaderKeyboardShortcutSettings
	private let readerViewExtractor: any ReaderViewExtracting
	private var apiClient: PigeonAPIClient?
	private var articleCache: [String: [Recommendation]] = [:]
	private var sortOrders: [String: ArticleSortOrder] = [:]
	private var articleFilters: [ArticleFilterKey: ReaderArticleFilter] = [:]
	private var selectedArticleIDs: [String: String] = [:]
	private var loadingCollections: Set<String> = []
	private var activeLoadIDs: [String: UUID] = [:]
	private var streamContinuations: [String: String] = [:]
	private var seenStreamContinuations: [String: Set<String>] = [:]
	private var streamDayBounds: [String: ReaderLocalDayBounds] = [:]
	private var activeLoadMoreIDs: [String: UUID] = [:]
	private var loadingMoreCollections: Set<String> = []
	private var loadMoreErrors: [String: String] = [:]
	private var resolvedPaginationCollections: Set<String> = []
	private var inFlightReadwiseSaves: Set<String> = []
	private var engagement = EngagementAggregator()
	private var sentScrollThresholds: [String: Set<Int>] = [:]
	private var hasLoadedNavigation = false
	private var activeNavigationLoadID: UUID?
	private var activeNavigationLoadIDs: Set<UUID> = []
	private var activeLibraryLoadID: UUID?
	private var libraryGeneration = UUID()
	private var offlinePersistenceTask: Task<Bool, Never>?
	private var preparedOfflineAccountID: String?
	private var offlineSyncCursor: String?
	private var activeOfflinePreparationID: UUID?
	private var offlinePreparationTask: Task<Void, Never>?
	private var offlinePreparationTaskID: UUID?
	private var deferredInitialFeedPaginationCollectionID: String?
	private var isApplyingRestoration = false
	private var restorationSaveTask: Task<Void, Never>?
	private var hasAppliedCompactColumnRestoration = false
	private var temporarilyUnavailableSelectedCollection: ReaderNavigationItem?
	private var restoredReaderModes: [String: String] = [:]
	private var articleScrollOffsets: [String: Double] = [:]
	private var collectionFreshness: [String: CollectionFreshness] = [:]
	private var activeSearchID: UUID?
	private var activeSearchScope: ReaderSearchScope?
	private var activeSearchCollectionID: String?
	private var bulkReadUndo: BulkReadUndo?
	private var scrollReadTriggered: Set<String> = []
	private(set) var searchResults: [Recommendation] = []
	private(set) var isSearchingArticles = false
	private(set) var bulkReadUndoTitle: String?
	private(set) var offlineStorageStats = OfflineStorageStats.empty
	private(set) var isSynchronizingOfflineLibrary = false
	private(set) var isOffline = false
	private(set) var personalization: PersonalizationSnapshot?
	private(set) var isLoadingPersonalization = false
	var pendingFeedRequest: PendingFeedRequest?
	private(set) var staleFeedSnapshot: StaleFeedSnapshot?
	private(set) var isLoadingStaleFeeds = false
	private(set) var staleFeedUndoTitle: String?
	private var staleFeedUndo: StaleFeedUndo?
	private(set) var lastBackgroundRefreshAt: Date?
	var allowsLowDataBackgroundRefresh: Bool {
		didSet { UserDefaults.standard.set(allowsLowDataBackgroundRefresh, forKey: Self.lowDataBackgroundKey) }
	}
	private static let lowDataBackgroundKey = "pigeon.background.allows-low-data.v1"

	init(
		sessionStore: any SessionStore = KeychainSessionStore(),
		httpClient: any HTTPClient = URLSessionHTTPClient(),
		readwiseTokenStore: any ReadwiseTokenStore = KeychainReadwiseTokenStore(),
		readerModeStore: ReaderModeStore = ReaderModeStore(),
		articleFilterStore: ReaderArticleFilterStore = ReaderArticleFilterStore(),
		smartViewStore: ReaderSmartViewStore = ReaderSmartViewStore(),
		offlineStore: any OfflineLibraryStoring = OfflineLibraryStore.shared,
		offlineSynchronizationEnabled: Bool = true,
		readerTypography: ReaderTypographySettings? = nil,
		keyboardShortcuts: ReaderKeyboardShortcutSettings? = nil,
		readerViewExtractor: (any ReaderViewExtracting)? = nil,
	) {
		self.sessionStore = sessionStore
		self.httpClient = httpClient
		self.readwiseTokenStore = readwiseTokenStore
		self.readwiseAPIClient = ReadwiseAPIClient(tokenStore: readwiseTokenStore, httpClient: httpClient)
		self.readerModeStore = readerModeStore
		self.articleFilterStore = articleFilterStore
		self.smartViewStore = smartViewStore
		self.enabledSmartViewSections = smartViewStore.enabledSections
		self.offlineStore = offlineStore
		self.mutationReplayer = OfflineMutationReplayer(store: offlineStore)
		self.offlineSynchronizationEnabled = offlineSynchronizationEnabled
		self.readerTypography = readerTypography ?? ReaderTypographySettings()
		self.keyboardShortcuts = keyboardShortcuts ?? ReaderKeyboardShortcutSettings()
		self.readerViewExtractor = readerViewExtractor ?? ReaderViewExtractor(httpClient: httpClient)
		self.allowsLowDataBackgroundRefresh = UserDefaults.standard.bool(forKey: Self.lowDataBackgroundKey)
		if let initialSmartView = ReaderSmartViewStore.configurableSections.first(where: enabledSmartViewSections.contains) {
			selectedNavigationID = initialSmartView.rawValue
		}
		do {
			hasReadwiseToken = try readwiseTokenStore.load()?.isEmpty == false
		} catch {
			hasReadwiseToken = false
		}
		if let savedSession = try? sessionStore.load() {
			if savedSession.baseURL.scheme?.lowercased() == "https" {
				session = savedSession
				serverURLText = savedSession.baseURL.absoluteString
				apiClient = PigeonAPIClient(session: savedSession, httpClient: httpClient)
			} else {
				try? sessionStore.remove()
				serverURLText = savedSession.baseURL.absoluteString
				errorMessage = PigeonError.invalidServerURL.localizedDescription
			}
		}
	}

	var canConnect: Bool {
		!serverURLText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !password.isEmpty && !isConnecting
	}

	var syncHealthService: (any SyncHealthServicing)? {
		apiClient
	}

	// These library projections keep the existing feed-management screens working while
	// navigation is sourced from the newer Reader API snapshot.
	var folders: [FeedFolder] {
		let names = Set(subscriptions.flatMap(\.folderNames))
		return names.map { name in
			FeedFolder(
				name: name,
				subscriptions: sortedSubscriptions(subscriptions.filter { $0.folderNames.contains(name) }),
			)
		}.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
	}

	var unfiledSubscriptions: [FeedSubscription] {
		sortedSubscriptions(subscriptions.filter { $0.categories.isEmpty })
	}

	var selectedSection: ReaderSection {
		get { ReaderSection(rawValue: selectedNavigationID) ?? .forYou }
		set { select(section: newValue) }
	}

	var selectedCollection: ReaderNavigationItem {
		if let item = navigation.item(withID: selectedNavigationID) {
			return item
		}
		if let temporarilyUnavailableSelectedCollection,
			temporarilyUnavailableSelectedCollection.id == selectedNavigationID {
			return temporarilyUnavailableSelectedCollection
		}
		return .smart(selectedSection)
	}

	var smartNavigationItems: [ReaderNavigationItem] {
		navigation.smartItems
	}

	var visibleSmartNavigationItems: [ReaderNavigationItem] {
		smartNavigationItems.filter { item in
			guard let section = item.smartSection, section != .unread else {
				return false
			}
			return enabledSmartViewSections.contains(section)
		}
	}

	var isForYouSmartViewEnabled: Bool {
		get { enabledSmartViewSections.contains(.forYou) }
		set { setSmartViewEnabled(newValue, for: .forYou) }
	}

	var isStarredSmartViewEnabled: Bool {
		get { enabledSmartViewSections.contains(.starred) }
		set { setSmartViewEnabled(newValue, for: .starred) }
	}

	var isTodaySmartViewEnabled: Bool {
		get { enabledSmartViewSections.contains(.today) }
		set { setSmartViewEnabled(newValue, for: .today) }
	}

	func canDisableSmartView(_ section: ReaderSection) -> Bool {
		!enabledSmartViewSections.contains(section) || enabledSmartViewSections.count > 1
	}

	var folderNavigationItems: [ReaderNavigationItem] {
		navigation.folderItems
	}

	var visibleFolderNavigationItems: [ReaderNavigationItem] {
		guard sidebarFilter == .unread else {
			return folderNavigationItems
		}
		return folderNavigationItems.filter { $0.unreadCount > 0 }
	}

	var uncategorizedFeedNavigationItems: [ReaderNavigationItem] {
		navigation.uncategorizedFeedItems
	}

	func feedNavigationItems(in folder: ReaderNavigationItem) -> [ReaderNavigationItem] {
		navigation.children(of: folder.id)
	}

	func visibleFeedNavigationItems(in folder: ReaderNavigationItem) -> [ReaderNavigationItem] {
		let feeds = feedNavigationItems(in: folder)
		guard sidebarFilter == .unread else {
			return feeds
		}
		return feeds.filter { $0.unreadCount > 0 }
	}

	var visibleUncategorizedFeedNavigationItems: [ReaderNavigationItem] {
		guard sidebarFilter == .unread else {
			return uncategorizedFeedNavigationItems
		}
		return uncategorizedFeedNavigationItems.filter { $0.unreadCount > 0 }
	}

	func isFolderExpanded(_ folder: ReaderNavigationItem) -> Bool {
		navigation.expandedFolderIDs.contains(folder.id)
	}

	var articles: [Recommendation] {
		get { displayedArticles(for: selectedNavigationID) }
		set { setArticles(newValue, for: selectedNavigationID) }
	}

	var sortOrder: ArticleSortOrder {
		get { sortOrder(for: selectedNavigationID) }
		set { setSortOrder(newValue, for: selectedNavigationID) }
	}

	var selectedArticle: Recommendation? {
		guard let selectedArticleID else {
			return nil
		}
		return article(withId: selectedArticleID)
	}

	func canNavigateArticle(_ direction: ReaderBoundaryNavigationDirection) -> Bool {
		articleTarget(for: direction, from: selectedArticle) != nil
	}

	@discardableResult
	func navigateArticle(
		_ direction: ReaderBoundaryNavigationDirection,
		from current: Recommendation? = nil,
	) -> Recommendation? {
		guard let target = articleTarget(for: direction, from: current ?? selectedArticle) else {
			return nil
		}
		select(article: target)
		return target
	}

	var canUndoBulkRead: Bool { bulkReadUndo != nil }

	var isLoading: Bool {
		loadingCollections.contains(selectedNavigationID)
	}

	func isLoading(section: ReaderSection) -> Bool {
		loadingCollections.contains(section.rawValue)
	}

	func isLoading(collection: ReaderNavigationItem) -> Bool {
		loadingCollections.contains(collection.id)
	}

	func canLoadMore(collection: ReaderNavigationItem) -> Bool {
		streamContinuations[collection.id] != nil
	}

	func isLoadingMore(collection: ReaderNavigationItem) -> Bool {
		loadingMoreCollections.contains(collection.id)
	}

	func loadMoreError(for collection: ReaderNavigationItem) -> String? {
		loadMoreErrors[collection.id]
	}

	func connect() async {
		guard canConnect else {
			return
		}
		errorMessage = nil
		isConnecting = true
		defer { isConnecting = false }

		guard let url = URL(string: serverURLText.trimmingCharacters(in: .whitespacesAndNewlines)) else {
			errorMessage = PigeonError.invalidServerURL.localizedDescription
			return
		}

		do {
			let newSession = try await PigeonAPIClient.authenticate(baseURL: url, password: password, httpClient: httpClient)
			try sessionStore.save(newSession)
			resetInMemoryLibraryForAccountChange()
			session = newSession
			serverURLText = newSession.baseURL.absoluteString
			password = ""
			apiClient = PigeonAPIClient(session: newSession, httpClient: httpClient)
			await prepareOfflineLibrary()
		} catch let error where isCancellation(error) {
			// Leaving the connection screen is a normal cancellation.
		} catch {
			errorMessage = error.localizedDescription
		}
	}

	func disconnect() {
		do {
			offlinePreparationTask?.cancel()
			offlinePreparationTask = nil
			offlinePreparationTaskID = nil
			deferredInitialFeedPaginationCollectionID = nil
			libraryGeneration = UUID()
			try sessionStore.remove()
			session = nil
			apiClient = nil
			articleCache = [:]
			sortOrders = [:]
			articleFilters.removeAll()
			selectedArticleIDs = [:]
			resetStreamPagination()
			resolvedPaginationCollections.removeAll()
			subscriptions = []
			selectedArticleID = nil
			sidebarFilter = .all
			selectedNavigationID = firstEnabledSmartSection.rawValue
			navigation = .initial
			temporarilyUnavailableSelectedCollection = nil
			isLoadingNavigation = false
			activeNavigationLoadID = nil
			activeNavigationLoadIDs.removeAll()
			activeLibraryLoadID = nil
			isLoadingLibrary = false
			hasLoadedNavigation = false
			preferredCompactColumn = .sidebar
			preparedOfflineAccountID = nil
			offlineSyncCursor = nil
			activeOfflinePreparationID = nil
			restoredReaderModes = [:]
			articleScrollOffsets = [:]
			collectionFreshness = [:]
			activeSearchID = nil
			activeSearchScope = nil
			activeSearchCollectionID = nil
			searchResults = []
			isSearchingArticles = false
			bulkReadUndo = nil
			bulkReadUndoTitle = nil
			scrollReadTriggered = []
			offlineStorageStats = .empty
			isSynchronizingOfflineLibrary = false
			isOffline = false
			personalization = nil
			isLoadingPersonalization = false
			pendingFeedRequest = nil
			staleFeedSnapshot = nil
			isLoadingStaleFeeds = false
			staleFeedUndo = nil
			staleFeedUndoTitle = nil
			lastBackgroundRefreshAt = nil
			writeWidgetSnapshot()
			errorMessage = nil
		} catch {
			errorMessage = error.localizedDescription
		}
	}

	func saveReadwiseToken(_ token: String) throws {
		try readwiseTokenStore.save(token)
		hasReadwiseToken = true
	}

	func removeReadwiseToken() throws {
		try readwiseTokenStore.remove()
		hasReadwiseToken = false
	}

	func loadPersonalization() async {
		guard let apiClient else { return }
		isLoadingPersonalization = true
		defer { isLoadingPersonalization = false }
		do {
			personalization = try await apiClient.personalization()
		} catch let error where isCancellation(error) {
			return
		} catch {
			errorMessage = error.localizedDescription
		}
	}

	func deletePersonalizationHistory(id: String) async {
		guard let apiClient else { return }
		do {
			try await apiClient.deletePersonalizationHistory(id: id)
			await loadPersonalization()
		} catch {
			errorMessage = error.localizedDescription
		}
	}

	func resetPersonalization() async {
		guard let apiClient else { return }
		do {
			try await apiClient.resetPersonalization()
			await loadPersonalization()
			await load(section: .forYou, force: true)
		} catch {
			errorMessage = error.localizedDescription
		}
	}

	func configurePlatformServices() {
		let background = BackgroundRefreshManager.shared
		background.refreshHandler = { [weak self] in
			guard let self else { return false }
			return await self.performBackgroundRefresh()
		}
		background.schedule()
		_ = ReaderNotificationManager.shared
		consumePendingFeedRequest()
	}

	func performBackgroundRefresh() async -> Bool {
		let background = BackgroundRefreshManager.shared
		guard BackgroundRefreshPolicy.shouldRefresh(
			pathIsSatisfied: background.pathIsSatisfied,
			isConstrained: background.pathIsConstrained,
			allowsLowDataMode: allowsLowDataBackgroundRefresh
		), session != nil else { return false }
		let cachedArticles: [Recommendation]
		if let accountID = session?.storageIdentity,
			let cached = try? await offlineStore.loadSnapshot(accountID: accountID) {
			cachedArticles = cached.articlesByCollection.values.flatMap { $0 }
		} else {
			cachedArticles = []
		}
		let knownIDs = BackgroundRefreshArticlePlanner.knownIDs(
			inMemory: articleCache.values.flatMap { $0 },
			cached: cachedArticles,
		)
		await prepareOfflineLibrary()
		guard Task.isCancelled == false, isOffline == false else { return false }
		let newlyArrived = BackgroundRefreshArticlePlanner.newArticles(
			knownIDs: knownIDs,
			current: articleCache.values.flatMap { $0 },
		)
		for article in newlyArrived.prefix(20) {
			await ReaderNotificationManager.shared.postNewArticle(article)
		}
		lastBackgroundRefreshAt = .now
		writeWidgetSnapshot()
		return true
	}

	func handleDeepLink(_ url: URL) async {
		guard let link = PigeonDeepLink(url: url) else { return }
		switch link {
		case .add(let url):
			pendingFeedRequest = PendingFeedRequest(url: url)
		case .feed(let id):
			if navigation.items.contains(where: { $0.kind == .feed && ($0.id == id || $0.streamID == id || $0.feedKey == id) }) == false {
				await prepareOfflineLibrary()
			}
			if let item = navigation.items.first(where: { $0.kind == .feed && ($0.id == id || $0.streamID == id || $0.feedKey == id) }) {
				select(item: item)
				await load(collection: item)
			}
		case .folder(let id):
			if navigation.folderItems.contains(where: { $0.id == id || $0.title == id || $0.streamID == id }) == false {
				await prepareOfflineLibrary()
			}
			if let item = navigation.folderItems.first(where: { $0.id == id || $0.title == id || $0.streamID == id }) {
				navigation.expandFolder(item.id)
				select(item: item)
				await load(collection: item)
			}
		case .article(let id):
			if article(withId: id) == nil { await prepareOfflineLibrary() }
			guard let article = article(withId: id) else { return }
			if let collectionID = articleCache.first(where: { $0.value.contains(where: { $0.id == article.id || $0.readerId == article.readerId }) })?.key {
				select(collectionID: collectionID)
			}
			select(article: article)
		}
	}

	func consumePendingFeedRequest() {
		if let url = PendingFeedStore.consume() {
			pendingFeedRequest = PendingFeedRequest(url: url)
		}
	}

	func handleNotificationAction(_ action: ReaderNotificationAction) async {
		let articleID: String
		switch action {
		case .open(let id), .markRead(let id), .star(let id): articleID = id
		}
		if article(withId: articleID) == nil { await prepareOfflineLibrary() }
		guard let article = article(withId: articleID) else { return }
		switch action {
		case .open:
			await handleDeepLink(PigeonDeepLink.article(articleID).url)
		case .markRead:
			await setRead(article, read: true)
		case .star:
			await setStarred(article, starred: true)
		}
		writeWidgetSnapshot()
	}

	func writeWidgetSnapshot() {
		let allArticles = Dictionary(
			articleCache.values.flatMap { $0 }.map { ($0.id, $0) },
			uniquingKeysWith: { first, _ in first },
		).values
		let recent = allArticles.sorted { $0.receivedAt > $1.receivedAt }.prefix(5).map(Self.widgetArticle)
		let forYou = (articleCache[ReaderSection.forYou.rawValue] ?? []).prefix(5).map(Self.widgetArticle)
		let snapshot = PigeonWidgetSnapshot(
			generatedAt: .now,
			unreadCount: navigation.item(withID: ReaderSection.unread.rawValue)?.unreadCount ?? allArticles.count(where: { $0.isRead == false }),
			starredCount: navigation.item(withID: ReaderSection.starred.rawValue)?.unreadCount ?? allArticles.count(where: \.isStarred),
			recent: Array(recent),
			forYou: Array(forYou),
		)
		snapshot.save()
		WidgetCenter.shared.reloadAllTimelines()
	}

	private static func widgetArticle(_ article: Recommendation) -> PigeonWidgetArticle {
		PigeonWidgetArticle(
			id: article.id,
			title: article.title,
			source: article.source,
			receivedAt: article.receivedAt,
			deepLink: PigeonDeepLink.article(article.id).url,
		)
	}

	func exportPersonalization() async -> String? {
		guard let apiClient else { return nil }
		do {
			return try await apiClient.exportPersonalization()
		} catch {
			errorMessage = error.localizedDescription
			return nil
		}
	}

	func saveToReader(_ destination: OutboundDestination) async throws -> ReadwiseSaveOutcome {
		try Task.checkCancellation()
		let key = destination.url.absoluteString
		guard inFlightReadwiseSaves.insert(key).inserted else {
			return .alreadyInFlight
		}
		defer { inFlightReadwiseSaves.remove(key) }

		try await readwiseAPIClient.save(url: destination.url)
		try Task.checkCancellation()
		return .saved
	}

	func readerMode(for feedID: String) -> ReaderMode {
		if let rawValue = restoredReaderModes[feedID], let mode = ReaderMode(rawValue: rawValue) {
			return mode
		}
		guard let session else { return .feedContent }
		return readerModeStore.mode(for: feedID, session: session)
	}

	func setReaderMode(_ mode: ReaderMode, for feedID: String) {
		guard let session else { return }
		restoredReaderModes[feedID] = mode.rawValue
		readerModeStore.setMode(mode, for: feedID, session: session)
		scheduleRestorationSave()
	}

	func articleScrollOffset(for articleID: String) -> Double {
		min(max(articleScrollOffsets[articleID] ?? 0, 0), 1)
	}

	func setArticleScrollOffset(_ offset: Double, for articleID: String) {
		let normalized = min(max(offset, 0), 1)
		guard abs((articleScrollOffsets[articleID] ?? 0) - normalized) >= 0.01 else { return }
		articleScrollOffsets[articleID] = normalized
		scheduleRestorationSave()
	}

	func prepareOfflineLibrary() async {
		guard offlineSynchronizationEnabled, session != nil, apiClient != nil else { return }
		if let offlinePreparationTask {
			await offlinePreparationTask.value
			return
		}

		let taskID = UUID()
		let task = Task { @MainActor [weak self] in
			guard let self else { return }
			await self.performOfflineLibraryPreparation()
		}
		offlinePreparationTaskID = taskID
		offlinePreparationTask = task
		await task.value
		if offlinePreparationTaskID == taskID {
			offlinePreparationTask = nil
			offlinePreparationTaskID = nil
		}
	}

	private func performOfflineLibraryPreparation() async {
		guard offlineSynchronizationEnabled, let session, let apiClient else { return }
		let accountID = session.storageIdentity
		let isInitialPreparation = preparedOfflineAccountID != accountID
		let preparationID = UUID()
		activeOfflinePreparationID = preparationID
		var preparationGeneration = libraryGeneration
		if preparedOfflineAccountID != accountID {
			resetInMemoryLibraryForAccountChange()
			// The account reset invalidates any prior preparation. Re-establish this
			// call's ownership after the reset before awaiting the snapshot.
			activeOfflinePreparationID = preparationID
			preparationGeneration = libraryGeneration
			do {
				let snapshot = try await offlineStore.loadSnapshot(accountID: accountID)
				guard isCurrentOfflinePreparation(
					accountID: accountID,
					preparationID: preparationID,
					generation: preparationGeneration,
				) else { return }
				applyCachedSnapshot(snapshot)
				preparationGeneration = libraryGeneration
				preparedOfflineAccountID = accountID
			} catch {
				guard isCurrentOfflinePreparation(
					accountID: accountID,
					preparationID: preparationID,
					generation: preparationGeneration,
				) else { return }
				errorMessage = error.localizedDescription
				return
			}
		}

		isSynchronizingOfflineLibrary = true
		defer {
			if activeOfflinePreparationID == preparationID {
				isSynchronizingOfflineLibrary = false
			}
		}
		do {
			_ = try await mutationReplayer.replay(accountID: accountID, apiClient: apiClient)
			guard isCurrentOfflinePreparation(
				accountID: accountID,
				preparationID: preparationID,
				generation: preparationGeneration,
			) else { return }
			let canUseIncrementalReload = try await synchronizeIncrementally(
				accountID: accountID,
				apiClient: apiClient,
				preparationID: preparationID,
			)
			guard isCurrentOfflinePreparation(accountID: accountID, preparationID: preparationID) else { return }
			preparationGeneration = libraryGeneration
			guard isCurrentOfflinePreparation(
				accountID: accountID,
				preparationID: preparationID,
				generation: preparationGeneration,
			) else { return }
			isOffline = false
			if isInitialPreparation,
				canUseIncrementalReload,
				selectedCollection.kind == .feed,
				cachedCollectionHasMissingBodies(selectedCollection.id) == false,
				hasCachedPaginationContinuation(selectedCollection.id) {
				deferredInitialFeedPaginationCollectionID = selectedCollection.id
			}
			if canUseIncrementalReload == false {
				await loadNavigation(force: true)
				guard isCurrentOfflinePreparation(
					accountID: accountID,
					preparationID: preparationID,
					generation: preparationGeneration,
				) else { return }
				await loadLibrary(force: true)
				guard isCurrentOfflinePreparation(
					accountID: accountID,
					preparationID: preparationID,
					generation: preparationGeneration,
				) else { return }
			}
			if canUseIncrementalReload == false
				|| (isInitialPreparation == false && selectedCollectionRequiresLivePageAfterSync) {
				await load(collection: selectedCollection, force: true)
				guard isCurrentOfflinePreparation(
					accountID: accountID,
					preparationID: preparationID,
					generation: preparationGeneration,
				) else { return }
			}
		} catch let error where isCancellation(error) {
			return
		} catch {
			guard isCurrentOfflinePreparation(
				accountID: accountID,
				preparationID: preparationID,
				generation: preparationGeneration,
			) else { return }
			if isConnectivityFailure(error) {
				isOffline = true
			} else {
				isOffline = false
				errorMessage = error.localizedDescription
			}
			if isConnectivityFailure(error),
				articleCache.isEmpty && navigation.items == ReaderNavigationState.initial.items {
				errorMessage = error.localizedDescription
			}
		}
		guard isCurrentOfflinePreparation(
			accountID: accountID,
			preparationID: preparationID,
			generation: preparationGeneration,
		) else { return }
		await refreshOfflineStorageStats(
			accountID: accountID,
			preparationID: preparationID,
			generation: preparationGeneration,
		)
	}

	func refreshOfflineStorageStats() async {
		guard let accountID = session?.storageIdentity else {
			offlineStorageStats = .empty
			return
		}
		let context = OperationContext(
			accountID: accountID,
			generation: libraryGeneration,
			preparationID: activeOfflinePreparationID,
		)
		do {
			let stats = try await offlineStore.storageStats(accountID: accountID)
			guard isCurrentOperation(context) else { return }
			offlineStorageStats = stats
		} catch {
			guard isCurrentOperation(context) else { return }
			errorMessage = error.localizedDescription
		}
	}

	private func refreshOfflineStorageStats(accountID: String, preparationID: UUID, generation: UUID) async {
		do {
			let stats = try await offlineStore.storageStats(accountID: accountID)
			guard isCurrentOfflinePreparation(
				accountID: accountID,
				preparationID: preparationID,
				generation: generation,
			) else { return }
			offlineStorageStats = stats
		} catch {
			guard isCurrentOfflinePreparation(
				accountID: accountID,
				preparationID: preparationID,
				generation: generation,
			) else { return }
			errorMessage = error.localizedDescription
		}
	}

	@discardableResult
	func cleanupOfflineBodies() async -> Int {
		guard let accountID = session?.storageIdentity else { return 0 }
		do {
			let count = try await offlineStore.cleanupReadBodies(accountID: accountID, keepingNewest: 200)
			applyCachedSnapshot(try await offlineStore.loadSnapshot(accountID: accountID))
			await refreshOfflineStorageStats()
			return count
		} catch {
			errorMessage = error.localizedDescription
			return 0
		}
	}

	func clearOfflineArticles() async {
		guard let accountID = session?.storageIdentity else { return }
		do {
			try await offlineStore.clearCachedArticles(accountID: accountID)
			articleCache = [:]
			selectedArticleIDs = [:]
			selectedArticleID = nil
			preferredCompactColumn = .content
			await refreshOfflineStorageStats()
			scheduleRestorationSave()
		} catch {
			errorMessage = error.localizedDescription
		}
	}

	func loadReaderView(from url: URL) async throws -> ReaderViewDocument {
		try await readerViewExtractor.extract(from: url)
	}

	func loadReaderView(for article: Recommendation) async throws -> ReaderViewDocument {
		var primaryError: Error?
		if let originalURL = article.safeOriginalURL {
			do {
				return try await readerViewExtractor.extract(from: originalURL)
			} catch is CancellationError {
				throw CancellationError()
			} catch {
				primaryError = error
			}
		}

		let feedHTML = article.html.trimmingCharacters(in: .whitespacesAndNewlines)
		if feedHTML.isEmpty == false {
			do {
				return try await readerViewExtractor.extract(
					html: feedHTML,
					title: article.title,
					baseURL: article.safeOriginalURL,
				)
			} catch is CancellationError {
				throw CancellationError()
			} catch {
				if primaryError == nil {
					primaryError = error
				}
			}
		}

		throw primaryError ?? ReaderViewError.extractionFailed
	}

	func select(section: ReaderSection) {
		select(collectionID: section.rawValue)
	}

	func select(item: ReaderNavigationItem) {
		if let parentID = item.parentID {
			navigation.expandFolder(parentID)
		}
		select(collectionID: item.id)
	}

	func toggleFolder(_ folder: ReaderNavigationItem) {
		navigation.toggleFolder(folder.id)
		scheduleRestorationSave()
	}

	func setNavigation(_ state: ReaderNavigationState, markAsLoaded: Bool = false) {
		let previousSelection = selectedNavigationID
		let previousCollection = navigation.item(withID: previousSelection)
			?? (temporarilyUnavailableSelectedCollection?.id == previousSelection
				? temporarilyUnavailableSelectedCollection
				: nil)
		var next = state
		next.preserveExpansion(from: navigation)
		navigation = next
		if markAsLoaded {
			hasLoadedNavigation = true
		}
		if navigation.item(withID: previousSelection) == nil {
			if let previousCollection {
				temporarilyUnavailableSelectedCollection = previousCollection
				reconcileCurrentArticleSelection()
			} else {
				temporarilyUnavailableSelectedCollection = nil
				select(section: firstEnabledSmartSection)
			}
		} else {
			temporarilyUnavailableSelectedCollection = nil
			reconcileSelectedSmartViewIfNeeded()
			reconcileCurrentArticleSelection()
		}
		scheduleRestorationSave()
	}

	private func select(collectionID: String) {
		let isReselectingOpenCollection = selectedNavigationID == collectionID && isReadingOpenArticle
		if selectedNavigationID != collectionID {
			temporarilyUnavailableSelectedCollection = nil
		}
		selectedNavigationID = collectionID
		if isReselectingOpenCollection == false {
			preferredCompactColumn = .content
		}
		reconcileSelection(for: collectionID)
		scheduleRestorationSave()
	}

	private func setSmartViewEnabled(_ enabled: Bool, for section: ReaderSection) {
		guard ReaderSmartViewStore.configurableSections.contains(section) else {
			return
		}
		let previousSections = enabledSmartViewSections
		smartViewStore.setEnabled(enabled, for: section)
		let updatedSections = smartViewStore.enabledSections
		guard previousSections != updatedSections else {
			return
		}
		enabledSmartViewSections = updatedSections

		if enabled == false, selectedNavigationID == section.rawValue {
			selectedArticleIDs[section.rawValue] = nil
			selectedArticleID = nil
			preferredCompactColumn = .content
			select(section: firstEnabledSmartSection)
		} else {
			scheduleRestorationSave()
		}
	}

	private var firstEnabledSmartSection: ReaderSection {
		ReaderSmartViewStore.configurableSections.first(where: enabledSmartViewSections.contains) ?? .forYou
	}

	private func reconcileSelectedSmartViewIfNeeded() {
		guard let selectedSection = ReaderSection(rawValue: selectedNavigationID),
			selectedSection != .unread,
			ReaderSmartViewStore.configurableSections.contains(selectedSection),
			enabledSmartViewSections.contains(selectedSection) == false else {
			return
		}

		selectedArticleIDs[selectedSection.rawValue] = nil
		selectedArticleID = nil
		preferredCompactColumn = .content
		select(section: firstEnabledSmartSection)
	}

	func select(article: Recommendation) {
		guard self.article(withId: article.id) != nil || searchResults.contains(where: { articlesMatch($0, article) }) else {
			return
		}
		selectedArticleID = article.id
		selectedArticleIDs[selectedNavigationID] = article.id
		preferredCompactColumn = .detail
		scheduleRestorationSave()
	}

	/// Returns the compact column from the article to the feed list.
	///
	/// NavigationSplitView on iPhone restores `.detail` without a poppable
	/// stack, so the system back button and interactive pop gesture do nothing.
	/// Views must call this instead of relying on the hidden system back item.
	func showFeedColumn() {
		preferredCompactColumn = .content
	}

	func loadNavigation(
		force: Bool = false,
		now: Date = .now,
		dayBounds: ReaderLocalDayBounds? = nil,
	) async {
		guard let apiClient, let context = operationContext(for: apiClient) else {
			return
		}
		if force == false, hasLoadedNavigation {
			return
		}

		let loadID = UUID()
		activeNavigationLoadID = loadID
		activeNavigationLoadIDs.insert(loadID)
		isLoadingNavigation = true
		defer {
			activeNavigationLoadIDs.remove(loadID)
			if activeNavigationLoadID == loadID {
				activeNavigationLoadID = nil
			}
			isLoadingNavigation = activeNavigationLoadIDs.isEmpty == false
		}

		do {
			let snapshot = try await apiClient.navigationSnapshot(now: now, dayBounds: dayBounds)
			try Task.checkCancellation()
			guard isCurrentOperation(context), activeNavigationLoadID == loadID else {
				return
			}
			isOffline = false
			let previousTodayCount = navigation.item(withID: ReaderSection.today.rawValue)?.unreadCount ?? 0
			let previousStarredCount = navigation.item(withID: ReaderSection.starred.rawValue)?.unreadCount ?? 0
			// For You is the complete bounded recommendation collection returned by the existing
			// endpoint. Its trailing count covers every currently displayed unread recommendation,
			// rather than a server-wide proxy or an arbitrary first-page count.
			let forYouCount = articleCache[ReaderSection.forYou.rawValue]?.count(where: { $0.isRead == false }) ?? 0
			let state = ReaderNavigationCatalog.make(
				subscriptions: snapshot.subscriptions,
				unreadCounts: snapshot.unreadCounts,
				smartCounts: ReaderNavigationSmartCounts(
					forYou: forYouCount,
					today: snapshot.todayUnreadCount ?? previousTodayCount,
					unread: snapshot.unreadCounts.first(where: { $0.id == "user/-/state/com.google/reading-list" })?.count ?? 0,
					starred: snapshot.starredUnreadCount ?? previousStarredCount,
				),
			)
			setNavigation(state, markAsLoaded: true)
			try await offlineStore.saveNavigation(state, accountID: context.accountID)
			guard isCurrentOperation(context), activeNavigationLoadID == loadID else {
				return
			}
		} catch let error where isCancellation(error) {
			return
		} catch {
			guard isCurrentOperation(context), activeNavigationLoadID == loadID else {
				return
			}
			if session != nil {
				errorMessage = error.localizedDescription
			}
		}
	}

	func refresh(collection: ReaderNavigationItem) async {
		if offlineSynchronizationEnabled,
			session != nil,
			collection.id == selectedCollection.id {
			await prepareOfflineLibrary()
			return
		}
		await load(collection: collection, force: true)
		if hasLoadedNavigation {
			await loadNavigation(force: true)
		}
	}

	func load(section: ReaderSection, force: Bool = false) async {
		await load(collection: .smart(section), force: force)
	}

	func load(collection: ReaderNavigationItem, force: Bool = false) async {
		if force == false,
			offlineSynchronizationEnabled,
			let session,
			preparedOfflineAccountID != session.storageIdentity {
			await prepareOfflineLibrary()
			let defersPaginationResolution = consumeDeferredInitialFeedPagination(for: collection)
			if defersPaginationResolution == false,
				articleCache[collection.id] == nil
					|| collection.smartSection?.usesRecommendationEndpoint == true
					|| collection.kind == .feed && cachedCollectionHasMissingBodies(collection.id)
					|| shouldResolveCachedPagination(for: collection) {
				await load(collection: collection, force: true)
			}
			return
		}
		guard let apiClient, let context = operationContext(for: apiClient) else {
			return
		}
		if force == false, articleCache[collection.id] != nil {
			let defersPaginationResolution = consumeDeferredInitialFeedPagination(for: collection)
			if defersPaginationResolution == false,
				collection.smartSection?.usesRecommendationEndpoint == true
					|| collection.kind == .feed && cachedCollectionHasMissingBodies(collection.id)
					|| shouldResolveCachedPagination(for: collection) {
				await load(collection: collection, force: true)
			}
			return
		}
		invalidateLoadMore(for: collection.id)

		let loadID = UUID()
		activeLoadIDs[collection.id] = loadID
		loadingCollections.insert(collection.id)
		if selectedNavigationID == collection.id {
			errorMessage = nil
		}

		defer {
			if activeLoadIDs[collection.id] == loadID {
				activeLoadIDs[collection.id] = nil
				loadingCollections.remove(collection.id)
			}
		}

		do {
			let page: ReaderRecommendationsPage
			let dayBounds: ReaderLocalDayBounds?
			if let section = collection.smartSection, section.usesRecommendationEndpoint {
				page = ReaderRecommendationsPage(
					items: try await apiClient.recommendations(for: section),
					continuation: nil,
				)
				dayBounds = nil
			} else if collection.smartSection == .today {
				let todayBounds = ReaderLocalDayBounds.localDay(containing: .now)
				page = try await apiClient.recommendationsPage(
					from: "user/-/state/com.google/reading-list",
					dayBounds: todayBounds,
					cachedRecommendations: articleCache[collection.id] ?? [],
				)
				dayBounds = todayBounds
			} else {
				page = try await apiClient.recommendationsPage(
					from: collection.streamID,
					cachedRecommendations: articleCache[collection.id] ?? [],
				)
				dayBounds = nil
			}
			try Task.checkCancellation()
			guard isCurrentOperation(context), activeLoadIDs[collection.id] == loadID else {
				return
			}
			isOffline = false
			let loadedArticles = page.items
			let nextNavigation = navigationAfterLoading(collection: collection, articles: loadedArticles)
			let existingArticles = articleCache[collection.id] ?? []
			let reusesUnchangedPersistedPage = collection.smartSection?.usesRecommendationEndpoint != true
				&& page.fetchedContentCount == 0
				&& existingArticles.count == loadedArticles.count
				&& zip(existingArticles, loadedArticles).allSatisfy { pair in
					articlesMatch(pair.0, pair.1)
				}
				guard await persistCollectionState(
					loadedArticles,
					collectionID: collection.id,
					navigation: nextNavigation,
					continuation: page.continuation,
					context: context,
					operationID: loadID,
					isLoadMore: false,
					persistArticles: reusesUnchangedPersistedPage == false,
				) else {
					return
				}
			try Task.checkCancellation()
			guard isCurrentOperation(context), activeLoadIDs[collection.id] == loadID else {
				return
			}
			resetStreamPagination(for: collection.id)
			streamDayBounds[collection.id] = dayBounds
			seenStreamContinuations[collection.id] = page.continuation.map { [$0] } ?? []
			streamContinuations[collection.id] = page.continuation
			setArticles(loadedArticles, for: collection.id)
			collectionFreshness[collection.id] = CollectionFreshness(updatedAt: .now, isCached: false)
			if collection.smartSection == .forYou || collection.smartSection == .today {
				updateNavigationCount(for: collection.id, to: loadedArticles.count(where: { $0.isRead == false }))
			}
			if isPaginatedCollection(collection) {
				resolvedPaginationCollections.insert(collection.id)
			}
			if reusesUnchangedPersistedPage == false {
				writeWidgetSnapshot()
			}
		} catch let error where isCancellation(error) {
			return
		} catch {
			guard isCurrentOperation(context), activeLoadIDs[collection.id] == loadID, selectedNavigationID == collection.id else {
				return
			}
			errorMessage = error.localizedDescription
		}
	}

	func loadMore(collection: ReaderNavigationItem) async {
		guard let apiClient,
			let context = operationContext(for: apiClient),
			let continuation = streamContinuations[collection.id],
			activeLoadIDs[collection.id] == nil,
			activeLoadMoreIDs[collection.id] == nil else {
			return
		}

		let loadID = UUID()
		activeLoadMoreIDs[collection.id] = loadID
		loadingMoreCollections.insert(collection.id)
		loadMoreErrors[collection.id] = nil

		defer {
			if activeLoadMoreIDs[collection.id] == loadID {
				activeLoadMoreIDs[collection.id] = nil
				loadingMoreCollections.remove(collection.id)
			}
		}

		do {
			let page: ReaderRecommendationsPage
			if collection.smartSection == .today {
				let dayBounds = streamDayBounds[collection.id] ?? ReaderLocalDayBounds.localDay(containing: .now)
				page = try await apiClient.recommendationsPage(
					from: "user/-/state/com.google/reading-list",
					dayBounds: dayBounds,
					continuation: continuation,
					cachedRecommendations: articleCache[collection.id] ?? [],
				)
			} else if collection.smartSection == nil {
				page = try await apiClient.recommendationsPage(
					from: collection.streamID,
					continuation: continuation,
					cachedRecommendations: articleCache[collection.id] ?? [],
				)
			} else {
				streamContinuations[collection.id] = nil
				return
			}
			try Task.checkCancellation()
			guard isCurrentOperation(context), activeLoadMoreIDs[collection.id] == loadID, activeLoadIDs[collection.id] == nil else {
				return
			}
			isOffline = false

			var combinedArticles = articleCache[collection.id] ?? []
			for article in page.items where combinedArticles.contains(where: { articlesMatch($0, article) }) == false {
				combinedArticles.append(article)
			}
			combinedArticles = sortOrder(for: collection.id).sorted(combinedArticles)
			let nextSeenContinuations: Set<String>
			let nextStreamContinuation: String?
			if let nextContinuation = page.continuation,
				nextContinuation != continuation,
				seenStreamContinuations[collection.id, default: []].contains(nextContinuation) == false {
				var seen = seenStreamContinuations[collection.id, default: []]
				seen.insert(nextContinuation)
				nextSeenContinuations = seen
				nextStreamContinuation = nextContinuation
			} else {
				// A missing or repeated token is an end marker. Never retry the same page forever.
				nextSeenContinuations = seenStreamContinuations[collection.id, default: []]
				nextStreamContinuation = nil
			}
			let nextNavigation = navigationAfterLoading(collection: collection, articles: combinedArticles)
			guard await persistCollectionState(
				combinedArticles,
				collectionID: collection.id,
				navigation: nextNavigation,
				continuation: nextStreamContinuation,
				context: context,
				operationID: loadID,
				isLoadMore: true,
			) else {
				return
			}
			try Task.checkCancellation()
			guard isCurrentOperation(context), activeLoadMoreIDs[collection.id] == loadID, activeLoadIDs[collection.id] == nil else {
				return
			}
			setArticles(combinedArticles, for: collection.id)
			seenStreamContinuations[collection.id] = nextSeenContinuations
			streamContinuations[collection.id] = nextStreamContinuation
			if collection.smartSection == .today {
				updateNavigationCount(for: collection.id, to: combinedArticles.count(where: { $0.isRead == false }))
			}
			writeWidgetSnapshot()
		} catch let error where isCancellation(error) {
			return
		} catch {
			guard isCurrentOperation(context), activeLoadMoreIDs[collection.id] == loadID else {
				return
			}
			loadMoreErrors[collection.id] = error.localizedDescription
		}
	}

	func loadLibrary(force: Bool = false) async {
		guard let apiClient, let context = operationContext(for: apiClient) else {
			return
		}
		if force == false, subscriptions.isEmpty == false {
			return
		}

		let loadID = UUID()
		activeLibraryLoadID = loadID
		isLoadingLibrary = true
		defer {
			if activeLibraryLoadID == loadID {
				activeLibraryLoadID = nil
				isLoadingLibrary = false
			}
		}

		do {
			let loaded = try await apiClient.subscriptions()
			try Task.checkCancellation()
			guard isCurrentOperation(context), activeLibraryLoadID == loadID else {
				return
			}
			isOffline = false
			setSubscriptions(loaded)
			restoreNavigationFromSubscriptionsIfNeeded()
			try await offlineStore.saveSubscriptions(loaded, accountID: context.accountID)
			guard isCurrentOperation(context), activeLibraryLoadID == loadID else {
				return
			}
		} catch let error where isCancellation(error) {
			return
		} catch {
			guard isCurrentOperation(context), activeLibraryLoadID == loadID else {
				return
			}
			errorMessage = error.localizedDescription
		}
	}

	private func restoreNavigationFromSubscriptionsIfNeeded() {
		guard subscriptions.isEmpty == false,
			navigation.folderItems.isEmpty,
			navigation.uncategorizedFeedItems.isEmpty else {
			return
		}

		let readerSubscriptions = subscriptions.map { subscription in
			ReaderSubscription(
				id: subscription.id,
				title: subscription.title,
				categories: subscription.categories.map { category in
					ReaderSubscriptionCategory(id: category.id, label: category.label)
				},
				url: subscription.url.absoluteString,
				iconURL: subscription.iconUrl,
			)
		}
		let smartCounts = ReaderNavigationSmartCounts(
			forYou: navigation.item(withID: ReaderSection.forYou.rawValue)?.unreadCount ?? 0,
			today: navigation.item(withID: ReaderSection.today.rawValue)?.unreadCount ?? 0,
			unread: navigation.item(withID: ReaderSection.unread.rawValue)?.unreadCount ?? 0,
			starred: navigation.item(withID: ReaderSection.starred.rawValue)?.unreadCount ?? 0,
		)
		setNavigation(
			ReaderNavigationCatalog.make(
				subscriptions: readerSubscriptions,
				unreadCounts: [],
				smartCounts: smartCounts,
			),
			markAsLoaded: true,
		)
	}

	func setSubscriptions(_ newSubscriptions: [FeedSubscription]) {
		subscriptions = sortedSubscriptions(newSubscriptions)
	}

	@discardableResult
	func addFeed(urlText: String, folderName: String?) async -> Bool {
		guard let apiClient else {
			return false
		}
		let trimmedURL = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
		guard let url = URL(string: trimmedURL), let scheme = url.scheme?.lowercased(),
			scheme == "http" || scheme == "https", url.host != nil else {
			errorMessage = "Enter a complete HTTP or HTTPS feed URL."
			return false
		}

		do {
			let result = try await apiClient.addSubscription(url: url)
			if let folder = normalizedFolderName(folderName) {
				try await apiClient.editSubscription(id: result.streamId, addingFolders: [folder])
			}
			await loadLibrary(force: true)
			if hasLoadedNavigation {
				await loadNavigation(force: true)
			}
			return true
		} catch let error where isCancellation(error) {
			return false
		} catch {
			errorMessage = error.localizedDescription
			await loadLibrary(force: true)
			return false
		}
	}

	func importOPML(_ preview: OPMLImportPreview) async throws -> OPMLImportResult {
		guard let apiClient else { throw PigeonError.authenticationFailed }
		let result = try await OPMLImportCoordinator.importPreview(preview, service: apiClient)
		await loadLibrary(force: true)
		await loadNavigation(force: true)
		return result
	}

	func loadStaleFeeds(days: Int = 90) async {
		guard let apiClient else { return }
		isLoadingStaleFeeds = true
		defer { isLoadingStaleFeeds = false }
		do {
			staleFeedSnapshot = try await apiClient.staleFeeds(days: days)
		} catch let error where isCancellation(error) {
			return
		} catch {
			errorMessage = error.localizedDescription
		}
	}

	func archiveStaleFeeds(_ feeds: [StaleFeed]) async -> Bool {
		guard let apiClient, feeds.isEmpty == false else { return false }
		let keys = feeds.map(\.feedKey)
		do {
			try await apiClient.setStaleFeedsArchived(keys, action: .archive)
			staleFeedUndo = .archive(keys)
			staleFeedUndoTitle = keys.count == 1 ? "Undo Archive" : "Undo Archive \(keys.count) Feeds"
			await loadStaleFeeds()
			return true
		} catch {
			errorMessage = error.localizedDescription
			return false
		}
	}

	func unarchiveStaleFeeds(_ feeds: [StaleFeed]) async -> Bool {
		guard let apiClient, feeds.isEmpty == false else { return false }
		let keys = feeds.map(\.feedKey)
		do {
			try await apiClient.setStaleFeedsArchived(keys, action: .unarchive)
			staleFeedUndo = .unarchive(keys)
			staleFeedUndoTitle = keys.count == 1 ? "Undo Restore" : "Undo Restore \(keys.count) Feeds"
			await loadStaleFeeds()
			return true
		} catch {
			errorMessage = error.localizedDescription
			return false
		}
	}

	func unsubscribeStaleFeeds(_ feeds: [StaleFeed]) async -> Bool {
		let selectedIDs = Set(feeds.map(\.streamId))
		let selectedKeys = Set(feeds.map(\.feedKey))
		let removed = subscriptions.filter { selectedIDs.contains($0.id) || selectedKeys.contains($0.feedKey) }
		guard removed.isEmpty == false else { return false }
		for subscription in removed {
			guard await enqueueOfflineMutation(OfflineMutation(kind: .unsubscribeFeed, feedId: subscription.id)) else { return false }
		}
		subscriptions.removeAll { subscription in
			removed.contains(where: { $0.id == subscription.id })
		}
		if let accountID = session?.storageIdentity {
			try? await offlineStore.saveSubscriptions(subscriptions, accountID: accountID)
		}
		staleFeedUndo = .unsubscribe(removed)
		staleFeedUndoTitle = removed.count == 1 ? "Undo Unsubscribe" : "Undo Unsubscribe \(removed.count) Feeds"
		await replayPendingMutations()
		await loadNavigation(force: true)
		await loadStaleFeeds()
		return true
	}

	func undoStaleFeedAction() async {
		guard let apiClient, let undo = staleFeedUndo else { return }
		switch undo {
		case .archive(let keys):
			do {
				try await apiClient.setStaleFeedsArchived(keys, action: .unarchive)
			} catch {
				errorMessage = error.localizedDescription
				return
			}
		case .unarchive(let keys):
			do {
				try await apiClient.setStaleFeedsArchived(keys, action: .archive)
			} catch {
				errorMessage = error.localizedDescription
				return
			}
		case .unsubscribe(let removed):
			for subscription in removed {
				guard await enqueueOfflineMutation(OfflineMutation(kind: .restoreFeed, feedId: subscription.id)) else { return }
			}
			setSubscriptions(subscriptions + removed)
			if let accountID = session?.storageIdentity {
				try? await offlineStore.saveSubscriptions(subscriptions, accountID: accountID)
			}
			await replayPendingMutations()
			await loadNavigation(force: true)
		}
		staleFeedUndo = nil
		staleFeedUndoTitle = nil
		await loadStaleFeeds()
	}

	@discardableResult
	func renameFeed(_ subscription: FeedSubscription, to newTitle: String) async -> Bool {
		let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
		guard title.isEmpty == false, title.count <= 200 else {
			errorMessage = "Feed names must be between 1 and 200 characters."
			return false
		}
		let mutation = OfflineMutation(kind: .renameFeed, feedId: subscription.id, title: title)
		guard await enqueueOfflineMutation(mutation) else { return false }
		updateSubscription(id: subscription.id) { $0.title = title }
		if let accountID = session?.storageIdentity {
			try? await offlineStore.saveSubscriptions(subscriptions, accountID: accountID)
		}
		await replayPendingMutations()
		return true
	}

	@discardableResult
	func moveFeed(_ subscription: FeedSubscription, toFolderNames folderNames: [String]) async -> Bool {
		guard let normalizedFolders = normalizedFolderNames(folderNames) else {
			errorMessage = "Folder names must be between 1 and 80 characters."
			return false
		}
		let mutation = OfflineMutation(
			kind: .moveFeed,
			feedId: subscription.id,
			folders: normalizedFolders,
		)
		guard await enqueueOfflineMutation(mutation) else { return false }
		updateSubscription(id: subscription.id) { item in
			item.categories = normalizedFolders.map {
				FeedCategory(id: "user/-/label/\($0)", label: $0)
			}
		}
		rebuildNavigationFromSubscriptions()
		if let accountID = session?.storageIdentity {
			do {
				try await offlineStore.saveSubscriptions(subscriptions, accountID: accountID)
				try await offlineStore.saveNavigation(navigation, accountID: accountID)
			} catch {
				errorMessage = "Your folder change is queued, but Pigeon could not update its saved library. \(error.localizedDescription)"
			}
		}
		await replayPendingMutations()
		return true
	}

	@discardableResult
	func unsubscribe(_ subscription: FeedSubscription) async -> Bool {
		let mutation = OfflineMutation(kind: .unsubscribeFeed, feedId: subscription.id)
		guard await enqueueOfflineMutation(mutation) else { return false }
		subscriptions.removeAll { $0.id == subscription.id }
		if let accountID = session?.storageIdentity {
			try? await offlineStore.saveSubscriptions(subscriptions, accountID: accountID)
		}
		await replayPendingMutations()
		return true
	}

	@discardableResult
	func renameFolder(_ oldName: String, to newName: String) async -> Bool {
		guard let name = normalizedFolderName(newName) else {
			errorMessage = "Folder names must be between 1 and 80 characters."
			return false
		}
		guard name != oldName else {
			return true
		}
		guard folders.contains(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) == false else {
			errorMessage = "A folder with that name already exists."
			return false
		}
		let affected = subscriptions.filter { $0.folderNames.contains(oldName) }
		for subscription in affected {
			let folders = subscription.folderNames.map { $0 == oldName ? name : $0 }
			guard await enqueueOfflineMutation(
				OfflineMutation(kind: .moveFeed, feedId: subscription.id, folders: folders)
			) else { return false }
		}
		applyFolderRename(from: oldName, to: name)
		if let accountID = session?.storageIdentity {
			try? await offlineStore.saveSubscriptions(subscriptions, accountID: accountID)
		}
		await replayPendingMutations()
		return true
	}

	@discardableResult
	func deleteFolder(_ name: String) async -> Bool {
		let affected = subscriptions.filter { $0.folderNames.contains(name) }
		for subscription in affected {
			guard await enqueueOfflineMutation(
				OfflineMutation(
					kind: .moveFeed,
					feedId: subscription.id,
					folders: subscription.folderNames.filter { $0 != name },
				)
			) else { return false }
		}
		for subscription in affected {
			updateSubscription(id: subscription.id) { item in
				item.categories.removeAll { $0.label == name }
			}
		}

		if let accountID = session?.storageIdentity {
			try? await offlineStore.saveSubscriptions(subscriptions, accountID: accountID)
		}
		await replayPendingMutations()
		return true
	}

	func articles(for section: ReaderSection) -> [Recommendation] {
		displayedArticles(for: section.rawValue)
	}

	func articles(for collection: ReaderNavigationItem) -> [Recommendation] {
		displayedArticles(for: collection.id)
	}

	func allArticles(for section: ReaderSection) -> [Recommendation] {
		articleCache[section.rawValue] ?? []
	}

	func allArticles(for collection: ReaderNavigationItem) -> [Recommendation] {
		articleCache[collection.id] ?? []
	}

	func isArticleFilterEmpty(for collection: ReaderNavigationItem) -> Bool {
		articleFilter(for: collection.id) != .all
			&& allArticles(for: collection).isEmpty == false
			&& articles(for: collection).isEmpty
	}

	func articleFilter(for section: ReaderSection) -> ReaderArticleFilter {
		articleFilter(for: section.rawValue)
	}

	func articleFilter(for collection: ReaderNavigationItem) -> ReaderArticleFilter {
		articleFilter(for: collection.id)
	}

	func setArticleFilter(_ filter: ReaderArticleFilter, for section: ReaderSection) {
		setArticleFilter(filter, for: section.rawValue)
	}

	func setArticleFilter(_ filter: ReaderArticleFilter, for collection: ReaderNavigationItem) {
		setArticleFilter(filter, for: collection.id)
	}

	func sortOrder(for section: ReaderSection) -> ArticleSortOrder {
		sortOrder(for: section.rawValue)
	}

	func sortOrder(for collection: ReaderNavigationItem) -> ArticleSortOrder {
		sortOrder(for: collection.id)
	}

	func setSortOrder(_ newSortOrder: ArticleSortOrder, for section: ReaderSection) {
		setSortOrder(newSortOrder, for: section.rawValue)
	}

	func setSortOrder(_ newSortOrder: ArticleSortOrder, for collection: ReaderNavigationItem) {
		setSortOrder(newSortOrder, for: collection.id)
	}

	private func sortOrder(for collectionID: String) -> ArticleSortOrder {
		sortOrders[collectionID] ?? (ReaderSection(rawValue: collectionID).map(ArticleSortOrder.defaultOrder) ?? .newest)
	}

	private func setSortOrder(_ newSortOrder: ArticleSortOrder, for collectionID: String) {
		guard sortOrder(for: collectionID) != newSortOrder else {
			return
		}
		sortOrders[collectionID] = newSortOrder
		if let cachedArticles = articleCache[collectionID] {
			articleCache[collectionID] = newSortOrder.sorted(cachedArticles)
		}
		scheduleRestorationSave()
	}

	func setArticles(_ newArticles: [Recommendation], for section: ReaderSection) {
		setArticles(newArticles, for: section.rawValue)
	}

	func setArticles(_ newArticles: [Recommendation], for collection: ReaderNavigationItem) {
		setArticles(newArticles, for: collection.id)
	}

	private func setArticles(_ newArticles: [Recommendation], for collectionID: String) {
		let previouslySelectedArticle = selectedArticleIDs[collectionID].flatMap { rememberedID in
			articleCache[collectionID]?.first(where: { $0.id == rememberedID || $0.readerId == rememberedID })
		}
		let sortedArticles = sortOrder(for: collectionID).sorted(
			articlesPreservingOpenSelection(newArticles, for: collectionID),
		)
		articleCache[collectionID] = sortedArticles
		if let previouslySelectedArticle,
			let refreshedSelectedArticle = sortedArticles.first(where: { articlesMatch($0, previouslySelectedArticle) }) {
			selectedArticleIDs[collectionID] = refreshedSelectedArticle.id
		}
		reconcileSelection(for: collectionID)
	}

	private func articlesPreservingOpenSelection(
		_ incomingArticles: [Recommendation],
		for collectionID: String,
	) -> [Recommendation] {
		guard
			selectedNavigationID == collectionID,
			let selectedArticleID,
			let activeArticle = articleCache[collectionID]?.first(where: { $0.id == selectedArticleID }),
			incomingArticles.contains(where: { articlesMatch($0, activeArticle) }) == false
		else {
			return incomingArticles
		}

		return incomingArticles + [activeArticle]
	}

	private func articleFilter(for collectionID: String) -> ReaderArticleFilter {
		guard let session else {
			return ReaderArticleFilterStore.defaultFilter(for: collectionID)
		}
		let key = ArticleFilterKey(sessionIdentity: session.articleFilterStorageIdentity, collectionID: collectionID)
		return articleFilters[key] ?? articleFilterStore.filter(for: collectionID, session: session)
	}

	private func setArticleFilter(_ filter: ReaderArticleFilter, for collectionID: String) {
		guard let session else {
			return
		}
		let key = ArticleFilterKey(sessionIdentity: session.articleFilterStorageIdentity, collectionID: collectionID)
		guard articleFilter(for: collectionID) != filter else {
			return
		}
		articleFilters[key] = filter
		articleFilterStore.setFilter(filter, for: collectionID, session: session)
		reconcileSelection(for: collectionID)
		scheduleRestorationSave()
	}

	private func displayedArticles(for collectionID: String) -> [Recommendation] {
		articleFilter(for: collectionID).filtering(articleCache[collectionID] ?? [])
	}

	private func reconcileSelection(for collectionID: String) {
		guard let rememberedID = selectedArticleIDs[collectionID] else {
			if selectedNavigationID == collectionID {
				selectedArticleID = nil
				if preferredCompactColumn == .detail {
					preferredCompactColumn = .content
				}
			}
			return
		}

		if let cached = articleCache[collectionID]?.first(where: { $0.id == rememberedID || $0.readerId == rememberedID }) {
			guard selectedNavigationID == collectionID else {
				return
			}
			selectedArticleID = cached.id
			selectedArticleIDs[collectionID] = cached.id
			return
		}

		// Unread/Today membership and first-page refreshes can drop the open row
		// from this collection while the story is still in memory. Keep reading.
		if isReadingOpenArticle,
			selectedNavigationID == collectionID,
			let found = article(withId: rememberedID) {
			let kept = preserveOpenArticle(found, in: collectionID)
			selectedArticleID = kept.id
			selectedArticleIDs[collectionID] = kept.id
			return
		}

		selectedArticleIDs[collectionID] = nil
		if selectedNavigationID == collectionID {
			selectedArticleID = nil
			preferredCompactColumn = .content
		}
	}

	private func reconcileCurrentArticleSelection() {
		reconcileSelection(for: selectedNavigationID)
	}

	private func updateNavigationCount(for itemID: String, to count: Int) {
		navigation = navigation.replacingCount(for: itemID, with: count)
	}

	private func navigationCountDeltas(for article: Recommendation, fromRead: Bool, toRead: Bool) -> [String: Int] {
		guard fromRead != toRead else {
			return [:]
		}
		let delta = toRead ? -1 : 1
		let todayBounds = ReaderLocalDayBounds.localDay(containing: .now)
		var deltas: [String: Int] = [:]

		for item in navigation.items {
			let shouldAdjust: Bool
			switch item.kind {
			case .smart:
				switch item.smartSection {
				case .forYou:
					shouldAdjust = articleCache[item.id]?.contains(where: { articlesMatch($0, article) }) == true
				case .today:
					shouldAdjust = todayBounds.contains(article.receivedAt)
				case .unread:
					shouldAdjust = true
				case .starred:
					shouldAdjust = article.isStarred
				case nil:
					shouldAdjust = false
				}
			case .feed:
				shouldAdjust = feedItemContains(item, article: article)
			case .folder:
				shouldAdjust = navigation.children(of: item.id).contains { feedItemContains($0, article: article) }
			}

			if shouldAdjust {
				deltas[item.id] = delta
			}
		}

		return deltas
	}

	private func applyNavigationCountDeltas(_ deltas: [String: Int]) {
		guard deltas.isEmpty == false else {
			return
		}
		var nextNavigation = navigation
		for item in navigation.items {
			guard let delta = deltas[item.id] else {
				continue
			}
			nextNavigation = nextNavigation.replacingCount(for: item.id, with: item.unreadCount + delta)
		}
		navigation = nextNavigation
	}

	private func adjustNavigationCounts(for article: Recommendation, fromRead: Bool, toRead: Bool) {
		applyNavigationCountDeltas(navigationCountDeltas(for: article, fromRead: fromRead, toRead: toRead))
	}

	private func adjustStarredNavigationCount(for article: Recommendation, fromStarred: Bool, toStarred: Bool) {
		guard article.isRead == false, fromStarred != toStarred else {
			return
		}
		let delta = toStarred ? 1 : -1
		guard let starredItem = navigation.smartItems.first(where: { $0.smartSection == .starred }) else {
			return
		}
		navigation = navigation.replacingCount(for: starredItem.id, with: starredItem.unreadCount + delta)
	}

	private func feedItemContains(_ item: ReaderNavigationItem, article: Recommendation) -> Bool {
		item.feedKey == article.feedKey || item.streamID == article.feedKey || articleCache[item.id]?.contains(where: { articlesMatch($0, article) }) == true
	}

	private func articlesMatch(_ left: Recommendation, _ right: Recommendation) -> Bool {
		left.id == right.id || left.readerId == right.readerId
	}

	private func articleTarget(
		for direction: ReaderBoundaryNavigationDirection,
		from current: Recommendation?,
	) -> Recommendation? {
		guard let current else {
			return nil
		}
		let displayedArticles = articleNavigationArticles
		guard let currentIndex = displayedArticles.firstIndex(where: { articlesMatch($0, current) }),
			let targetIndex = ReaderBoundaryNavigation.targetIndex(
				currentIndex: currentIndex,
				count: displayedArticles.count,
				direction: direction,
			),
			displayedArticles.indices.contains(targetIndex) else {
			return nil
		}
		return displayedArticles[targetIndex]
	}

	private var articleNavigationArticles: [Recommendation] {
		activeSearchScope == nil ? articles : searchResults
	}

	func article(withId id: String) -> Recommendation? {
		if let current = articles.first(where: { $0.id == id || $0.readerId == id }) {
			return current
		}
		for cachedArticles in articleCache.values {
			if let article = cachedArticles.first(where: { $0.id == id || $0.readerId == id }) {
				return article
			}
		}
		if let result = searchResults.first(where: { $0.id == id || $0.readerId == id }) {
			return result
		}
		return nil
	}

	func searchArticles(
		query: String,
		scope: ReaderSearchScope,
		in collection: ReaderNavigationItem,
	) async {
		let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
		guard trimmed.isEmpty == false, let accountID = session?.storageIdentity else {
			clearArticleSearch()
			return
		}

		let searchID = UUID()
		activeSearchID = searchID
		activeSearchScope = scope
		activeSearchCollectionID = collection.id
		isSearchingArticles = true
		defer {
			if activeSearchID == searchID { isSearchingArticles = false }
		}
		do {
			let results = try await offlineStore.searchArticles(
				query: trimmed,
				collectionID: scope == .collection ? collection.id : nil,
				accountID: accountID,
				limit: 200,
			)
			try Task.checkCancellation()
			guard activeSearchID == searchID else { return }
			searchResults = sortOrder.sorted(results)
		} catch let error where isCancellation(error) {
			return
		} catch {
			guard activeSearchID == searchID else { return }
			errorMessage = error.localizedDescription
			searchResults = []
		}
	}

	func clearArticleSearch() {
		activeSearchID = nil
		activeSearchScope = nil
		activeSearchCollectionID = nil
		searchResults = []
		isSearchingArticles = false
	}

	func collectionStatusText(for collection: ReaderNavigationItem) -> String {
		guard let freshness = collectionFreshness[collection.id] else {
			return isOffline ? "Cached · not yet updated" : "Not yet updated"
		}
		let age = freshness.updatedAt.formatted(.relative(presentation: .named, unitsStyle: .wide))
		let source = freshness.isCached || isOffline ? "Cached" : "Live"
		return "\(source) · updated \(age)"
	}

	@discardableResult
	func selectNextUnread(after article: Recommendation) -> Recommendation? {
		var seen = Set<String>()
		let ordered = articleCache.values
			.flatMap { $0 }
			.filter { seen.insert($0.readerId).inserted }
			.sorted {
				if $0.receivedAt != $1.receivedAt { return $0.receivedAt > $1.receivedAt }
				return $0.readerId < $1.readerId
			}
		guard ordered.isEmpty == false else { return nil }
		let currentIndex = ordered.firstIndex(where: { articlesMatch($0, article) }) ?? -1
		let following = ordered.dropFirst(currentIndex + 1)
		let earlier = ordered.prefix(max(currentIndex + 1, 0))
		let next = following.first(where: { $0.isRead == false })
			?? earlier.first(where: { $0.isRead == false && articlesMatch($0, article) == false })
		guard let next else { return nil }
		selectedArticleID = next.id
		selectedArticleIDs[selectedNavigationID] = next.id
		preferredCompactColumn = .detail
		scheduleRestorationSave()
		return next
	}

	func recordExplicitOpen(for article: Recommendation) async {
		sentScrollThresholds[article.id] = []
		await send(EngagementEvent(itemId: article.id, type: .explicitOpen))
		if readerTypography.markReadBehavior == .onOpen, !article.isRead {
			await setRead(article, read: true)
		}
	}

	func monitorActiveReading(for articleId: String) async {
		guard let apiClient, engagement.resume(itemId: articleId, at: .now) else {
			return
		}
		defer { engagement.pause(itemId: articleId, at: .now) }

		do {
			while !Task.isCancelled {
				try await Task.sleep(for: .seconds(15))
				try Task.checkCancellation()
				if let event = engagement.activeReadingDeltaEvent(itemId: articleId, at: .now) {
					try await apiClient.sendEngagement([event])
				}
			}
		} catch let error where isCancellation(error) {
			return
		} catch let error as PigeonError where error.isNonFatalEngagementFailure {
			return
		} catch {
			errorMessage = error.localizedDescription
		}
	}

	func recordScrollDepth(itemId: String, depth: Double) {
		if readerTypography.markReadBehavior == .onScroll,
			depth >= 0.6,
			scrollReadTriggered.insert(itemId).inserted,
			let article = article(withId: itemId),
			article.isRead == false {
			Task { @MainActor [weak self] in
				await self?.setRead(article, read: true)
			}
		}
		guard let threshold = engagement.updateScrollDepth(itemId: itemId, depth: depth), threshold > 0 else {
			return
		}
		guard sentScrollThresholds[itemId, default: []].insert(threshold).inserted else {
			return
		}
		let event = EngagementEvent(itemId: itemId, type: .scrollDepth, value: depth, scrollDepth: depth)
		Task { @MainActor [weak self] in
			await self?.send(event)
		}
	}

	func recordOutboundClick(itemId: String, destinationHost: String) async {
		await send(EngagementEvent(itemId: itemId, type: .outboundLink, destinationHost: destinationHost))
	}

	func setRead(_ article: Recommendation, read: Bool) async {
		await optimisticallyUpdateState(
			article: article,
			value: read,
			mutationName: "read",
			keyPath: \.isRead
		)
	}

	func markStoriesAboveAsRead(_ article: Recommendation, in collection: ReaderNavigationItem) async {
		await markStoriesAsRead(.above, around: article, in: collection)
	}

	func markStoriesBelowAsRead(_ article: Recommendation, in collection: ReaderNavigationItem) async {
		await markStoriesAsRead(.below, around: article, in: collection)
	}

	func markAllStoriesAsRead(in collection: ReaderNavigationItem) async {
		await markArticlesAsRead(
			articleCache[collection.id]?.filter { $0.isRead == false } ?? [],
			scope: .all,
			undoTitle: "Mark All as Read",
		)
	}

	func markStoriesOlderThan(_ date: Date, in collection: ReaderNavigationItem) async {
		await markArticlesAsRead(
			articleCache[collection.id]?.filter { $0.isRead == false && $0.receivedAt < date } ?? [],
			scope: .older,
			undoTitle: "Mark Older Stories as Read",
		)
	}

	func undoLastBulkRead() async {
		guard let undo = bulkReadUndo else { return }
		bulkReadUndo = nil
		bulkReadUndoTitle = nil
		await updateReadStateForArticles(undo.articles, read: false, scope: .single)
	}

	func setStarred(_ article: Recommendation, starred: Bool) async {
		await optimisticallyUpdateState(
			article: article,
			value: starred,
			mutationName: "starred",
			keyPath: \.isStarred
		)
	}

	func recordPreference(_ type: EngagementEventType, for article: Recommendation) async {
		guard type == .moreLikeThis || type == .notInterested else { return }
		let mutation = OfflineMutation(
			kind: .feedback,
			itemIds: [article.readerId],
			feedback: type.rawValue,
		)
		guard await enqueueOfflineMutation(mutation) else { return }
		guard type == .notInterested, selectedNavigationID == ReaderSection.forYou.rawValue else {
			await replayPendingMutations()
			return
		}

		let forYouID = ReaderSection.forYou.rawValue
		let previousItems = articleCache[forYouID] ?? []
		let removedArticle = previousItems.contains(where: { articlesMatch($0, article) })
		articleCache[forYouID]?.removeAll(where: { articlesMatch($0, article) })
		if removedArticle {
			let remainingUnread = articleCache[forYouID]?.count(where: { $0.isRead == false }) ?? 0
			updateNavigationCount(for: forYouID, to: remainingUnread)
		}
		if let selectedID = selectedArticleIDs[forYouID], previousItems.first(where: { $0.id == selectedID && articlesMatch($0, article) }) != nil {
			selectedArticleIDs[forYouID] = nil
			if selectedNavigationID == forYouID {
				selectedArticleID = nil
				preferredCompactColumn = .content
			}
		}
		await persistCollections([forYouID])
		await replayPendingMutations()
	}

	private func synchronizeIncrementally(
		accountID: String,
		apiClient: PigeonAPIClient,
		preparationID: UUID,
	) async throws -> Bool {
		var cursor = offlineSyncCursor
		let canUseIncrementalReload = cursor != nil && hasLoadedNavigation
		var seenCursors = Set<String>()
		var receivedChanges = false
		while true {
			try Task.checkCancellation()
			guard isCurrentOfflinePreparation(accountID: accountID, preparationID: preparationID) else { return false }
			let page = try await apiClient.incrementalSync(cursor: cursor)
			guard isCurrentOfflinePreparation(accountID: accountID, preparationID: preparationID) else { return false }
			guard seenCursors.insert(page.cursor).inserted || page.hasMore == false else {
				throw PigeonError.invalidResponse
			}
			try await offlineStore.apply(page, accountID: accountID)
			guard isCurrentOfflinePreparation(accountID: accountID, preparationID: preparationID) else { return false }
			receivedChanges = receivedChanges || page.changes.isEmpty == false
			cursor = page.cursor
			offlineSyncCursor = page.cursor
			if page.hasMore == false { break }
		}
		guard isCurrentOfflinePreparation(accountID: accountID, preparationID: preparationID) else { return false }
		guard receivedChanges else { return canUseIncrementalReload }
		_ = try? await offlineStore.cleanupReadBodies(accountID: accountID, keepingNewest: 500)
		guard isCurrentOfflinePreparation(accountID: accountID, preparationID: preparationID) else { return false }
		let snapshot = try await offlineStore.loadSnapshot(accountID: accountID)
		guard isCurrentOfflinePreparation(accountID: accountID, preparationID: preparationID) else { return false }
		applyCachedSnapshot(snapshot, preservingPagination: true)
		return canUseIncrementalReload
	}

	private var isReadingOpenArticle: Bool {
		preferredCompactColumn == .detail && selectedArticle != nil
	}

	@discardableResult
	private func preserveOpenArticle(_ article: Recommendation, in collectionID: String) -> Recommendation {
		if let existing = articleCache[collectionID]?.first(where: { articlesMatch($0, article) }) {
			return existing
		}
		var cached = articleCache[collectionID] ?? []
		cached.append(article)
		let sorted = sortOrder(for: collectionID).sorted(cached)
		articleCache[collectionID] = sorted
		return sorted.first(where: { articlesMatch($0, article) }) ?? article
	}

	private func applyCachedSnapshot(
		_ snapshot: CachedLibrarySnapshot,
		preservingPagination: Bool = false,
	) {
		guard let session else { return }
		offlineSyncCursor = snapshot.cursor
		let openArticle = selectedArticle
		let preserveOpenReader = preferredCompactColumn == .detail
			&& openArticle != nil
		let preservedNavigationID = selectedNavigationID
		let preservedSelectedArticleIDs = selectedArticleIDs
		let preservedCollection = navigation.item(withID: preservedNavigationID)
			?? (temporarilyUnavailableSelectedCollection?.id == preservedNavigationID
				? temporarilyUnavailableSelectedCollection
				: nil)

		libraryGeneration = UUID()
		if preservingPagination == false {
			resetStreamPagination()
			resolvedPaginationCollections.removeAll()
		}
		isApplyingRestoration = true
		defer { isApplyingRestoration = false }
		if let restoration = snapshot.restoration {
			sortOrders = restoration.sortOrders.reduce(into: [:]) { result, pair in
				if let order = ArticleSortOrder(rawValue: pair.value) { result[pair.key] = order }
			}
			articleFilters = restoration.articleFilters.reduce(into: [:]) { result, pair in
				if let filter = ReaderArticleFilter(rawValue: pair.value) {
					result[ArticleFilterKey(sessionIdentity: session.storageIdentity, collectionID: pair.key)] = filter
				}
			}
			if preserveOpenReader == false {
				selectedArticleIDs = restoration.selectedArticleIDs
				selectedNavigationID = restoration.selectedNavigationID
				temporarilyUnavailableSelectedCollection = nil
			}
			sidebarFilter = ReaderSidebarFilter(rawValue: restoration.sidebarFilter) ?? .all
			restoredReaderModes = restoration.readerModes
			articleScrollOffsets = restoration.articleScrollOffsets
			if hasAppliedCompactColumnRestoration == false {
				preferredCompactColumn = compactColumn(from: restoration.compactColumn)
				hasAppliedCompactColumnRestoration = true
			}
		}

		if let cachedNavigation = snapshot.navigation {
			var restoredNavigation = cachedNavigation
			if let restoration = snapshot.restoration {
				restoredNavigation.expandedFolderIDs = restoration.expandedFolderIDs
					.intersection(Set(restoredNavigation.folderItems.map(\.id)))
			}
			navigation = restoredNavigation
			hasLoadedNavigation = true
		} else {
			navigation = .initial
		}
		subscriptions = sortedSubscriptions(snapshot.subscriptions)
		restoreNavigationFromSubscriptionsIfNeeded()
		articleCache = snapshot.articlesByCollection.reduce(into: [:]) { result, pair in
			result[pair.key] = sortOrder(for: pair.key).sorted(pair.value)
		}
		for (collectionID, continuation) in snapshot.continuationsByCollection {
			guard preservingPagination == false || streamContinuations[collectionID] == nil else { continue }
			streamContinuations[collectionID] = continuation
			seenStreamContinuations[collectionID] = [continuation]
			resolvedPaginationCollections.insert(collectionID)
		}
		if let updatedAt = snapshot.lastSyncAt {
			collectionFreshness = snapshot.articlesByCollection.keys.reduce(into: [:]) { result, collectionID in
				result[collectionID] = CollectionFreshness(updatedAt: updatedAt, isCached: true)
			}
		}

		if preserveOpenReader, let openArticle {
			selectedNavigationID = preservedNavigationID
			selectedArticleIDs = preservedSelectedArticleIDs
			temporarilyUnavailableSelectedCollection = navigation.item(withID: preservedNavigationID) == nil
				? preservedCollection
				: nil
			let kept = preserveOpenArticle(openArticle, in: preservedNavigationID)
			selectedArticleIDs[preservedNavigationID] = kept.id
			selectedArticleID = kept.id
			preferredCompactColumn = .detail
			return
		}

		if navigation.item(withID: selectedNavigationID) == nil {
			temporarilyUnavailableSelectedCollection = nil
			selectedNavigationID = firstEnabledSmartSection.rawValue
		} else {
			temporarilyUnavailableSelectedCollection = nil
		}
		reconcileSelectedSmartViewIfNeeded()
		selectedArticleID = selectedArticleIDs[selectedNavigationID]
		reconcileCurrentArticleSelection()
	}

	private func resetInMemoryLibraryForAccountChange() {
		libraryGeneration = UUID()
		preparedOfflineAccountID = nil
		offlineSyncCursor = nil
		activeOfflinePreparationID = nil
		deferredInitialFeedPaginationCollectionID = nil
		articleCache = [:]
		sortOrders = [:]
		articleFilters.removeAll()
		selectedArticleIDs = [:]
		resetStreamPagination()
		resolvedPaginationCollections.removeAll()
		restoredReaderModes = [:]
		articleScrollOffsets = [:]
		collectionFreshness = [:]
		activeSearchID = nil
		activeSearchScope = nil
		activeSearchCollectionID = nil
		searchResults = []
		isSearchingArticles = false
		bulkReadUndo = nil
		bulkReadUndoTitle = nil
		scrollReadTriggered = []
		subscriptions = []
		selectedArticleID = nil
		selectedNavigationID = firstEnabledSmartSection.rawValue
		navigation = .initial
		temporarilyUnavailableSelectedCollection = nil
		sidebarFilter = .all
		preferredCompactColumn = .sidebar
		hasAppliedCompactColumnRestoration = false
		hasLoadedNavigation = false
		offlineStorageStats = .empty
		isOffline = false
		personalization = nil
		isLoadingPersonalization = false
		writeWidgetSnapshot()
	}

	private func resetStreamPagination(for collectionID: String) {
		streamContinuations[collectionID] = nil
		seenStreamContinuations[collectionID] = nil
		streamDayBounds[collectionID] = nil
		invalidateLoadMore(for: collectionID)
	}

	private func invalidateLoadMore(for collectionID: String) {
		activeLoadMoreIDs[collectionID] = nil
		loadingMoreCollections.remove(collectionID)
		loadMoreErrors[collectionID] = nil
	}

	private func operationContext(for apiClient: PigeonAPIClient) -> OperationContext? {
		guard let session, session.storageIdentity == apiClient.session.storageIdentity else {
			return nil
		}
		return OperationContext(
			accountID: session.storageIdentity,
			generation: libraryGeneration,
			preparationID: activeOfflinePreparationID,
		)
	}

	private func isCurrentOperation(_ context: OperationContext) -> Bool {
		session?.storageIdentity == context.accountID
			&& libraryGeneration == context.generation
			&& activeOfflinePreparationID == context.preparationID
	}

	private func isCurrentOfflinePreparation(
		accountID: String,
		preparationID: UUID,
		generation: UUID? = nil,
	) -> Bool {
		guard session?.storageIdentity == accountID, activeOfflinePreparationID == preparationID else {
			return false
		}
		return generation == nil || libraryGeneration == generation
	}

	private func isCurrentCollectionOperation(
		_ context: OperationContext,
		collectionID: String,
		operationID: UUID,
		isLoadMore: Bool,
	) -> Bool {
		guard isCurrentOperation(context) else { return false }
		if isLoadMore {
			return activeLoadMoreIDs[collectionID] == operationID && activeLoadIDs[collectionID] == nil
		}
		return activeLoadIDs[collectionID] == operationID
	}

	private func isPaginatedCollection(_ collection: ReaderNavigationItem) -> Bool {
		collection.smartSection == .today || collection.smartSection == nil
	}

	private func shouldResolveCachedPagination(for collection: ReaderNavigationItem) -> Bool {
		guard isOffline == false,
			isPaginatedCollection(collection),
			resolvedPaginationCollections.contains(collection.id) == false else {
			return false
		}
		return true
	}

	private var selectedCollectionRequiresLivePageAfterSync: Bool {
		let collection = selectedCollection
		guard collection.kind == .feed else { return true }
		return cachedCollectionHasMissingBodies(collection.id)
	}

	private func cachedCollectionHasMissingBodies(_ collectionID: String) -> Bool {
		guard let cachedArticles = articleCache[collectionID], cachedArticles.isEmpty == false else {
			return true
		}
		return cachedArticles.contains(where: { $0.html.isEmpty })
	}

	private func hasCachedPaginationContinuation(_ collectionID: String) -> Bool {
		guard let continuation = streamContinuations[collectionID] else { return false }
		return continuation.isEmpty == false
	}

	private func consumeDeferredInitialFeedPagination(for collection: ReaderNavigationItem) -> Bool {
		guard collection.kind == .feed,
			deferredInitialFeedPaginationCollectionID == collection.id else {
			return false
		}
		deferredInitialFeedPaginationCollectionID = nil
		return true
	}

	private func navigationAfterLoading(
		collection: ReaderNavigationItem,
		articles: [Recommendation],
	) -> ReaderNavigationState {
		guard collection.smartSection == .forYou || collection.smartSection == .today else {
			return navigation
		}
		return navigation.replacingCount(
			for: collection.id,
			with: articles.count(where: { $0.isRead == false }),
		)
	}

	private func persistCollectionState(
		_ articles: [Recommendation],
		collectionID: String,
		navigation: ReaderNavigationState,
		continuation: String?,
		context: OperationContext,
		operationID: UUID,
		isLoadMore: Bool,
		persistArticles: Bool = true,
	) async -> Bool {
		let predecessor = offlinePersistenceTask
		let task = Task { @MainActor [weak self] in
			if let predecessor {
				_ = await predecessor.value
			}
			guard let self,
				self.isCurrentCollectionOperation(
					context,
					collectionID: collectionID,
					operationID: operationID,
					isLoadMore: isLoadMore,
				) else {
				return false
			}

			do {
				if persistArticles {
					try await self.offlineStore.saveArticles(
						articles,
						collectionID: collectionID,
						accountID: context.accountID,
					)
					guard self.isCurrentCollectionOperation(
						context,
						collectionID: collectionID,
						operationID: operationID,
						isLoadMore: isLoadMore,
					) else {
						return false
					}
					try await self.offlineStore.saveNavigation(navigation, accountID: context.accountID)
					guard self.isCurrentCollectionOperation(
						context,
						collectionID: collectionID,
						operationID: operationID,
						isLoadMore: isLoadMore,
					) else {
						return false
					}
				}
				try await self.offlineStore.saveCollectionContinuation(
					continuation,
					collectionID: collectionID,
					accountID: context.accountID,
				)
				guard self.isCurrentCollectionOperation(
					context,
					collectionID: collectionID,
					operationID: operationID,
					isLoadMore: isLoadMore,
				) else {
					return false
				}
				return true
			} catch is CancellationError {
				return false
			} catch {
				if self.isCurrentCollectionOperation(
					context,
					collectionID: collectionID,
					operationID: operationID,
					isLoadMore: isLoadMore,
				) {
					self.errorMessage = error.localizedDescription
				}
				return false
			}
		}
		offlinePersistenceTask = task
		return await task.value
	}

	private func resetStreamPagination() {
			streamContinuations.removeAll()
		seenStreamContinuations.removeAll()
		streamDayBounds.removeAll()
		activeLoadMoreIDs.removeAll()
		loadingMoreCollections.removeAll()
		loadMoreErrors.removeAll()
	}

	private func scheduleRestorationSave() {
		guard isApplyingRestoration == false,
			let session,
			preparedOfflineAccountID == session.storageIdentity else { return }
		let accountID = session.storageIdentity
		let restoration = makeRestorationState()
		let previousSave = restorationSaveTask
		restorationSaveTask = Task { [offlineStore] in
			// Serialize captured snapshots so an earlier write can never land after
			// a newer scroll/selection state during rapid UI changes.
			await previousSave?.value
			try? await offlineStore.saveRestoration(restoration, accountID: accountID)
		}
	}

	private func makeRestorationState() -> ReaderRestorationState {
		let identity = session?.storageIdentity
		let filters = articleFilters.reduce(into: [String: String]()) { result, pair in
			guard pair.key.sessionIdentity == identity else { return }
			result[pair.key.collectionID] = pair.value.rawValue
		}
		return ReaderRestorationState(
			selectedNavigationID: selectedNavigationID,
			selectedArticleIDs: selectedArticleIDs,
			sortOrders: sortOrders.mapValues(\.rawValue),
			articleFilters: filters,
			sidebarFilter: sidebarFilter.rawValue,
			expandedFolderIDs: navigation.expandedFolderIDs,
			compactColumn: restoredCompactColumn(from: preferredCompactColumn),
			readerModes: restoredReaderModes,
			articleScrollOffsets: articleScrollOffsets,
		)
	}

	private func restoredCompactColumn(from column: NavigationSplitViewColumn) -> ReaderRestoredCompactColumn {
		switch column {
		case .sidebar: .sidebar
		case .content: .content
		case .detail: .detail
		default: .sidebar
		}
	}

	private func compactColumn(from column: ReaderRestoredCompactColumn) -> NavigationSplitViewColumn {
		switch column {
		case .sidebar: .sidebar
		case .content: .content
		case .detail: .detail
		}
	}

	@discardableResult
	private func enqueueOfflineMutation(_ mutation: OfflineMutation) async -> Bool {
		guard let session else { return false }
		let context = OperationContext(
			accountID: session.storageIdentity,
			generation: libraryGeneration,
			preparationID: activeOfflinePreparationID,
		)
		do {
			try await offlineStore.enqueue(mutation, accountID: context.accountID)
			guard isCurrentOperation(context) else { return false }
			await refreshOfflineStorageStats()
			guard isCurrentOperation(context) else { return false }
			return true
		} catch {
			guard isCurrentOperation(context) else { return false }
			errorMessage = error.localizedDescription
			return false
		}
	}

	private func replayPendingMutations() async {
		guard let apiClient, let context = operationContext(for: apiClient) else { return }
		let accountID = context.accountID
		do {
			_ = try await mutationReplayer.replay(accountID: accountID, apiClient: apiClient)
			guard isCurrentOperation(context) else { return }
			isOffline = false
		} catch let error where isCancellation(error) {
			// The action is durable already. Cancellation must never roll it back.
		} catch {
			guard isCurrentOperation(context) else { return }
			isOffline = isConnectivityFailure(error)
		}
		guard isCurrentOperation(context) else { return }
		await refreshOfflineStorageStats()
	}

	private func persistCollections(_ collectionIDs: Set<String>) async {
		guard let accountID = session?.storageIdentity else { return }
		do {
			for collectionID in collectionIDs {
				try await offlineStore.saveArticles(
					articleCache[collectionID] ?? [],
					collectionID: collectionID,
					accountID: accountID,
				)
			}
			try await offlineStore.saveNavigation(navigation, accountID: accountID)
			scheduleRestorationSave()
			writeWidgetSnapshot()
		} catch {
			errorMessage = error.localizedDescription
		}
	}

	func clearError() {
		errorMessage = nil
	}

	func subscription(id: String) -> FeedSubscription? {
		subscriptions.first { $0.id == id }
	}

	private func sortedSubscriptions(_ values: [FeedSubscription]) -> [FeedSubscription] {
		values.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
	}

	private func normalizedFolderName(_ name: String?) -> String? {
		guard let name else {
			return nil
		}
		let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
		guard trimmed.isEmpty == false, trimmed.count <= 80 else {
			return nil
		}
		return trimmed
	}

	private func normalizedFolderNames(_ names: [String]) -> [String]? {
		var normalized: [String] = []
		for rawName in names {
			guard let name = normalizedFolderName(rawName) else {
				return nil
			}
			if normalized.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) == false {
				normalized.append(name)
			}
		}
		return normalized.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
	}

	private func rebuildNavigationFromSubscriptions() {
		var feedCounts: [String: Int] = [:]
		for item in navigation.items where item.kind == .feed {
			feedCounts[item.streamID] = max(feedCounts[item.streamID, default: 0], item.unreadCount)
		}
		let readerSubscriptions = subscriptions.map { subscription in
			ReaderSubscription(
				id: subscription.id,
				title: subscription.title,
				categories: subscription.categories.map {
					ReaderSubscriptionCategory(id: $0.id, label: $0.label)
				},
				url: subscription.url.absoluteString,
				iconURL: subscription.iconUrl,
			)
		}
		let smartCounts = ReaderNavigationSmartCounts(
			forYou: navigation.item(withID: ReaderSection.forYou.rawValue)?.unreadCount ?? 0,
			today: navigation.item(withID: ReaderSection.today.rawValue)?.unreadCount ?? 0,
			unread: navigation.item(withID: ReaderSection.unread.rawValue)?.unreadCount ?? 0,
			starred: navigation.item(withID: ReaderSection.starred.rawValue)?.unreadCount ?? 0,
		)
		setNavigation(
			ReaderNavigationCatalog.make(
				subscriptions: readerSubscriptions,
				unreadCounts: feedCounts.map { ReaderUnreadCount(id: $0.key, count: $0.value) },
				smartCounts: smartCounts,
			),
			markAsLoaded: true,
		)
	}

	private func updateSubscription(id: String, update: (inout FeedSubscription) -> Void) {
		guard let index = subscriptions.firstIndex(where: { $0.id == id }) else {
			return
		}
		update(&subscriptions[index])
		subscriptions = sortedSubscriptions(subscriptions)
	}

	private func applyFolderRename(from oldName: String, to newName: String) {
		for index in subscriptions.indices {
			for categoryIndex in subscriptions[index].categories.indices where subscriptions[index].categories[categoryIndex].label == oldName {
				subscriptions[index].categories[categoryIndex] = FeedCategory(
					id: "user/-/label/\(newName)",
					label: newName,
				)
			}
		}
		subscriptions = sortedSubscriptions(subscriptions)
	}

	private func markStoriesAsRead(_ boundary: ReadBoundary, around article: Recommendation, in collection: ReaderNavigationItem) async {
		let displayedArticles = articleCache[collection.id] ?? []
		guard let boundaryIndex = displayedArticles.firstIndex(where: { $0.id == article.id })
			?? displayedArticles.firstIndex(where: { articlesMatch($0, article) }) else {
			return
		}

		let candidates: ArraySlice<Recommendation>
		switch boundary {
		case .above:
			candidates = displayedArticles[..<boundaryIndex]
		case .below:
			candidates = displayedArticles.dropFirst(boundaryIndex + 1)[...]
		}

		var seenIdentifiers = Set<String>()
		let targets = candidates.filter { candidate in
			guard candidate.isRead == false else {
				return false
			}
			let identifiers = Set([candidate.id, candidate.readerId])
			guard identifiers.isDisjoint(with: seenIdentifiers) else {
				return false
			}
			seenIdentifiers.formUnion(identifiers)
			return true
		}
		await markArticlesAsRead(
			Array(targets),
			scope: boundary == .above ? .above : .below,
			undoTitle: boundary == .above ? "Mark Above as Read" : "Mark Below as Read",
		)
	}

	private func markArticlesAsRead(
		_ targets: [Recommendation],
		scope: OfflineMutationScope,
		undoTitle: String,
	) async {
		guard targets.isEmpty == false else { return }
		bulkReadUndo = BulkReadUndo(articles: targets, title: undoTitle)
		bulkReadUndoTitle = undoTitle
		await updateReadStateForArticles(targets, read: true, scope: scope)
	}

	private func updateReadStateForArticles(
		_ targets: [Recommendation],
		read: Bool,
		scope: OfflineMutationScope,
	) async {
		guard targets.isEmpty == false else { return }
		let targetIDs = targets.map(\.readerId)
		for start in stride(from: 0, to: targetIDs.count, by: 200) {
			let end = min(start + 200, targetIDs.count)
			let mutation = OfflineMutation(
				kind: .setReadBatch,
				itemIds: Array(targetIDs[start..<end]),
				value: read,
				scope: scope,
			)
			guard await enqueueOfflineMutation(mutation) else { return }
		}

		var changedCollections = Set<String>()
		for target in targets {
			for collectionID in Array(articleCache.keys) {
				guard var cachedArticles = articleCache[collectionID] else {
					continue
				}
				let matchingIndices = cachedArticles.indices.filter { articlesMatch(cachedArticles[$0], target) }
				guard matchingIndices.isEmpty == false else {
					continue
				}
				for index in matchingIndices {
					cachedArticles[index].isRead = read
				}
				articleCache[collectionID] = cachedArticles
				changedCollections.insert(collectionID)
			}
			applyNavigationCountDeltas(navigationCountDeltas(for: target, fromRead: !read, toRead: read))
		}
		reconcileCurrentArticleSelection()
		await persistCollections(changedCollections)
		await replayPendingMutations()
	}

	@discardableResult
	private func send(_ event: EngagementEvent) async -> Bool {
		guard let apiClient else {
			return false
		}
		do {
			try await apiClient.sendEngagement([event])
			return true
		} catch let error where isCancellation(error) {
			return false
		} catch let error as PigeonError where error.isNonFatalEngagementFailure {
			return false
		} catch {
			errorMessage = error.localizedDescription
			return false
		}
	}

	private func optimisticallyUpdateState(
		article: Recommendation,
		value: Bool,
		mutationName: String,
		keyPath: WritableKeyPath<Recommendation, Bool>
	) async {
		let kind: OfflineMutationKind = mutationName == "read" ? .setRead : .setStarred
		let mutation = OfflineMutation(
			kind: kind,
			itemIds: [article.readerId],
			value: value,
			scope: .single,
		)
		guard await enqueueOfflineMutation(mutation) else { return }

		var changedCollections = Set<String>()
		for collectionID in articleCache.keys {
			guard let index = articleCache[collectionID]?.firstIndex(where: { articlesMatch($0, article) }) else {
				continue
			}
			articleCache[collectionID]?[index][keyPath: keyPath] = value
			changedCollections.insert(collectionID)
		}
		if mutationName == "read" {
			adjustNavigationCounts(for: article, fromRead: article.isRead, toRead: value)
			reconcileCurrentArticleSelection()
		} else if mutationName == "starred" {
			adjustStarredNavigationCount(for: article, fromStarred: article.isStarred, toStarred: value)
		}

		await persistCollections(changedCollections)
		await replayPendingMutations()
	}

}
