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

	private struct PendingReadMutation: Sendable {
		let article: Recommendation
		let mutationID: UUID
		let previousValues: [String: [Bool]]
		let navigationDeltas: [String: Int]

		var mutationKey: String {
			"\(article.id)|read"
		}
	}

	private struct ReadMutationResult: Sendable {
		let articleID: String
		let succeeded: Bool
		let wasCancelled: Bool
		let errorDescription: String?
	}

	private struct ArticleFilterKey: Hashable {
		let sessionIdentity: String
		let collectionID: String
	}

	var session: PigeonSession?
	var serverURLText = ""
	var password = ""
	private(set) var selectedNavigationID = ReaderSection.forYou.rawValue
	var selectedArticleID: String?
	var preferredCompactColumn: NavigationSplitViewColumn = .sidebar
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
	var sidebarFilter = ReaderSidebarFilter.all

	private let sessionStore: any SessionStore
	private let httpClient: any HTTPClient
	private let readwiseTokenStore: any ReadwiseTokenStore
	private let readwiseAPIClient: ReadwiseAPIClient
	private let readerModeStore: ReaderModeStore
	private let articleFilterStore: ReaderArticleFilterStore
	let readerTypography: ReaderTypographySettings
	private let readerViewExtractor: any ReaderViewExtracting
	private var apiClient: PigeonAPIClient?
	private var articleCache: [String: [Recommendation]] = [:]
	private var sortOrders: [String: ArticleSortOrder] = [:]
	private var articleFilters: [ArticleFilterKey: ReaderArticleFilter] = [:]
	private var selectedArticleIDs: [String: String] = [:]
	private var loadingCollections: Set<String> = []
	private var activeLoadIDs: [String: UUID] = [:]
	private var activeMutationIDs: [String: UUID] = [:]
	private var inFlightReadwiseSaves: Set<String> = []
	private var engagement = EngagementAggregator()
	private var sentScrollThresholds: [String: Set<Int>] = [:]
	private var hasLoadedNavigation = false
	private var activeNavigationLoadID: UUID?
	private var activeNavigationLoadIDs: Set<UUID> = []
	private var activeLibraryLoadID: UUID?

	init(
		sessionStore: any SessionStore = KeychainSessionStore(),
		httpClient: any HTTPClient = URLSessionHTTPClient(),
		readwiseTokenStore: any ReadwiseTokenStore = KeychainReadwiseTokenStore(),
		readerModeStore: ReaderModeStore = ReaderModeStore(),
		articleFilterStore: ReaderArticleFilterStore = ReaderArticleFilterStore(),
		readerTypography: ReaderTypographySettings? = nil,
		readerViewExtractor: (any ReaderViewExtracting)? = nil,
	) {
		self.sessionStore = sessionStore
		self.httpClient = httpClient
		self.readwiseTokenStore = readwiseTokenStore
		self.readwiseAPIClient = ReadwiseAPIClient(tokenStore: readwiseTokenStore, httpClient: httpClient)
		self.readerModeStore = readerModeStore
		self.articleFilterStore = articleFilterStore
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
		return articles.first(where: { $0.id == selectedArticleID })
	}

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
			// Filter state is a performance cache. Reload it from the session-scoped store
			// after every successful connection, including a reconnect to the same account.
			articleFilters.removeAll()
			session = newSession
			serverURLText = newSession.baseURL.absoluteString
			password = ""
			apiClient = PigeonAPIClient(session: newSession, httpClient: httpClient)
			select(section: .forYou)
			await loadNavigation(force: true)
			await load(section: .forYou, force: true)
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
		readerModeStore.mode(for: feedID)
	}

	func setReaderMode(_ mode: ReaderMode, for feedID: String) {
		readerModeStore.setMode(mode, for: feedID)
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
	}

	private func select(collectionID: String) {
		selectedNavigationID = collectionID
		preferredCompactColumn = .content
		reconcileSelection(for: collectionID)
	}

	func select(article: Recommendation) {
		guard articles.contains(where: { $0.id == article.id }) else {
			return
		}
		selectedArticleID = article.id
		selectedArticleIDs[selectedNavigationID] = article.id
		preferredCompactColumn = .detail
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
			if collection.smartSection == .forYou {
				// This endpoint is bounded by its requested recommendation collection. Count the
				// entire returned/displayed collection, not merely the first page or request limit.
				updateNavigationCount(for: collection.id, to: loadedArticles.count(where: { $0.isRead == false }))
			}
			if collection.smartSection == .today {
				updateNavigationCount(for: collection.id, to: loadedArticles.count(where: { $0.isRead == false }))
			}
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
		guard let apiClient else {
			return false
		}
		let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
		guard title.isEmpty == false, title.count <= 200 else {
			errorMessage = "Feed names must be between 1 and 200 characters."
			return false
		}
		let mutationKey = "feed-title:\(subscription.id)"
		let mutationID = beginMutation(key: mutationKey)
		updateSubscription(id: subscription.id) { $0.title = title }

		do {
			try await apiClient.editSubscription(id: subscription.id, title: title)
			finishMutation(key: mutationKey, id: mutationID)
			if hasLoadedNavigation {
				await loadNavigation(force: true)
			}
			return true
		} catch let error where isCancellation(error) {
			rollbackSubscription(subscription, key: mutationKey, id: mutationID)
			return false
		} catch {
			rollbackSubscription(subscription, key: mutationKey, id: mutationID)
			errorMessage = error.localizedDescription
			return false
		}
	}

	@discardableResult
	func moveFeed(_ subscription: FeedSubscription, to folderName: String?) async -> Bool {
		guard let apiClient else {
			return false
		}
		let folder = normalizedFolderName(folderName)
		if folderName?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false, folder == nil {
			errorMessage = "Folder names must be between 1 and 80 characters."
			return false
		}
		let mutationKey = "feed-folder:\(subscription.id)"
		let mutationID = beginMutation(key: mutationKey)
		updateSubscription(id: subscription.id) { item in
			item.categories = folder.map { [FeedCategory(id: "user/-/label/\($0)", label: $0)] } ?? []
		}

		do {
			try await apiClient.editSubscription(
				id: subscription.id,
				addingFolders: folder.map { [$0] } ?? [],
				removingFolders: subscription.folderNames.filter { $0 != folder },
			)
			finishMutation(key: mutationKey, id: mutationID)
			if hasLoadedNavigation {
				await loadNavigation(force: true)
			}
			return true
		} catch let error where isCancellation(error) {
			rollbackSubscription(subscription, key: mutationKey, id: mutationID)
			return false
		} catch {
			rollbackSubscription(subscription, key: mutationKey, id: mutationID)
			errorMessage = error.localizedDescription
			return false
		}
	}

	@discardableResult
	func unsubscribe(_ subscription: FeedSubscription) async -> Bool {
		guard let apiClient else {
			return false
		}
		let mutationKey = "unsubscribe:\(subscription.id)"
		let mutationID = beginMutation(key: mutationKey)
		subscriptions.removeAll { $0.id == subscription.id }

		do {
			try await apiClient.unsubscribe(id: subscription.id)
			finishMutation(key: mutationKey, id: mutationID)
			if hasLoadedNavigation {
				await loadNavigation(force: true)
			}
			return true
		} catch let error where isCancellation(error) {
			rollbackSubscription(subscription, key: mutationKey, id: mutationID)
			return false
		} catch {
			rollbackSubscription(subscription, key: mutationKey, id: mutationID)
			errorMessage = error.localizedDescription
			return false
		}
	}

	@discardableResult
	func renameFolder(_ oldName: String, to newName: String) async -> Bool {
		guard let apiClient, let name = normalizedFolderName(newName) else {
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
		applyFolderRename(from: oldName, to: name)

		do {
			for subscription in affected {
				try Task.checkCancellation()
				try await apiClient.editSubscription(
					id: subscription.id,
					addingFolders: [name],
					removingFolders: [oldName],
				)
			}
			if hasLoadedNavigation {
				await loadNavigation(force: true)
			}
			return true
		} catch let error where isCancellation(error) {
			await loadLibrary(force: true)
			return false
		} catch {
			errorMessage = error.localizedDescription
			await loadLibrary(force: true)
			return false
		}
	}

	@discardableResult
	func deleteFolder(_ name: String) async -> Bool {
		guard let apiClient else {
			return false
		}
		let affected = subscriptions.filter { $0.folderNames.contains(name) }
		for subscription in affected {
			updateSubscription(id: subscription.id) { item in
				item.categories.removeAll { $0.label == name }
			}
		}

		do {
			for subscription in affected {
				try Task.checkCancellation()
				try await apiClient.editSubscription(id: subscription.id, removingFolders: [name])
			}
			if hasLoadedNavigation {
				await loadNavigation(force: true)
			}
			return true
		} catch let error where isCancellation(error) {
			await loadLibrary(force: true)
			return false
		} catch {
			errorMessage = error.localizedDescription
			await loadLibrary(force: true)
			return false
		}
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
		if displayedArticles(for: collectionID).contains(where: { $0.id == rememberedID }) {
			selectedArticleID = rememberedID
		} else {
			selectedArticleID = nil
			if preferredCompactColumn == .detail {
				preferredCompactColumn = .content
			}
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

	func article(withId id: String) -> Recommendation? {
		if let current = articles.first(where: { $0.id == id || $0.readerId == id }) {
			return current
		}
		for cachedArticles in articleCache.values {
			if let article = cachedArticles.first(where: { $0.id == id || $0.readerId == id }) {
				return article
			}
		}
		return nil
	}

	func recordExplicitOpen(for article: Recommendation) async {
		sentScrollThresholds[article.id] = []
		await send(EngagementEvent(itemId: article.id, type: .explicitOpen))
		if !article.isRead {
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
			keyPath: \.isRead,
			tag: "user/-/state/com.google/read"
		)
	}

	func markStoriesAboveAsRead(_ article: Recommendation, in collection: ReaderNavigationItem) async {
		await markStoriesAsRead(.above, around: article, in: collection)
	}

	func markStoriesBelowAsRead(_ article: Recommendation, in collection: ReaderNavigationItem) async {
		await markStoriesAsRead(.below, around: article, in: collection)
	}

	func setStarred(_ article: Recommendation, starred: Bool) async {
		await optimisticallyUpdateState(
			article: article,
			value: starred,
			mutationName: "starred",
			keyPath: \.isStarred,
			tag: "user/-/state/com.google/starred"
		)
	}

	func recordPreference(_ type: EngagementEventType, for article: Recommendation) async {
		guard type == .notInterested, articleCache[ReaderSection.forYou.rawValue] != nil else {
			await send(EngagementEvent(itemId: article.id, type: type))
			return
		}

		let mutationKey = "\(article.id)|not-interested"
		let mutationID = UUID()
		activeMutationIDs[mutationKey] = mutationID
		defer {
			if activeMutationIDs[mutationKey] == mutationID {
				activeMutationIDs[mutationKey] = nil
			}
		}
		let forYouID = ReaderSection.forYou.rawValue
		let previousItems = articleCache[forYouID] ?? []
		let previousNavigation = navigation
		let previousSelection = selectedArticleIDs[forYouID]
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

		let succeeded = await send(EngagementEvent(itemId: article.id, type: type))
		guard succeeded == false, activeMutationIDs[mutationKey] == mutationID else {
			return
		}
		articleCache[forYouID] = previousItems
		navigation = previousNavigation
		selectedArticleIDs[forYouID] = previousSelection
		if selectedNavigationID == forYouID, selectedArticleID == nil {
			selectedArticleID = previousSelection
			preferredCompactColumn = previousSelection == nil ? .content : .detail
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

	private func beginMutation(key: String) -> UUID {
		let id = UUID()
		activeMutationIDs[key] = id
		return id
	}

	private func finishMutation(key: String, id: UUID) {
		if activeMutationIDs[key] == id {
			activeMutationIDs[key] = nil
		}
	}

	private func rollbackSubscription(_ subscription: FeedSubscription, key: String, id: UUID) {
		guard activeMutationIDs[key] == id else {
			return
		}
		if let index = subscriptions.firstIndex(where: { $0.id == subscription.id }) {
			subscriptions[index] = subscription
		} else {
			subscriptions.append(subscription)
		}
		subscriptions = sortedSubscriptions(subscriptions)
		activeMutationIDs[key] = nil
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
		guard let apiClient else {
			return
		}
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
		guard targets.isEmpty == false else {
			return
		}

		if selectedNavigationID == collection.id {
			errorMessage = nil
		}

		var pendingMutations: [PendingReadMutation] = []
		for target in targets {
			let mutationID = UUID()
			activeMutationIDs["\(target.id)|read"] = mutationID
			var previousValues: [String: [Bool]] = [:]
			for collectionID in Array(articleCache.keys) {
				guard var cachedArticles = articleCache[collectionID] else {
					continue
				}
				let matchingIndices = cachedArticles.indices.filter { articlesMatch(cachedArticles[$0], target) }
				guard matchingIndices.isEmpty == false else {
					continue
				}
				previousValues[collectionID] = matchingIndices.map { cachedArticles[$0].isRead }
				for index in matchingIndices {
					cachedArticles[index].isRead = true
				}
				articleCache[collectionID] = cachedArticles
			}
			let navigationDeltas = navigationCountDeltas(for: target, fromRead: false, toRead: true)
			applyNavigationCountDeltas(navigationDeltas)
			pendingMutations.append(
				PendingReadMutation(
					article: target,
					mutationID: mutationID,
					previousValues: previousValues,
					navigationDeltas: navigationDeltas,
				),
			)
		}
		reconcileCurrentArticleSelection()

		let results = await withTaskGroup(of: ReadMutationResult.self) { group in
			for pendingMutation in pendingMutations {
				group.addTask {
					do {
						try Task.checkCancellation()
						try await apiClient.updateItemState(
							readerId: pendingMutation.article.readerId,
							tag: "user/-/state/com.google/read",
							enabled: true,
						)
						return ReadMutationResult(
							articleID: pendingMutation.article.id,
							succeeded: true,
							wasCancelled: false,
							errorDescription: nil,
						)
					} catch let error where isCancellation(error) {
						return ReadMutationResult(
							articleID: pendingMutation.article.id,
							succeeded: false,
							wasCancelled: true,
							errorDescription: nil,
						)
					} catch {
						return ReadMutationResult(
							articleID: pendingMutation.article.id,
							succeeded: false,
							wasCancelled: false,
							errorDescription: error.localizedDescription,
						)
					}
				}
			}

			var results: [ReadMutationResult] = []
			for await result in group {
				results.append(result)
			}
			return results
		}

		let resultsByID = Dictionary(uniqueKeysWithValues: results.map { ($0.articleID, $0) })
		var succeededCount = 0
		var failedTitles: [String] = []
		var firstFailureDescription: String?
		for pendingMutation in pendingMutations {
			guard let result = resultsByID[pendingMutation.article.id] else {
				failedTitles.append(pendingMutation.article.title)
				firstFailureDescription = firstFailureDescription ?? "The request did not return a result."
				_ = rollbackReadMutationIfCurrent(pendingMutation)
				continue
			}
			if result.succeeded {
				succeededCount += 1
				if activeMutationIDs[pendingMutation.mutationKey] == pendingMutation.mutationID {
					activeMutationIDs[pendingMutation.mutationKey] = nil
				}
				continue
			}

			if result.wasCancelled == false {
				failedTitles.append(pendingMutation.article.title)
				firstFailureDescription = firstFailureDescription ?? result.errorDescription
			}
			_ = rollbackReadMutationIfCurrent(pendingMutation)
		}

		guard failedTitles.isEmpty == false else {
			return
		}
		let failedSummary = failedTitles.joined(separator: ", ")
		let detail = firstFailureDescription.map { " \($0)" } ?? ""
		errorMessage = "Marked \(succeededCount) of \(pendingMutations.count) stories as read. Failed: \(failedSummary).\(detail)"
	}

	private func rollbackReadMutationIfCurrent(_ mutation: PendingReadMutation) -> Bool {
		guard activeMutationIDs[mutation.mutationKey] == mutation.mutationID else {
			return false
		}
		for (collectionID, previousValues) in mutation.previousValues {
			guard var cachedArticles = articleCache[collectionID] else {
				continue
			}
			var previousIndex = 0
			for index in cachedArticles.indices where articlesMatch(cachedArticles[index], mutation.article) {
				guard previousIndex < previousValues.count else {
					break
				}
				if cachedArticles[index].isRead {
					cachedArticles[index].isRead = previousValues[previousIndex]
				}
				previousIndex += 1
			}
			articleCache[collectionID] = cachedArticles
		}
		activeMutationIDs[mutation.mutationKey] = nil
		applyNavigationCountDeltas(mutation.navigationDeltas.mapValues { -$0 })
		reconcileCurrentArticleSelection()
		return true
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
		keyPath: WritableKeyPath<Recommendation, Bool>,
		tag: String
	) async {
		guard let apiClient else {
			return
		}
		let mutationKey = "\(article.id)|\(mutationName)"
		let mutationID = UUID()
		activeMutationIDs[mutationKey] = mutationID
		defer {
			if activeMutationIDs[mutationKey] == mutationID {
				activeMutationIDs[mutationKey] = nil
			}
		}

		let previousNavigation = navigation
		var previousValues: [String: Bool] = [:]
		for collectionID in articleCache.keys {
			guard let index = articleCache[collectionID]?.firstIndex(where: { articlesMatch($0, article) }) else {
				continue
			}
			previousValues[collectionID] = articleCache[collectionID]?[index][keyPath: keyPath] ?? value
			articleCache[collectionID]?[index][keyPath: keyPath] = value
		}
		if mutationName == "read" {
			adjustNavigationCounts(for: article, fromRead: article.isRead, toRead: value)
			reconcileCurrentArticleSelection()
		} else if mutationName == "starred" {
			adjustStarredNavigationCount(for: article, fromStarred: article.isStarred, toStarred: value)
		}

		do {
			try await apiClient.updateItemState(readerId: article.readerId, tag: tag, enabled: value)
			if hasLoadedNavigation {
				await loadNavigation(force: true)
			}
		} catch let error where isCancellation(error) {
			rollbackStateIfCurrent(
				articleID: article.id,
				value: value,
				keyPath: keyPath,
				mutationKey: mutationKey,
				mutationID: mutationID,
				previousValues: previousValues,
				previousNavigation: previousNavigation,
			)
		} catch {
			guard activeMutationIDs[mutationKey] == mutationID else {
				return
			}
			rollbackStateIfCurrent(
				articleID: article.id,
				value: value,
				keyPath: keyPath,
				mutationKey: mutationKey,
				mutationID: mutationID,
				previousValues: previousValues,
				previousNavigation: previousNavigation,
			)
			errorMessage = error.localizedDescription
		}
	}

	private func rollbackStateIfCurrent(
		articleID: String,
		value: Bool,
		keyPath: WritableKeyPath<Recommendation, Bool>,
		mutationKey: String,
		mutationID: UUID,
		previousValues: [String: Bool],
		previousNavigation: ReaderNavigationState,
	) {
		guard activeMutationIDs[mutationKey] == mutationID else {
			return
		}
		for (collectionID, previousValue) in previousValues {
			guard let index = articleCache[collectionID]?.firstIndex(where: { $0.id == articleID || $0.readerId == articleID }) else {
				continue
			}
			guard articleCache[collectionID]?[index][keyPath: keyPath] == value else {
				continue
			}
			articleCache[collectionID]?[index][keyPath: keyPath] = previousValue
		}
		navigation = previousNavigation
		reconcileCurrentArticleSelection()
	}
}
