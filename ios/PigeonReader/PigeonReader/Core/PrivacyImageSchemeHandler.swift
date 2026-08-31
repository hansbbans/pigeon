import Foundation
@preconcurrency import WebKit

/// Routes article images through Pigeon's authenticated server-side proxy so a
/// publisher never receives the reader device's network address or cookies.
nonisolated final class PrivacyImageSchemeHandler: NSObject, WKURLSchemeHandler, @unchecked Sendable {
	private let session: PigeonSession?
	private let lock = NSLock()
	private var tasks: [ObjectIdentifier: URLSessionDataTask] = [:]

	init(session: PigeonSession?) {
		self.session = session
	}

	func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
		guard let requestURL = urlSchemeTask.request.url,
			let session,
			let components = URLComponents(url: requestURL, resolvingAgainstBaseURL: false),
			let rawURL = components.queryItems?.first(where: { $0.name == "url" })?.value,
			let remoteURL = URL(string: rawURL),
			let request = PrivacyProxiedImageRequest.authorizedRequest(for: remoteURL, session: session) else {
			fail(urlSchemeTask, code: .badURL)
			return
		}

		let schemeTask = SchemeTaskBox(urlSchemeTask)
		let identifier = ObjectIdentifier(urlSchemeTask as AnyObject)
		let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
			guard self?.removeTask(identifier) == true else { return }
			if let error {
				schemeTask.value.didFailWithError(error)
				return
			}
			guard let data,
				data.count <= PrivacyProxiedImageRequest.maximumResponseBytes,
				let response = response as? HTTPURLResponse,
				(200..<300).contains(response.statusCode),
				let mimeType = response.mimeType,
				mimeType.lowercased().hasPrefix("image/") else {
				self?.fail(schemeTask.value, code: .cannotDecodeContentData)
				return
			}
			let localResponse = URLResponse(
				url: requestURL,
				mimeType: mimeType,
				expectedContentLength: data.count,
				textEncodingName: nil,
			)
			schemeTask.value.didReceive(localResponse)
			schemeTask.value.didReceive(data)
			schemeTask.value.didFinish()
		}
		storeTask(task, identifier: identifier)
		task.resume()
	}

	func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
		let identifier = ObjectIdentifier(urlSchemeTask as AnyObject)
		lock.withLock {
			tasks.removeValue(forKey: identifier)?.cancel()
		}
	}

	private func storeTask(_ task: URLSessionDataTask, identifier: ObjectIdentifier) {
		lock.withLock { tasks[identifier] = task }
	}

	private func removeTask(_ identifier: ObjectIdentifier) -> Bool {
		lock.withLock { tasks.removeValue(forKey: identifier) != nil }
	}

	private func fail(_ task: any WKURLSchemeTask, code: URLError.Code) {
		task.didFailWithError(URLError(code))
	}
}

nonisolated private final class SchemeTaskBox: @unchecked Sendable {
	let value: any WKURLSchemeTask

	init(_ value: any WKURLSchemeTask) {
		self.value = value
	}
}
