import SwiftUI
import WebKit

/// Hosts YouTube's official iframe player in an isolated, non-persistent web
/// view. The iframe owns playback controls and fullscreen presentation.
struct YouTubePlayerView: View {
	let video: YouTubeVideo
	let playbackAllowed: Bool
	let onOpenYouTube: () -> Void
	let onOpenLink: (URL) -> Void

	@State private var playerFailed = false

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			if playerFailed {
				ContentUnavailableView(
					"YouTube player unavailable",
					systemImage: "play.slash",
					description: Text("Open this video in YouTube to continue watching."),
				)
				.frame(maxWidth: .infinity, minHeight: 200)
			} else {
				YouTubeEmbeddedWebView(
					video: video,
					playbackAllowed: playbackAllowed,
					onReady: { playerFailed = false },
					onFailure: { playerFailed = true },
					onOpenYouTube: onOpenYouTube,
					onOpenLink: onOpenLink,
				)
				.frame(maxWidth: .infinity)
				.aspectRatio(16.0 / 9.0, contentMode: .fit)
				.frame(minWidth: 200, minHeight: 200)
				.clipShape(.rect(cornerRadius: 12))
			}

			Button("Open in YouTube", systemImage: "arrow.up.right.square", action: onOpenYouTube)
			.buttonStyle(.borderless)
			.accessibilityIdentifier("open-youtube")
		}
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("youtube-player-\(video.videoID)")
		.onChange(of: video) { _, _ in
			playerFailed = false
		}
	}
}

private struct YouTubeEmbeddedWebView: UIViewRepresentable {
	let video: YouTubeVideo
	let playbackAllowed: Bool
	let onReady: () -> Void
	let onFailure: () -> Void
	let onOpenYouTube: () -> Void
	let onOpenLink: (URL) -> Void

	func makeCoordinator() -> Coordinator {
		Coordinator(
			onReady: onReady,
			onFailure: onFailure,
			onOpenYouTube: onOpenYouTube,
			onOpenLink: onOpenLink,
		)
	}

	func makeUIView(context: Context) -> WKWebView {
		let configuration = WKWebViewConfiguration()
		configuration.websiteDataStore = .nonPersistent()
		configuration.allowsInlineMediaPlayback = true
		configuration.allowsPictureInPictureMediaPlayback = false
		configuration.mediaTypesRequiringUserActionForPlayback = [.video]
		configuration.defaultWebpagePreferences.allowsContentJavaScript = true
		configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
		configuration.userContentController.add(context.coordinator, name: Coordinator.messageName)

		let webView = WKWebView(frame: .zero, configuration: configuration)
		webView.navigationDelegate = context.coordinator
		webView.uiDelegate = context.coordinator
		webView.allowsLinkPreview = false
		webView.isOpaque = false
		webView.backgroundColor = .black
		webView.scrollView.isScrollEnabled = false
		webView.scrollView.alwaysBounceVertical = false
		webView.scrollView.alwaysBounceHorizontal = false
		webView.accessibilityIdentifier = "youtube-webview-\(video.videoID)"
		context.coordinator.webView = webView
		context.coordinator.load(video: video)
		if playbackAllowed == false {
			context.coordinator.stop()
		}
		return webView
	}

	func updateUIView(_ webView: WKWebView, context: Context) {
		context.coordinator.onReady = onReady
		context.coordinator.onFailure = onFailure
		context.coordinator.onOpenYouTube = onOpenYouTube
		context.coordinator.onOpenLink = onOpenLink
		context.coordinator.update(video: video)
		if playbackAllowed == false {
			context.coordinator.stop()
		}
	}

