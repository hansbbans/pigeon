import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
final class ReaderAppModel {
	var session: PigeonSession?
	var serverURLText = ""
	var password = ""
	var selectedDestination: ReaderDestination = .section(.forYou)
	var selectedArticleID: String?
	var preferredCompactColumn: NavigationSplitViewColumn = .sidebar
	var isConnecting = false
	var isLoadingLibrary = false
	var errorMessage: String?
	var isShowingSettings = false
	private(set) var subscriptions: [FeedSubscription] = []

	private let sessionStore: any SessionStore
	private let httpClient: any HTTPClient
	private var apiClient: PigeonAPIClient?
	private var articleCache: [ReaderSection: [Recommendation]] = [:]
	private var sortOrders: [ReaderSection: ArticleSortOrder] = [:]
	private var selectedArticleIDs: [ReaderDestination: String] = [:]
	private var loadingSections: Set<ReaderSection> = []
	private var activeLoadIDs: [ReaderSection: UUID] = [:]
	private var activeLibraryLoadID: UUID?
	private var activeMutationIDs: [String: UUID] = [:]
	private var engagement = EngagementAggregator()
	private var sentScrollThresholds: [String: Set<Int>] = [:]

	init(
		sessionStore: any SessionStore = KeychainSessionStore(),
		httpClient: any HTTPClient = URLSessionHTTPClient()
	) {
		self.sessionStore = sessionStore
		self.httpClient = httpClient
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

	var articles: [Recommendation] {
		get { articles(for: selectedDestination) }
		set { setArticles(newValue, for: selectedDestination.sourceSection) }
	}

	var selectedSection: ReaderSection {
		selectedDestination.sourceSection
	}

	var sortOrder: ArticleSortOrder {
		get { sortOrder(for: selectedSection) }
		set { setSortOrder(newValue, for: selectedSection) }
	}

	var selectedDestinationTitle: String {
		switch selectedDestination {
		case .section(let section): section.title
		case .allFeeds: "All Feeds"
		case .folder(let name): name
		case .feed(let id): subscription(id: id)?.title ?? "Feed"
		}
	}

	var folders: [FeedFolder] {
		let names = Set(subscriptions.flatMap(\.folderNames))
		return names.map { name in
			FeedFolder(
				name: name,
				subscriptions: sortedSubscriptions(subscriptions.filter { $0.folderNames.contains(name) })
			)
		}.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
	}

	var unfiledSubscriptions: [FeedSubscription] {
		sortedSubscriptions(subscriptions.filter { $0.categories.isEmpty })
	}

	var selectedArticle: Recommendation? {
		guard let selectedArticleID else {
			return nil
		}
		return articles.first(where: { $0.id == selectedArticleID })
	}

	var isLoading: Bool {
		loadingSections.contains(selectedDestination.sourceSection)
	}

	func isLoading(section: ReaderSection) -> Bool {
		loadingSections.contains(section)
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
			session = newSession
			serverURLText = newSession.baseURL.absoluteString
			password = ""
			apiClient = PigeonAPIClient(session: newSession, httpClient: httpClient)
			select(section: .forYou)
			async let library: Void = loadLibrary(force: true)
			async let stories: Void = load(section: .forYou, force: true)
			_ = await (library, stories)
		} catch is CancellationError {
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
			selectedArticleIDs = [:]
			subscriptions = []
			selectedArticleID = nil
			selectedDestination = .section(.forYou)
			preferredCompactColumn = .sidebar
			errorMessage = nil
		} catch {
			errorMessage = error.localizedDescription
		}
	}

	func select(section: ReaderSection) {
		select(destination: .section(section))
	}

	func select(destination: ReaderDestination) {
		selectedDestination = destination
		selectedArticleID = selectedArticleIDs[destination].flatMap { rememberedID in
			articles(for: destination).contains(where: { $0.id == rememberedID }) ? rememberedID : nil
		}
		preferredCompactColumn = .content
	}

	func select(article: Recommendation) {
		guard articles.contains(where: { $0.id == article.id }) else {
			return
		}
		selectedArticleID = article.id
		selectedArticleIDs[selectedDestination] = article.id
		preferredCompactColumn = .detail
	}

	func selectAdjacentArticle(offset: Int) {
		guard offset != 0, let selectedArticleID,
			let index = articles.firstIndex(where: { $0.id == selectedArticleID }) else {
			return
		}
		let target = index + offset
		guard articles.indices.contains(target) else {
			return
		}
		select(article: articles[target])
	}

