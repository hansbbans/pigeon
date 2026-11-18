import Foundation
@preconcurrency import WebKit

/// Serves the bundled reading fonts to article HTML as `pigeon-font://font/<file>`.
///
/// WebKit renders in a separate process that cannot see fonts the app registers through
/// `UIAppFonts`, so a CSS `font-family: Bookerly` silently fell back to Iowan Old Style. The
/// rendering shell declares each face with `@font-face` pointing here instead. Only the files in
/// `fileNames` are served.
nonisolated final class ReaderFontSchemeHandler: NSObject, WKURLSchemeHandler {
	static let scheme = "pigeon-font"
	static let fileNames: Set<String> = [
		"GeistSerif-Regular.ttf",
		"Bookerly-Regular.ttf",
		"Bookerly-Bold.ttf",
		"Bookerly-Italic.ttf",
		"Bookerly-BoldItalic.ttf",
	]

	private let bundle: Bundle

	init(bundle: Bundle = .main) {
		self.bundle = bundle
	}

	static func url(for fileName: String) -> String {
		"\(scheme)://font/\(fileName)"
	}

	func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
		guard let requestURL = urlSchemeTask.request.url,
			let data = fontData(for: requestURL) else {
			urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
			return
		}
		urlSchemeTask.didReceive(URLResponse(url: requestURL, mimeType: "font/ttf", expectedContentLength: data.count, textEncodingName: nil))
		urlSchemeTask.didReceive(data)
		urlSchemeTask.didFinish()
	}

	func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}

	func fontData(for url: URL) -> Data? {
		guard url.scheme == Self.scheme, url.host() == "font" else { return nil }
		let fileName = url.lastPathComponent
		guard url.path() == "/\(fileName)", Self.fileNames.contains(fileName),
			let fileURL = bundle.url(forResource: (fileName as NSString).deletingPathExtension, withExtension: "ttf") else {
			return nil
		}
		return try? Data(contentsOf: fileURL, options: .mappedIfSafe)
	}
}
