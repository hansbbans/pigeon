import UIKit
import WebKit

/// Forwards script messages to whichever reader currently owns the web view.
/// A web view made ahead of time has no reader yet, and the message handler is
/// fixed when its configuration is created.
final class ReaderScriptMessageRelay: NSObject, WKScriptMessageHandler {
	weak var target: (any WKScriptMessageHandler)?

	func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
		target?.userContentController(userContentController, didReceive: message)
	}
}

/// Keeps one reader web view ready for the next story.
///
/// Creating a `WKWebView` and starting its content process happened on the
/// main thread at the moment a story opened. The pool makes the next one
/// while the app is idle. Each story still gets a web view of its own, with
/// its own non-persistent data store: a view is handed out once and never
/// reused, so nothing a page stores is visible to the next story.
final class ReaderWebViewPool {
	static let shared = ReaderWebViewPool()

	struct Entry {
		let webView: WKWebView
		let relay: ReaderScriptMessageRelay
	}

	nonisolated static let refillDelay: Duration = .milliseconds(1500)

	private var spare: (entry: Entry, session: PigeonSession?)?
	private var refill: Task<Void, Never>?
	private var memoryWarningObserver: (any NSObjectProtocol)?

	init() {
		memoryWarningObserver = NotificationCenter.default.addObserver(
			forName: UIApplication.didReceiveMemoryWarningNotification,
			object: nil,
			queue: .main,
		) { [weak self] _ in
			MainActor.assumeIsolated { self?.drain() }
		}
	}

	var hasSpare: Bool { spare != nil }

	/// The ready web view when it was made for `session`, otherwise a new one.
	/// Either way another is made shortly afterwards.
	func take(session: PigeonSession?) -> Entry {
		let entry: Entry
		if let spare, spare.session == session {
			entry = spare.entry
		} else {
			entry = Self.makeEntry(session: session)
		}
		spare = nil
		scheduleRefill(session: session)
		return entry
	}

	/// Makes the spare now, unless one for `session` is already waiting.
	func prewarm(session: PigeonSession?) {
		if let spare, spare.session == session { return }
		let entry = Self.makeEntry(session: session)
		// A web view starts its content process on its first load.
		entry.webView.loadHTMLString(StructuredHTMLJavaScript.renderingShell, baseURL: nil)
		spare = (entry, session)
	}

	func drain() {
		refill?.cancel()
		refill = nil
		spare = nil
	}

	private func scheduleRefill(session: PigeonSession?) {
		refill?.cancel()
		refill = Task { [weak self] in
			try? await Task.sleep(for: Self.refillDelay)
			guard Task.isCancelled == false else { return }
			self?.prewarm(session: session)
		}
	}

	private static func makeEntry(session: PigeonSession?) -> Entry {
		let relay = ReaderScriptMessageRelay()
		let configuration = WKWebViewConfiguration()
		configuration.websiteDataStore = .nonPersistent()
		configuration.defaultWebpagePreferences.allowsContentJavaScript = true
		configuration.userContentController.add(relay, name: "pigeonEvent")
		configuration.setURLSchemeHandler(
			PrivacyImageSchemeHandler(session: session),
			forURLScheme: "pigeon-image",
		)

		let webView = WKWebView(frame: .zero, configuration: configuration)
		// WebKit asks the UI delegate for a link's context menu only while link
		// previews are allowed. The delegate returns Pigeon's own menu with no
		// preview, so a long press never loads the page.
		webView.allowsLinkPreview = true
		webView.isOpaque = false
		webView.backgroundColor = .clear
		webView.scrollView.isScrollEnabled = false
		webView.scrollView.alwaysBounceVertical = false
		webView.scrollView.alwaysBounceHorizontal = false
		webView.scrollView.showsHorizontalScrollIndicator = false
		webView.scrollView.contentInsetAdjustmentBehavior = .never
		webView.setContentHuggingPriority(.required, for: .horizontal)
		webView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
		return Entry(webView: webView, relay: relay)
	}
}
