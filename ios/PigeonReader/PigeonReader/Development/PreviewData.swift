#if DEBUG
import Foundation

@MainActor
enum PreviewData {
	static func makeModel() -> ReaderAppModel {
		let showsToday = ProcessInfo.processInfo.arguments.contains("-reader-today-data")
		let articles = showsToday ? todayArticles : Self.articles
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
				id: "feed/2", title: "Marginal Revolution", categories: [FeedCategory(id: "user/-/label/Technology", label: "Technology")],
				url: baseURL.appending(path: "feed/marginal-revolution"), sourceUrl: URL(string: "https://marginalrevolution.com/feed"),
				htmlUrl: URL(string: "https://marginalrevolution.com"), iconUrl: nil,
			),
			FeedSubscription(
				id: "feed/3", title: "Stratechery", categories: [],
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
						categories: [ReaderSubscriptionCategory(id: "user/-/label/Technology", label: "Technology")],
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
					ReaderUnreadCount(id: "user/-/label/Design", count: 1),
					ReaderUnreadCount(id: "user/-/label/Technology", count: 1),
					ReaderUnreadCount(id: "user/-/state/com.google/reading-list", count: 2),
				],
				smartCounts: ReaderNavigationSmartCounts(forYou: 2, today: 1, unread: 2, starred: 1),
			),
				markAsLoaded: true,
			)
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
	]
}
#endif