	static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
		coordinator.teardown()
		webView.navigationDelegate = nil
		webView.uiDelegate = nil
		webView.configuration.userContentController.removeScriptMessageHandler(forName: Coordinator.messageName)
	}

	@MainActor
	final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
		static let messageName = "pigeonYouTube"

		weak var webView: WKWebView?
		var onReady: () -> Void
		var onFailure: () -> Void
		var onOpenYouTube: () -> Void
		var onOpenLink: (URL) -> Void
		private var videoID: String?
		private var didReportFailure = false

		init(
			onReady: @escaping () -> Void,
			onFailure: @escaping () -> Void,
			onOpenYouTube: @escaping () -> Void,
			onOpenLink: @escaping (URL) -> Void,
		) {
			self.onReady = onReady
			self.onFailure = onFailure
			self.onOpenYouTube = onOpenYouTube
			self.onOpenLink = onOpenLink
			super.init()
		}

		func load(video: YouTubeVideo) {
			videoID = video.videoID
			didReportFailure = false
			webView?.loadHTMLString(
				YouTubePlayerHTML.document(videoID: video.videoID),
				baseURL: YouTubePlayerHTML.baseURL,
			)
		}

		func update(video: YouTubeVideo) {
			guard videoID != video.videoID else { return }
			stop()
			load(video: video)
		}

		func stop() {
			webView?.evaluateJavaScript("window.__pigeonStopYouTube && window.__pigeonStopYouTube();")
		}

		func teardown() {
			stop()
			webView?.stopLoading()
		}

		func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
			guard let payload = message.body as? [String: Any], let kind = payload["kind"] as? String else {
				return
			}
			switch kind {
			case "ready":
				onReady()
			case "error":
				reportFailure()
			default:
				break
			}
		}

		func webView(
			_ webView: WKWebView,
			decidePolicyFor navigationAction: WKNavigationAction,
			decisionHandler: @MainActor @escaping (WKNavigationActionPolicy) -> Void,
		) {
			guard let url = navigationAction.request.url else {
				decisionHandler(.cancel)
				return
			}
			let isMainFrame = navigationAction.targetFrame?.isMainFrame == true
			if isMainFrame {
				if Self.isShellURL(url) {
					decisionHandler(.allow)
				} else {
					if navigationAction.navigationType == .linkActivated {
						openUserActivatedLink(url)
					}
					decisionHandler(.cancel)
				}
				return
			}
			if Self.isYouTubeResourceURL(url) {
				decisionHandler(.allow)
			} else {
				if navigationAction.navigationType == .linkActivated {
					openUserActivatedLink(url)
				}
				decisionHandler(.cancel)
			}
		}

		func webView(
			_ webView: WKWebView,
			decidePolicyFor navigationResponse: WKNavigationResponse,
			decisionHandler: @MainActor @escaping (WKNavigationResponsePolicy) -> Void,
		) {
			guard let url = navigationResponse.response.url else {
				decisionHandler(.cancel)
				return
			}
			if navigationResponse.isForMainFrame {
				if Self.isShellURL(url) == false {
					decisionHandler(.cancel)
					return
				}
			} else if Self.isShellURL(url) == false && Self.isYouTubeResourceURL(url) == false {
				decisionHandler(.cancel)
				return
			}
			decisionHandler(.allow)
		}

		func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
			if (error as NSError).code != NSURLErrorCancelled {
				reportFailure()
			}
		}

		func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
			if (error as NSError).code != NSURLErrorCancelled {
				reportFailure()
			}
		}

		func webView(
			_ webView: WKWebView,
			createWebViewWith configuration: WKWebViewConfiguration,
			for navigationAction: WKNavigationAction,
			windowFeatures: WKWindowFeatures,
		) -> WKWebView? {
			// Links opened by the official player stay in the explicit fallback.
			if navigationAction.navigationType == .linkActivated {
				openUserActivatedLink(navigationAction.request.url)
			}
			return nil
		}

		private func reportFailure() {
			guard didReportFailure == false else { return }
			didReportFailure = true
			onFailure()
		}

		private func openUserActivatedLink(_ url: URL?) {
			guard let url, Self.isExternalLink(url) else {
				onOpenYouTube()
				return
			}
			onOpenLink(url)
		}

		private static func isShellURL(_ url: URL) -> Bool {
			if url.scheme?.lowercased() == "about", url.host == nil, url.user == nil, url.password == nil, url.port == nil {
				return true
			}
			return url.scheme?.lowercased() == "https"
				&& url.host?.lowercased() == YouTubePlayerHTML.baseURL.host?.lowercased()
				&& url.user == nil
				&& url.password == nil
				&& url.port == nil
		}

		private static func isExternalLink(_ url: URL) -> Bool {
			guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
				let host = url.host, host.isEmpty == false,
				url.user == nil,
				url.password == nil else { return false }
			return true
		}

		private static func isYouTubeResourceURL(_ url: URL) -> Bool {
			guard url.scheme?.lowercased() == "https",
				let host = url.host?.lowercased(),
				url.user == nil,
				url.password == nil,
				url.port == nil else { return false }
			return host == "youtube.com"
				|| host.hasSuffix(".youtube.com")
				|| host == "youtube-nocookie.com"
				|| host.hasSuffix(".youtube-nocookie.com")
				|| host == "ytimg.com"
				|| host.hasSuffix(".ytimg.com")
				|| host == "googlevideo.com"
				|| host.hasSuffix(".googlevideo.com")
		}
	}
}

private enum YouTubePlayerHTML {
	static let baseURL: URL = {
		let bundleID = Bundle.main.bundleIdentifier?.lowercased() ?? "com.hans.pigeon.reader"
		guard let url = URL(string: "https://\(bundleID)/") else {
			preconditionFailure("The app bundle identifier must produce a valid HTTPS player base URL.")
		}
		return url
	}()

	static func document(videoID: String) -> String {
		let origin = baseURL.absoluteString.dropLast()
		return """
		<!doctype html>
		<html><head>
		<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
		<meta name="referrer" content="strict-origin-when-cross-origin">
		<style>html,body,#player{margin:0;width:100%;height:100%;min-width:200px;min-height:200px;background:#000;overflow:hidden}iframe{width:100%;height:100%;min-width:200px;min-height:200px;border:0}</style>
		</head><body>
		<div id="player"></div>
		<script>
		window.__pigeonStopYouTube = function() { if (window.__pigeonPlayer) { window.__pigeonPlayer.stopVideo(); } };
		function onYouTubeIframeAPIReady() {
			window.__pigeonPlayer = new YT.Player('player', {
				videoId: '\(videoID)',
				playerVars: { autoplay: 0, controls: 1, fs: 1, playsinline: 1, rel: 0, origin: '\(origin)' },
				events: {
					onReady: function() {
						var iframe = document.querySelector('iframe');
						if (iframe) {
							iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
							iframe.setAttribute('allowfullscreen', '');
							iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
						}
						window.webkit.messageHandlers.pigeonYouTube.postMessage({kind:'ready'});
					},
					onError: function() { window.webkit.messageHandlers.pigeonYouTube.postMessage({kind:'error'}); }
				}
			});
		}
		</script>
		<script src="https://www.youtube.com/iframe_api"></script>
		</body></html>
		"""
	}
}
