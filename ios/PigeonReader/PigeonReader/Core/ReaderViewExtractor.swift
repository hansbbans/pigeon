import Foundation
import WebKit

@MainActor
protocol ReaderViewExtracting {
	func extract(from url: URL) async throws -> ReaderViewDocument
}

@MainActor
final class ReaderViewExtractor: NSObject, ReaderViewExtracting {
	private static let maximumResponseBytes = 5_000_000

	private let httpClient: any HTTPClient

	init(httpClient: any HTTPClient = URLSessionHTTPClient()) {
		self.httpClient = httpClient
		super.init()
	}

	func extract(from url: URL) async throws -> ReaderViewDocument {
		guard let destination = OutboundDestination(url: url) else {
			throw ReaderViewError.invalidURL
		}

		var request = URLRequest(url: destination.url)
		request.httpMethod = "GET"
		request.setValue("text/html,application/xhtml+xml;q=0.9", forHTTPHeaderField: "Accept")
		request.setValue("Pigeon Reader/1.0", forHTTPHeaderField: "User-Agent")
		let (data, response) = try await httpClient.data(for: request)
		try Task.checkCancellation()
		guard let httpResponse = response as? HTTPURLResponse,
			let responseURL = httpResponse.url,
			let finalDestination = OutboundDestination(url: responseURL),
			["http", "https"].contains(responseURL.scheme?.lowercased()) else {
			throw ReaderViewError.invalidResponse
		}
		guard 200..<300 ~= httpResponse.statusCode else {
			throw ReaderViewError.httpStatus(httpResponse.statusCode)
		}
		guard data.count <= Self.maximumResponseBytes else {
			throw ReaderViewError.responseTooLarge
		}
		if let mimeType = httpResponse.mimeType?.lowercased(), mimeType.contains("html") == false {
			throw ReaderViewError.unsupportedContent
		}
		let sourceHTML = String(decoding: data, as: UTF8.self)
		guard sourceHTML.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
			throw ReaderViewError.extractionFailed
		}

		let session = ReaderViewExtractionSession()
		try await session.loadExtractionShell(baseURL: finalDestination.url)
		try Task.checkCancellation()
		let readabilitySource = try Self.readabilitySource()
		try await session.evaluateScript(readabilitySource + "\nwindow.__PigeonReadability = Readability;\nnull;")
		guard let serializedPayload = try await session.evaluateJavaScript(Self.extractionScript(html: sourceHTML, baseURL: finalDestination.url)),
			let payloadData = serializedPayload.data(using: .utf8),
			let payloadObject = try? JSONSerialization.jsonObject(with: payloadData, options: [.fragmentsAllowed]),
			let payload = payloadObject as? [String: Any] else {
			throw ReaderViewError.extractionFailed
		}
		try Task.checkCancellation()
		let content = StructuredHTMLSanitizer.sanitize(
			html: payload["content"] as? String ?? "",
			baseURL: finalDestination.url,
		)
		var sanitizedPayload = payload
		sanitizedPayload["content"] = content
		return try ReaderViewDocument(payload: sanitizedPayload)
	}

	private static func readabilitySource() throws -> String {
		let bundles = [Bundle(for: ResourceBundleMarker.self), Bundle.main]
		guard let url = bundles.compactMap({ $0.url(forResource: "Readability", withExtension: "js") }).first,
			let source = try? String(contentsOf: url, encoding: .utf8) else {
			throw ReaderViewError.readabilityUnavailable
		}
		return source
	}

	private static func extractionScript(html: String, baseURL: URL) throws -> String {
		guard let htmlData = try? JSONSerialization.data(withJSONObject: [html]),
			let encodedHTML = String(data: htmlData, encoding: .utf8)?.dropFirst().dropLast(),
			let baseData = try? JSONSerialization.data(withJSONObject: [baseURL.absoluteString]),
			let encodedBaseURL = String(data: baseData, encoding: .utf8)?.dropFirst().dropLast() else {
			throw ReaderViewError.extractionFailed
		}

		return """
		(function() {
			\(StructuredHTMLJavaScript.sanitizationFunctions)
			const rawHTML = \(encodedHTML);
			const baseURL = \(encodedBaseURL);
			const source = document.implementation.createHTMLDocument("");
			source.documentElement.innerHTML = rawHTML;
			const metaImage = source.querySelector('meta[property="og:image"], meta[name="twitter:image"]');
			const metadataImage = metaImage ? __pigeonSafeURL(metaImage.getAttribute("content"), baseURL) : null;
			__pigeonSanitizeRoot(source.documentElement, baseURL);
			document.documentElement.replaceWith(document.importNode(source.documentElement, true));
			const article = new window.__PigeonReadability(document, { debug: false, charThreshold: 0 }).parse();
			if (!article || !article.content) return null;
			const output = document.createElement("template");
			output.innerHTML = article.content;
			__pigeonSanitizeRoot(output.content, baseURL);
			const firstImage = output.content.querySelector("img");
			const contentImage = firstImage ? __pigeonSafeURL(firstImage.getAttribute("src") || firstImage.getAttribute("data-src"), baseURL) : null;
			return {
				title: article.title || document.title || null,
				byline: article.byline || null,
				excerpt: article.excerpt || null,
				content: output.innerHTML,
				leadImageURL: metadataImage || contentImage || null,
			};
		})()
		"""
	}
}

