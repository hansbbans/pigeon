#if DEBUG
import Foundation

@MainActor
enum PreviewData {
	static func makeModel() -> ReaderAppModel {
		guard let baseURL = URL(string: "https://pigeon.preview") else {
			preconditionFailure("The preview URL must be valid")
		}
		let session = PigeonSession(baseURL: baseURL, token: "preview-token")
		let model = ReaderAppModel(
			sessionStore: PreviewSessionStore(session: session),
			httpClient: PreviewHTTPClient(),
			readwiseTokenStore: PreviewReadwiseTokenStore()
		)
		model.setArticles(articles, for: .forYou)
		model.setArticles(articles.filter { $0.isRead == false }, for: .unread)
		model.setArticles(articles.filter(\.isStarred), for: .starred)
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
						categories: [ReaderSubscriptionCategory(id: "user/-/label/Design", label: "Design")],
						url: "https://pigeon.preview/feed/marginal-revolution",
					),
					ReaderSubscription(
						id: "feed/3",
						title: "Stratechery",
						url: "https://pigeon.preview/feed/stratechery",
					),
				],
				unreadCounts: [
					ReaderUnreadCount(id: "feed/1", count: 1),
					ReaderUnreadCount(id: "feed/2", count: 1),
					ReaderUnreadCount(id: "user/-/label/Design", count: 2),
					ReaderUnreadCount(id: "user/-/state/com.google/reading-list", count: 2),
				],
				smartCounts: ReaderNavigationSmartCounts(forYou: 2, today: 1, unread: 2, starred: 1),
			),
				markAsLoaded: true,
			)
			model.select(section: .forYou)
			return model
	}

	static let articles: [Recommendation] = [
		Recommendation(
			id: "preview-1",
			readerId: "tag:google.com,2005:reader/item/0000000000000001",
			feedKey: "dense-discovery",
			source: "Dense Discovery",
			title: "Designing calmer tools for people who read every day",
			html: "<article style='font-family: Papyrus; color: red'><p>Good reading software gets out of the way. It keeps navigation predictable, typography quiet, and the original source one deliberate action away.</p><p><a href='https://example.com/design?private=ignored'>Read the design notes</a> for the longer argument.</p></article>",
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
			learningState: "Learning your interests"
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
	]
}
#endif