	func canSelectAdjacentArticle(offset: Int) -> Bool {
		guard let selectedArticleID,
			let index = articles.firstIndex(where: { $0.id == selectedArticleID }) else {
			return false
		}
		return articles.indices.contains(index + offset)
	}

	func load(destination: ReaderDestination, force: Bool = false) async {
		if case .folder = destination {
			await loadLibrary()
		} else if case .feed = destination {
			await loadLibrary()
		}
		await load(section: destination.sourceSection, force: force)
	}

	func load(section: ReaderSection, force: Bool = false) async {
		guard let apiClient else {
			return
		}
		if force == false, articleCache[section] != nil {
			return
		}

		let loadID = UUID()
		activeLoadIDs[section] = loadID
		loadingSections.insert(section)
		if selectedDestination.sourceSection == section {
			errorMessage = nil
		}

		defer {
			if activeLoadIDs[section] == loadID {
				activeLoadIDs[section] = nil
				loadingSections.remove(section)
			}
		}

		do {
			let loadedArticles = try await apiClient.recommendations(for: section, limit: section == .unread ? 100 : 30)
			try Task.checkCancellation()
			guard activeLoadIDs[section] == loadID else {
				return
			}
			setArticles(loadedArticles, for: section)
		} catch is CancellationError {
			return
		} catch {
			guard activeLoadIDs[section] == loadID, selectedDestination.sourceSection == section else {
				return
			}
			errorMessage = error.localizedDescription
		}
	}

	func articles(for section: ReaderSection) -> [Recommendation] {
		articleCache[section] ?? []
	}

	func sortOrder(for section: ReaderSection) -> ArticleSortOrder {
		sortOrders[section] ?? ArticleSortOrder.defaultOrder(for: section)
	}

	func setSortOrder(_ newSortOrder: ArticleSortOrder, for section: ReaderSection) {
		guard sortOrder(for: section) != newSortOrder else {
			return
		}
		sortOrders[section] = newSortOrder
		if let cachedArticles = articleCache[section] {
			articleCache[section] = newSortOrder.sorted(cachedArticles)
		}
	}

	func articles(for destination: ReaderDestination) -> [Recommendation] {
		let source = articleCache[destination.sourceSection] ?? []
		switch destination {
		case .section, .allFeeds:
			return source
		case .folder(let name):
			let feedKeys = Set(subscriptions.filter { $0.folderNames.contains(name) }.map(\.feedKey))
			return source.filter { feedKeys.contains($0.feedKey) }
		case .feed(let id):
			guard let feedKey = subscription(id: id)?.feedKey else {
				return []
			}
			return source.filter { $0.feedKey == feedKey }
		}
	}

	func setArticles(_ newArticles: [Recommendation], for section: ReaderSection) {
		articleCache[section] = sortOrder(for: section).sorted(newArticles)
		guard selectedDestination.sourceSection == section,
			let rememberedID = selectedArticleIDs[selectedDestination] else {
			return
		}
		guard articles(for: selectedDestination).contains(where: { $0.id == rememberedID }) else {
			selectedArticleIDs[selectedDestination] = nil
			if selectedDestination.sourceSection == section {
				selectedArticleID = nil
				preferredCompactColumn = .content
			}
			return
		}
		selectedArticleID = rememberedID
	}

