import SwiftUI
import WebKit

struct StructuredHTMLView: UIViewRepresentable {
	let html: String
	let baseURL: URL?
	let textScale: Double
	let lineHeight: Double
	@Binding var contentHeight: CGFloat
	let onLink: (URL) -> Void
	let onImage: (URL, URL?) -> Void
	let onImageFailure: ([URL]) -> Void

	func makeCoordinator() -> Coordinator {
		let heightBinding = _contentHeight
		return Coordinator(
			onLink: onLink,
			onImage: onImage,
			onImageFailure: onImageFailure,
			onHeight: { height in
				heightBinding.wrappedValue = height
			},
		)
	}

	func makeUIView(context: Context) -> WKWebView {
		let configuration = WKWebViewConfiguration()
		configuration.websiteDataStore = .nonPersistent()
		configuration.defaultWebpagePreferences.allowsContentJavaScript = true
		configuration.userContentController.add(context.coordinator, name: "pigeonEvent")

		let webView = WKWebView(frame: .zero, configuration: configuration)
		webView.navigationDelegate = context.coordinator
		webView.allowsLinkPreview = false
		webView.isOpaque = false
		webView.backgroundColor = .clear
		webView.scrollView.isScrollEnabled = false
		webView.scrollView.alwaysBounceVertical = false
		webView.scrollView.alwaysBounceHorizontal = false
		context.coordinator.webView = webView
		context.coordinator.loadShell(baseURL: baseURL)
		return webView
	}

	func updateUIView(_ webView: WKWebView, context: Context) {
		let heightBinding = _contentHeight
		context.coordinator.onLink = onLink
		context.coordinator.onImage = onImage
		context.coordinator.onImageFailure = onImageFailure
		context.coordinator.onHeight = { height in
			heightBinding.wrappedValue = height
		}
		context.coordinator.render(
			html: html,
			baseURL: baseURL,
			textScale: textScale,
			lineHeight: lineHeight,
		)
	}

	final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
		weak var webView: WKWebView?
		var onLink: (URL) -> Void
		var onImage: (URL, URL?) -> Void
		var onImageFailure: ([URL]) -> Void
		var onHeight: (CGFloat) -> Void
		private var isShellLoaded = false
		private var pendingPayload: Payload?
		private var renderedSignature: String?

		init(
			onLink: @escaping (URL) -> Void,
			onImage: @escaping (URL, URL?) -> Void,
			onImageFailure: @escaping ([URL]) -> Void,
			onHeight: @escaping (CGFloat) -> Void,
		) {
			self.onLink = onLink
			self.onImage = onImage
			self.onImageFailure = onImageFailure
			self.onHeight = onHeight
			super.init()
		}

		func loadShell(baseURL: URL?) {
			webView?.loadHTMLString(StructuredHTMLJavaScript.renderingShell, baseURL: baseURL)
		}

		func render(html: String, baseURL: URL?, textScale: Double, lineHeight: Double) {
			let payload = Payload(
				html: html,
				baseURL: baseURL?.absoluteString,
				textScale: textScale,
				lineHeight: lineHeight,
			)
			pendingPayload = payload
			guard isShellLoaded, payload.signature != renderedSignature else {
				return
			}
			evaluate(payload)
		}

		func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
			guard let payload = message.body as? [String: Any], let kind = payload["kind"] as? String else {
				return
			}

			switch kind {
			case "height":
				if let value = payload["value"] as? NSNumber {
					onHeight(max(CGFloat(value.doubleValue), 1))
				}
			case "link":
				guard let rawURL = payload["url"] as? String,
					let url = StructuredHTMLSanitizer.safeWebURL(rawURL, relativeTo: nil) else { return }
				onLink(url)
			case "image":
				guard let rawImageURL = payload["imageURL"] as? String,
					let imageURL = StructuredHTMLSanitizer.safeWebURL(rawImageURL, relativeTo: nil) else { return }
				let linkURL = (payload["linkURL"] as? String).flatMap { StructuredHTMLSanitizer.safeWebURL($0, relativeTo: nil) }
				onImage(imageURL, linkURL)
			case "image-error":
				var sourceURLs: [URL] = []
				for rawURL in payload["sourceURLs"] as? [String] ?? [] {
					guard let url = StructuredHTMLSanitizer.safeWebURL(rawURL, relativeTo: nil), sourceURLs.contains(url) == false else {
						continue
					}
					sourceURLs.append(url)
				}
				if sourceURLs.isEmpty,
					let rawImageURL = payload["imageURL"] as? String,
					let imageURL = StructuredHTMLSanitizer.safeWebURL(rawImageURL, relativeTo: nil) {
					sourceURLs = [imageURL]
				}
				onImageFailure(sourceURLs)
			default:
				return
			}
		}

		func webView(
			_ webView: WKWebView,
			decidePolicyFor navigationAction: WKNavigationAction,
			decisionHandler: @MainActor @escaping (WKNavigationActionPolicy) -> Void,
		) {
			if navigationAction.navigationType == .linkActivated {
				decisionHandler(.cancel)
			} else {
				decisionHandler(.allow)
			}
		}

		func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
			isShellLoaded = true
			if let pendingPayload {
				evaluate(pendingPayload)
			}
		}

		private func evaluate(_ payload: Payload) {
			guard let data = try? JSONSerialization.data(withJSONObject: payload.dictionary),
				let json = String(data: data, encoding: .utf8) else {
				return
			}
			webView?.evaluateJavaScript("window.__pigeonRender(\(json));") { [weak self] _, _ in
				guard let self else { return }
				self.renderedSignature = payload.signature
			}
		}

		private struct Payload {
			let html: String
			let baseURL: String?
			let textScale: Double
			let lineHeight: Double

			var signature: String {
				"\(html)|\(baseURL ?? "")|\(textScale)|\(lineHeight)"
			}

			var dictionary: [String: Any] {
				var dictionary: [String: Any] = [
					"html": html,
					"textScale": textScale,
					"lineHeight": lineHeight,
				]
				if let baseURL {
					dictionary["baseURL"] = baseURL
				}
				return dictionary
			}
		}
	}
}
