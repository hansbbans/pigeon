import SwiftUI

struct ReaderCollectionLoadingView: View {
	let collectionTitle: String
	let density: ReaderTimelineDensity
	@State private var showsProgress = false

	// Reuse the real row so font metrics, line limits, thumbnail space, and
	// native List insets stay aligned as density and Dynamic Type change.
	// Empty HTML and blocked remote images keep this presentation network-free.
	private static let placeholder = Recommendation(
		id: "loading-story", readerId: "", feedKey: "", source: "Publication name",
		title: "A story title that carries naturally onto a second line",
		html: "", text: nil, originalURL: nil, receivedAt: Date(timeIntervalSince1970: 0),
		isRead: false, isStarred: false, score: 0, confidence: 0, sampleCount: 0,
		explanation: "A short description of this story", learningState: "",
	)

	var body: some View {
		List {
			ForEach(0..<5) { _ in
				ArticleRowView(article: Self.placeholder, density: density, remoteImagePolicy: .blocked)
					.redacted(reason: .placeholder)
					.accessibilityHidden(true)
			}
			ProgressView("Loading stories")
				.padding()
				.frame(maxWidth: .infinity)
				.opacity(showsProgress ? 1 : 0)
				.listRowSeparator(.hidden)
				.accessibilityHidden(true)
		}
		.listStyle(.plain)
		.scrollDisabled(true)
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("Loading stories in \(collectionTitle)")
		.accessibilityIdentifier("collection-loading-placeholder")
		.task {
			do {
				try await Task.sleep(for: .milliseconds(200))
				try Task.checkCancellation()
				showsProgress = true
			} catch { }
		}
	}
}