	func article(withId id: String) -> Recommendation? {
		if let current = articles.first(where: { $0.id == id }) {
			return current
		}
		for section in ReaderSection.allCases {
			if let article = articleCache[section]?.first(where: { $0.id == id }) {
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
		} catch is CancellationError {
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
		guard type == .notInterested, selectedDestination == .section(.forYou) else {
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
		let previousItems = articleCache[.forYou] ?? []
		let forYouDestination = ReaderDestination.section(.forYou)
		let previousSelection = selectedArticleIDs[forYouDestination]
		articleCache[.forYou]?.removeAll(where: { $0.id == article.id })
		if selectedArticleIDs[forYouDestination] == article.id {
			selectedArticleIDs[forYouDestination] = nil
			if selectedDestination == .section(.forYou) {
				selectedArticleID = nil
				preferredCompactColumn = .content
			}
		}

		let succeeded = await send(EngagementEvent(itemId: article.id, type: type))
		guard succeeded == false, activeMutationIDs[mutationKey] == mutationID else {
			return
		}
		articleCache[.forYou] = previousItems
		selectedArticleIDs[forYouDestination] = previousSelection
		if selectedDestination == .section(.forYou), selectedArticleID == nil {
			selectedArticleID = previousSelection
			preferredCompactColumn = previousSelection == nil ? .content : .detail
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
		} catch is CancellationError {
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
		validateLibrarySelection()
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
			return true
		} catch is CancellationError {
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
		let mutationID = beginMutation(key: "feed-title:\(subscription.id)")
		updateSubscription(id: subscription.id) { $0.title = title }

		do {
			try await apiClient.editSubscription(id: subscription.id, title: title)
			finishMutation(key: "feed-title:\(subscription.id)", id: mutationID)
			return true
		} catch is CancellationError {
			rollbackSubscription(subscription, key: "feed-title:\(subscription.id)", id: mutationID)
			return false
		} catch {
			rollbackSubscription(subscription, key: "feed-title:\(subscription.id)", id: mutationID)
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
				removingFolders: subscription.folderNames.filter { $0 != folder }
			)
			finishMutation(key: mutationKey, id: mutationID)
			return true
		} catch is CancellationError {
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
		let wasSelected = selectedDestination == .feed(subscription.id)
		subscriptions.removeAll { $0.id == subscription.id }
		validateLibrarySelection()

		do {
			try await apiClient.unsubscribe(id: subscription.id)
			finishMutation(key: mutationKey, id: mutationID)
			return true
		} catch is CancellationError {
			rollbackSubscription(subscription, key: mutationKey, id: mutationID)
			if wasSelected { select(destination: .feed(subscription.id)) }
			return false
		} catch {
			rollbackSubscription(subscription, key: mutationKey, id: mutationID)
			if wasSelected { select(destination: .feed(subscription.id)) }
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
					removingFolders: [oldName]
				)
			}
			return true
		} catch is CancellationError {
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
		if selectedDestination == .folder(name) {
			select(destination: .allFeeds)
		}

		do {
			for subscription in affected {
				try Task.checkCancellation()
				try await apiClient.editSubscription(id: subscription.id, removingFolders: [name])
			}
			return true
		} catch is CancellationError {
			await loadLibrary(force: true)
			return false
		} catch {
			errorMessage = error.localizedDescription
			await loadLibrary(force: true)
			return false
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
		validateLibrarySelection()
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

	private func validateLibrarySelection() {
		let isValid: Bool
		switch selectedDestination {
		case .section, .allFeeds:
			isValid = true
		case .folder(let name):
			isValid = subscriptions.contains { $0.folderNames.contains(name) }
		case .feed(let id):
			isValid = subscriptions.contains { $0.id == id }
		}
		guard isValid == false else {
			return
		}
		selectedDestination = .allFeeds
		selectedArticleID = selectedArticleIDs[.allFeeds]
		preferredCompactColumn = .content
	}

	private func applyFolderRename(from oldName: String, to newName: String) {
		for index in subscriptions.indices {
			for categoryIndex in subscriptions[index].categories.indices where subscriptions[index].categories[categoryIndex].label == oldName {
				subscriptions[index].categories[categoryIndex] = FeedCategory(
					id: "user/-/label/\(newName)",
					label: newName
				)
			}
		}
		let oldDestination = ReaderDestination.folder(oldName)
		let newDestination = ReaderDestination.folder(newName)
		if let remembered = selectedArticleIDs.removeValue(forKey: oldDestination) {
			selectedArticleIDs[newDestination] = remembered
		}
		if selectedDestination == oldDestination {
			selectedDestination = newDestination
		}
	}

	@discardableResult
	private func send(_ event: EngagementEvent) async -> Bool {
		guard let apiClient else {
			return false
		}
		do {
			try await apiClient.sendEngagement([event])
			return true
		} catch is CancellationError {
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

		var previousValues: [ReaderSection: Bool] = [:]
		for section in ReaderSection.allCases {
			guard let index = articleCache[section]?.firstIndex(where: { $0.id == article.id }) else {
				continue
			}
			previousValues[section] = articleCache[section]?[index][keyPath: keyPath]
			articleCache[section]?[index][keyPath: keyPath] = value
		}

		do {
			try await apiClient.updateItemState(readerId: article.readerId, tag: tag, enabled: value)
		} catch is CancellationError {
			rollbackStateIfCurrent(
				articleID: article.id,
				value: value,
				keyPath: keyPath,
				mutationKey: mutationKey,
				mutationID: mutationID,
				previousValues: previousValues
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
				previousValues: previousValues
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
		previousValues: [ReaderSection: Bool]
	) {
		guard activeMutationIDs[mutationKey] == mutationID else {
			return
		}
		for (section, previousValue) in previousValues {
			guard let index = articleCache[section]?.firstIndex(where: { $0.id == articleID }) else {
				continue
			}
			guard articleCache[section]?[index][keyPath: keyPath] == value else {
				continue
			}
			articleCache[section]?[index][keyPath: keyPath] = previousValue
		}
	}
}
