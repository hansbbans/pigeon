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

struct SafariView: UIViewControllerRepresentable {
	let url: URL
	/// Set when the view is presented modally: Safari's Done button calls it.
	var onDone: (() -> Void)? = nil

	func makeCoordinator() -> Coordinator {
		Coordinator(onDone: onDone)
	}

	func makeUIViewController(context: Context) -> SFSafariViewController {
		let controller = SFSafariViewController(url: url)
		controller.delegate = context.coordinator
		controller.dismissButtonStyle = onDone == nil ? .done : .close
		return controller
	}

	func updateUIViewController(_ viewController: SFSafariViewController, context: Context) {
		// SFSafariViewController has no API to load a different URL. A new story
		// must create a new controller via `ArticleWebsiteIdentity` on the parent view.
		context.coordinator.onDone = onDone
	}

	final class Coordinator: NSObject, SFSafariViewControllerDelegate {
		var onDone: (() -> Void)?

		init(onDone: (() -> Void)?) {
			self.onDone = onDone
		}

		func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
			onDone?()
		}
	}
}
