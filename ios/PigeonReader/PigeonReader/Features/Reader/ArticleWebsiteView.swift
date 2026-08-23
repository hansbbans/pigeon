import SafariServices
import SwiftUI

struct ArticleWebsiteView: View {
	let articleID: String
	let url: URL

	var body: some View {
		SafariView(url: url)
			.id(ArticleWebsiteIdentity(articleID: articleID, url: url))
	}
}

private struct SafariView: UIViewControllerRepresentable {
	let url: URL

	func makeUIViewController(context: Context) -> SFSafariViewController {
		SFSafariViewController(url: url)
	}

	func updateUIViewController(_ viewController: SFSafariViewController, context: Context) {
		// SFSafariViewController has no API to load a different URL. A new story
		// must create a new controller via `ArticleWebsiteIdentity` on the parent view.
	}
}
