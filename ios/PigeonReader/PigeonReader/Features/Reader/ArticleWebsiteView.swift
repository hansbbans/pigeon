import SafariServices
import SwiftUI

struct ArticleWebsiteView: UIViewControllerRepresentable {
	let url: URL

	func makeUIViewController(context: Context) -> SFSafariViewController {
		SFSafariViewController(url: url)
	}

	func updateUIViewController(_ viewController: SFSafariViewController, context: Context) {}
}