@MainActor
private final class ReaderViewExtractionSession: NSObject, WKNavigationDelegate {
	private let webView: WKWebView
	private var navigationContinuation: CheckedContinuation<Void, Error>?
	private var activeNavigation: WKNavigation?
	private var serializedJavaScriptContinuation: CheckedContinuation<String?, Error>?
	private var activeSerializedJavaScriptID: UInt = 0
	private var voidJavaScriptContinuation: CheckedContinuation<Void, Error>?
	private var activeVoidJavaScriptID: UInt = 0
	private var nextJavaScriptID: UInt = 0

	override init() {
		let configuration = WKWebViewConfiguration()
		configuration.websiteDataStore = .nonPersistent()
		configuration.defaultWebpagePreferences.allowsContentJavaScript = true
		webView = WKWebView(frame: .zero, configuration: configuration)
		super.init()
		webView.navigationDelegate = self
		webView.isHidden = true
	}

	func loadExtractionShell(baseURL: URL) async throws {
		try await withTaskCancellationHandler(operation: {
			try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
				guard Task.isCancelled == false else {
					continuation.resume(throwing: CancellationError())
					return
				}
				navigationContinuation = continuation
				activeNavigation = webView.loadHTMLString(
					"<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width\"></head><body></body></html>",
					baseURL: baseURL,
				)
			}
		}, onCancel: { [weak self] in
			Task { @MainActor [weak self] in
				self?.cancelNavigation()
			}
		})
	}

	func evaluateJavaScript(_ script: String) async throws -> String? {
		try await withTaskCancellationHandler(operation: {
			try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String?, Error>) in
				guard Task.isCancelled == false else {
					continuation.resume(throwing: CancellationError())
					return
				}
				nextJavaScriptID &+= 1
				let evaluationID = nextJavaScriptID
				activeSerializedJavaScriptID = evaluationID
				serializedJavaScriptContinuation = continuation
				webView.evaluateJavaScript("JSON.stringify((\(script)))") { [weak self] result, error in
					self?.finishSerializedJavaScript(id: evaluationID, result: result, error: error)
				}
			}
		}, onCancel: { [weak self] in
			Task { @MainActor [weak self] in
				self?.cancelSerializedJavaScript()
			}
		})
	}

	func evaluateScript(_ script: String) async throws {
		try await withTaskCancellationHandler(operation: {
			try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
				guard Task.isCancelled == false else {
					continuation.resume(throwing: CancellationError())
					return
				}
				nextJavaScriptID &+= 1
				let evaluationID = nextJavaScriptID
				activeVoidJavaScriptID = evaluationID
				voidJavaScriptContinuation = continuation
				webView.evaluateJavaScript(script) { [weak self] _, error in
					self?.finishVoidJavaScript(id: evaluationID, error: error)
				}
			}
		}, onCancel: { [weak self] in
			Task { @MainActor [weak self] in
				self?.cancelVoidJavaScript()
			}
		})
	}

	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		finishNavigation(navigation: navigation, result: .success(()))
	}

	func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
		finishNavigation(navigation: navigation, result: .failure(ReaderViewError.invalidResponse))
	}

	func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
		finishNavigation(navigation: navigation, result: .failure(ReaderViewError.invalidResponse))
	}

	private func finishNavigation(navigation: WKNavigation?, result: Result<Void, Error>) {
		guard let activeNavigation, let navigation, activeNavigation === navigation else { return }
		guard let continuation = navigationContinuation else { return }
		self.activeNavigation = nil
		navigationContinuation = nil
		continuation.resume(with: result)
	}

	private func cancelNavigation() {
		guard let activeNavigation else { return }
		webView.stopLoading()
		finishNavigation(navigation: activeNavigation, result: .failure(CancellationError()))
	}

	private func finishSerializedJavaScript(id: UInt, result: Any?, error: Error?) {
		guard activeSerializedJavaScriptID == id else { return }
		guard let continuation = serializedJavaScriptContinuation else { return }
		activeSerializedJavaScriptID = 0
		serializedJavaScriptContinuation = nil
		if let error {
			continuation.resume(throwing: error)
		} else if let result = result as? String {
			continuation.resume(returning: result)
		} else {
			continuation.resume(returning: nil)
		}
	}

	private func cancelSerializedJavaScript() {
		guard serializedJavaScriptContinuation != nil else { return }
		webView.stopLoading()
		let evaluationID = activeSerializedJavaScriptID
		finishSerializedJavaScript(id: evaluationID, result: nil, error: CancellationError())
	}

	private func finishVoidJavaScript(id: UInt, error: Error?) {
		guard activeVoidJavaScriptID == id else { return }
		guard let continuation = voidJavaScriptContinuation else { return }
		activeVoidJavaScriptID = 0
		voidJavaScriptContinuation = nil
		if let error {
			continuation.resume(throwing: error)
		} else {
			continuation.resume()
		}
	}

	private func cancelVoidJavaScript() {
		guard voidJavaScriptContinuation != nil else { return }
		webView.stopLoading()
		let evaluationID = activeVoidJavaScriptID
		finishVoidJavaScript(id: evaluationID, error: CancellationError())
	}
}

private final class ResourceBundleMarker: NSObject {}
