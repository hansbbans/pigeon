import Foundation

/// Metadata needed for the home-screen widget. Article HTML is omitted so a
/// large library can be snapshotted without copying newsletter bodies.
nonisolated struct WidgetSnapshotArticleRecord: Sendable {
	let id: String
	let readerId: String
	let title: String
	let source: String
	let receivedAt: Date
	let isRead: Bool
	let isStarred: Bool

	init(
		id: String,
		readerId: String,
		title: String,
		source: String,
		receivedAt: Date,
		isRead: Bool,
		isStarred: Bool,
	) {
		self.id = id
		self.readerId = readerId
		self.title = title
		self.source = source
		self.receivedAt = receivedAt
		self.isRead = isRead
		self.isStarred = isStarred
	}

	init(_ article: Recommendation) {
		self.init(
			id: article.id,
			readerId: article.readerId,
			title: article.title,
			source: article.source,
			receivedAt: article.receivedAt,
			isRead: article.isRead,
			isStarred: article.isStarred,
		)
	}

	fileprivate var aliases: Set<String> {
		ReaderArticleIdentity.aliases(id: id, readerID: readerId)
	}
}

nonisolated struct WidgetSnapshotInput: Sendable {
	var articlesByCollection: [String: [WidgetSnapshotArticleRecord]]
	var unreadCount: Int?
	var starredUnreadCount: Int?
	var starredHasMore: Bool
	var previousStarredCount: Int?
	var generatedAt: Date
}

nonisolated enum WidgetSnapshotBuilder {
	static func make(_ input: WidgetSnapshotInput) -> PigeonWidgetSnapshot {
		let todayID = ReaderSection.today.rawValue
		let forYouID = ReaderSection.forYou.rawValue
		let starredID = ReaderSection.starred.rawValue
		let allArticles = deduplicatedArticles(
			input.articlesByCollection.values
				.flatMap { $0 }
				.sorted(by: recencyDescending)
		)
		let todayAliases = aliasSet(input.articlesByCollection[todayID] ?? [])
		let recent = allArticles.prefix(5).map { article in
			widgetArticle(
				article,
				collection: todayAliases.isDisjoint(with: article.aliases) ? nil : todayID,
			)
		}
		let forYou = deduplicatedArticles(
			(input.articlesByCollection[forYouID] ?? []).filter { $0.isRead == false }
		)
			.prefix(5)
			.map { widgetArticle($0, collection: forYouID) }
		return PigeonWidgetSnapshot(
			generatedAt: input.generatedAt,
			unreadCount: input.unreadCount ?? allArticles.count(where: { $0.isRead == false }),
			starredCount: WidgetStarredCountResolver.resolve(
				cachedCount: input.articlesByCollection[starredID].map { deduplicatedArticles($0).count },
				knownStarredCount: allArticles.count(where: \.isStarred),
				unreadBadge: input.starredUnreadCount ?? 0,
				previousTotal: input.previousStarredCount,
				hasMore: input.starredHasMore,
			),
			recent: Array(recent),
			forYou: Array(forYou),
		)
	}

	private static func recencyDescending(
		_ left: WidgetSnapshotArticleRecord,
		_ right: WidgetSnapshotArticleRecord,
	) -> Bool {
		if left.receivedAt != right.receivedAt {
			return left.receivedAt > right.receivedAt
		}
		if left.id != right.id {
			return left.id < right.id
		}
		return left.readerId < right.readerId
	}

	private static func deduplicatedArticles(
		_ articles: [WidgetSnapshotArticleRecord],
	) -> [WidgetSnapshotArticleRecord] {
		var seen = Set<String>()
		return articles.reduce(into: []) { result, article in
			let aliases = article.aliases
			guard aliases.isEmpty == false, aliases.isDisjoint(with: seen) else {
				return
			}
			seen.formUnion(aliases)
			result.append(article)
		}
	}

	private static func aliasSet(_ articles: [WidgetSnapshotArticleRecord]) -> Set<String> {
		articles.reduce(into: Set<String>()) { result, article in
			result.formUnion(article.aliases)
		}
	}

	private static func widgetArticle(
		_ article: WidgetSnapshotArticleRecord,
		collection: String?,
	) -> PigeonWidgetArticle {
		PigeonWidgetArticle(
			id: article.id,
			title: article.title,
			source: article.source,
			receivedAt: article.receivedAt,
			deepLink: PigeonDeepLink.article(article.id, collection: collection).url,
		)
	}
}
