import Foundation
import Observation
import SwiftUI

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
	private let offlineStore: any OfflineLibraryStoring
	private let mutationReplayer: OfflineMutationReplayer
	private let offlineSynchronizationEnabled: Bool
	let readerTypography: ReaderTypographySettings
	private let readerViewExtractor: any ReaderViewExtracting
	private var apiClient: PigeonAPIClient?
	private var articleCache: [String: [Recommendation]] = [:]
	private var sortOrders: [String: ArticleSortOrder] = [:]
	private var articleFilters: [ArticleFilterKey: ReaderArticleFilter] = [:]
	private var selectedArticleIDs: [String: String] = [:]
	private var loadingCollections: Set<String> = []
	private var activeLoadIDs: [String: UUID] = [:]
	private var inFlightReadwiseSaves: Set<String> = []
	private var engagement = EngagementAggregator()
	private var sentScrollThresholds: [String: Set<Int>] = [:]
	private var hasLoadedNavigation = false
	private var activeNavigationLoadID: UUID?
	private var activeNavigationLoadIDs: Set<UUID> = []
	private var activeLibraryLoadID: UUID?
	private var preparedOfflineAccountID: String?
	private var isApplyingRestoration = false
	private var restorationSaveTask: Task<Void, Never>?
	private var restoredReaderModes: [String: String] = [:]
	private var articleScrollOffsets: [String: Double] = [:]
	private var collectionFreshness: [String: CollectionFreshness] = [:]
	private var activeSearchID: UUID?
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

	init(
		sessionStore: any SessionStore = KeychainSessionStore(),
		httpClient: any HTTPClient = URLSessionHTTPClient(),
		readwiseTokenStore: any ReadwiseTokenStore = KeychainReadwiseTokenStore(),
		readerModeStore: ReaderModeStore = ReaderModeStore(),
		articleFilterStore: ReaderArticleFilterStore = ReaderArticleFilterStore(),
		offlineStore: any OfflineLibraryStoring = OfflineLibraryStore.shared,
		offlineSynchronizationEnabled: Bool = true,
		readerTypography: ReaderTypographySettings? = nil,
		readerViewExtractor: (any ReaderViewExtracting)? = nil,
	) {
		self.sessionStore = sessionStore
		self.httpClient = httpClient
		self.readwiseTokenStore = readwiseTokenStore
		self.readwiseAPIClient = ReadwiseAPIClient(tokenStore: readwiseTokenStore, httpClient: httpClient)
		self.readerModeStore = readerModeStore
		self.articleFilterStore = articleFilterStore
		self.offlineStore = offlineStore
		self.mutationReplayer = OfflineMutationReplayer(store: offlineStore)
		self.offlineSynchronizationEnabled = offlineSynchronizationEnabled
		self.readerTypography = readerTypography ?? ReaderTypographySettings()
		self.readerViewExtractor = readerViewExtractor ?? ReaderViewExtractor(httpClient: httpClient)
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
		navigation.item(withID: selectedNavigationID) ?? .smart(selectedSection)
	}

	var smartNavigationItems: [ReaderNavigationItem] {
		navigation.smartItems
	}

	var visibleSmartNavigationItems: [ReaderNavigationItem] {
		smartNavigationItems.filter { $0.smartSection != .unread }
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
			try sessionStore.remove()
			session = nil
			apiClient = nil
			articleCache = [:]
			sortOrders = [:]
			articleFilters.removeAll()
			selectedArticleIDs = [:]
			subscriptions = []
			selectedArticleID = nil
			sidebarFilter = .all
			selectedNavigationID = ReaderSection.forYou.rawValue
			navigation = .initial
			isLoadingNavigation = false
			activeNavigationLoadID = nil
			activeNavigationLoadIDs.removeAll()
			activeLibraryLoadID = nil
			isLoadingLibrary = false
			hasLoadedNavigation = false
			preferredCompactColumn = .sidebar
			preparedOfflineAccountID = nil
			restoredReaderModes = [:]
			articleScrollOffsets = [:]
			collectionFreshness = [:]
			activeSearchID = nil
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
		guard offlineSynchronizationEnabled, let session, let apiClient else { return }
		let accountID = session.storageIdentity
		if preparedOfflineAccountID != accountID {
			resetInMemoryLibraryForAccountChange()
			do {
				let snapshot = try await offlineStore.loadSnapshot(accountID: accountID)
				guard self.session?.storageIdentity == accountID else { return }
				applyCachedSnapshot(snapshot)
				preparedOfflineAccountID = accountID
			} catch {
				errorMessage = error.localizedDescription
				return
			}
		}

		isSynchronizingOfflineLibrary = true
		defer { isSynchronizingOfflineLibrary = false }
		do {
			_ = try await mutationReplayer.replay(accountID: accountID, apiClient: apiClient)
			try await synchronizeIncrementally(accountID: accountID, apiClient: apiClient)
			guard self.session?.storageIdentity == accountID else { return }
			isOffline = false
			await loadNavigation(force: true)
			await loadLibrary(force: true)
			await load(collection: selectedCollection, force: true)
		} catch let error where isCancellation(error) {
			return
		} catch {
			guard self.session?.storageIdentity == accountID else { return }
			isOffline = true
			if articleCache.isEmpty && navigation.items == ReaderNavigationState.initial.items {
				errorMessage = error.localizedDescription
			}
		}
		await refreshOfflineStorageStats()
	}

	func refreshOfflineStorageStats() async {
		guard let accountID = session?.storageIdentity else {
			offlineStorageStats = .empty
			return
		}
		do {
			offlineStorageStats = try await offlineStore.storageStats(accountID: accountID)
		} catch {
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
		var next = state
		next.preserveExpansion(from: navigation)
		navigation = next
		if markAsLoaded {
			hasLoadedNavigation = true
		}
		if navigation.item(withID: previousSelection) == nil {
			select(collectionID: ReaderSection.forYou.rawValue)
		} else {
			reconcileCurrentArticleSelection()
		}
		scheduleRestorationSave()
	}

	private func select(collectionID: String) {
		selectedNavigationID = collectionID
		preferredCompactColumn = .content
		reconcileSelection(for: collectionID)
		scheduleRestorationSave()
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

	func loadNavigation(
		force: Bool = false,
		now: Date = .now,
		dayBounds: ReaderLocalDayBounds? = nil,
	) async {
		guard let apiClient else {
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
			guard activeNavigationLoadID == loadID else {
				return
			}
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
			try await offlineStore.saveNavigation(navigation, accountID: apiClient.session.storageIdentity)
		} catch let error where isCancellation(error) {
			return
		} catch {
			guard activeNavigationLoadID == loadID else {
				return
			}
			if session != nil {
				errorMessage = error.localizedDescription
			}
		}
	}

	func refresh(collection: ReaderNavigationItem) async {
		await load(collection: collection, force: true)
		if hasLoadedNavigation {
			await loadNavigation(force: true)
		}
	}

	func load(section: ReaderSection, force: Bool = false) async {
		await load(collection: .smart(section), force: force)
	}

	func load(collection: ReaderNavigationItem, force: Bool = false) async {
		guard let apiClient else {
			return
		}
		if force == false, articleCache[collection.id] != nil {
			return
		}

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
			let loadedArticles: [Recommendation]
			if let section = collection.smartSection, section.usesRecommendationEndpoint {
				loadedArticles = try await apiClient.recommendations(for: section)
			} else if collection.smartSection == .today {
				loadedArticles = try await apiClient.recommendations(
					from: "user/-/state/com.google/reading-list",
					dayBounds: ReaderLocalDayBounds.localDay(containing: .now),
				)
			} else {
				loadedArticles = try await apiClient.recommendations(from: collection.streamID)
			}
			try Task.checkCancellation()
			guard activeLoadIDs[collection.id] == loadID else {
				return
			}
			setArticles(loadedArticles, for: collection.id)
			collectionFreshness[collection.id] = CollectionFreshness(updatedAt: .now, isCached: false)
			try await offlineStore.saveArticles(
				loadedArticles,
				collectionID: collection.id,
				accountID: apiClient.session.storageIdentity,
			)
			if collection.smartSection == .forYou {
				// This endpoint is bounded by its requested recommendation collection. Count the
				// entire returned/displayed collection, not merely the first page or request limit.
				updateNavigationCount(for: collection.id, to: loadedArticles.count(where: { $0.isRead == false }))
			}
			if collection.smartSection == .today {
				updateNavigationCount(for: collection.id, to: loadedArticles.count(where: { $0.isRead == false }))
			}
			try await offlineStore.saveNavigation(navigation, accountID: apiClient.session.storageIdentity)
		} catch let error where isCancellation(error) {
			return
		} catch {
			guard activeLoadIDs[collection.id] == loadID, selectedNavigationID == collection.id else {
				return
			}
			errorMessage = error.localizedDescription
		}
	}

	func loadLibrary(force: Bool = false) async {
		guard let apiClient else {
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
			guard activeLibraryLoadID == loadID else {
				return
			}
			setSubscriptions(loaded)
			try await offlineStore.saveSubscriptions(loaded, accountID: apiClient.session.storageIdentity)
		} catch let error where isCancellation(error) {
			return
		} catch {
			guard activeLibraryLoadID == loadID else {
				return
			}
			errorMessage = error.localizedDescription
		}
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
	func moveFeed(_ subscription: FeedSubscription, to folderName: String?) async -> Bool {
		let folder = normalizedFolderName(folderName)
		if folderName?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false, folder == nil {
			errorMessage = "Folder names must be between 1 and 80 characters."
			return false
		}
		let mutation = OfflineMutation(
			kind: .moveFeed,
			feedId: subscription.id,
			folders: folder.map { [$0] } ?? [],
		)
		guard await enqueueOfflineMutation(mutation) else { return false }
		updateSubscription(id: subscription.id) { item in
			item.categories = folder.map { [FeedCategory(id: "user/-/label/\($0)", label: $0)] } ?? []
		}
		if let accountID = session?.storageIdentity {
			try? await offlineStore.saveSubscriptions(subscriptions, accountID: accountID)
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
		articleCache[collectionID] = sortOrder(for: collectionID).sorted(newArticles)
		reconcileSelection(for: collectionID)
	}

	private func articleFilter(for collectionID: String) -> ReaderArticleFilter {
		guard let session else {
			return ReaderArticleFilterStore.defaultFilter
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

		guard articleCache[collectionID]?.contains(where: { $0.id == rememberedID }) == true else {
			selectedArticleIDs[collectionID] = nil
			if selectedNavigationID == collectionID {
				selectedArticleID = nil
				preferredCompactColumn = .content
			}
			return
		}

		guard selectedNavigationID == collectionID else {
			return
		}
		// Keep the article open while a read-state or filter change removes its row.
		// Selection is cleared only when the underlying cached article disappears.
		selectedArticleID = rememberedID
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

	private func synchronizeIncrementally(accountID: String, apiClient: PigeonAPIClient) async throws {
		var cursor = try await offlineStore.loadSnapshot(accountID: accountID).cursor
		var seenCursors = Set<String>()
		while true {
			try Task.checkCancellation()
			let page = try await apiClient.incrementalSync(cursor: cursor)
			guard seenCursors.insert(page.cursor).inserted || page.hasMore == false else {
				throw PigeonError.invalidResponse
			}
			try await offlineStore.apply(page, accountID: accountID)
			cursor = page.cursor
			if page.hasMore == false { break }
		}
		_ = try? await offlineStore.cleanupReadBodies(accountID: accountID, keepingNewest: 500)
		let snapshot = try await offlineStore.loadSnapshot(accountID: accountID)
		guard session?.storageIdentity == accountID else { return }
		applyCachedSnapshot(snapshot)
	}

	private func applyCachedSnapshot(_ snapshot: CachedLibrarySnapshot) {
		guard let session else { return }
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
			selectedArticleIDs = restoration.selectedArticleIDs
			sidebarFilter = ReaderSidebarFilter(rawValue: restoration.sidebarFilter) ?? .all
			restoredReaderModes = restoration.readerModes
			articleScrollOffsets = restoration.articleScrollOffsets
			preferredCompactColumn = compactColumn(from: restoration.compactColumn)
			selectedNavigationID = restoration.selectedNavigationID
		}

		if let cachedNavigation = snapshot.navigation {
			var restoredNavigation = cachedNavigation
			if let restoration = snapshot.restoration {
				restoredNavigation.expandedFolderIDs = restoration.expandedFolderIDs
					.intersection(Set(restoredNavigation.folderItems.map(\.id)))
			}
			navigation = restoredNavigation
			hasLoadedNavigation = true
		}
		subscriptions = sortedSubscriptions(snapshot.subscriptions)
		articleCache = snapshot.articlesByCollection.reduce(into: [:]) { result, pair in
			result[pair.key] = sortOrder(for: pair.key).sorted(pair.value)
		}
		if let updatedAt = snapshot.lastSyncAt {
			collectionFreshness = snapshot.articlesByCollection.keys.reduce(into: [:]) { result, collectionID in
				result[collectionID] = CollectionFreshness(updatedAt: updatedAt, isCached: true)
			}
		}

		if navigation.item(withID: selectedNavigationID) == nil {
			selectedNavigationID = ReaderSection.forYou.rawValue
		}
		selectedArticleID = selectedArticleIDs[selectedNavigationID]
		reconcileCurrentArticleSelection()
	}

	private func resetInMemoryLibraryForAccountChange() {
		preparedOfflineAccountID = nil
		articleCache = [:]
		sortOrders = [:]
		articleFilters.removeAll()
		selectedArticleIDs = [:]
		restoredReaderModes = [:]
		articleScrollOffsets = [:]
		collectionFreshness = [:]
		activeSearchID = nil
		searchResults = []
		isSearchingArticles = false
		bulkReadUndo = nil
		bulkReadUndoTitle = nil
		scrollReadTriggered = []
		subscriptions = []
		selectedArticleID = nil
		selectedNavigationID = ReaderSection.forYou.rawValue
		navigation = .initial
		sidebarFilter = .all
		preferredCompactColumn = .sidebar
		hasLoadedNavigation = false
		offlineStorageStats = .empty
		isOffline = false
		personalization = nil
		isLoadingPersonalization = false
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
		let accountID = session.storageIdentity
		do {
			try await offlineStore.enqueue(mutation, accountID: accountID)
			await refreshOfflineStorageStats()
			return true
		} catch {
			errorMessage = error.localizedDescription
			return false
		}
	}

	private func replayPendingMutations() async {
		guard let session, let apiClient else { return }
		let accountID = session.storageIdentity
		do {
			_ = try await mutationReplayer.replay(accountID: accountID, apiClient: apiClient)
			isOffline = false
		} catch let error where isCancellation(error) {
			// The action is durable already. Cancellation must never roll it back.
		} catch {
			isOffline = true
		}
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
