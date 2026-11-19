import Foundation

/// Hands the bundled reading fonts to article HTML.
///
/// WebKit renders in a separate process that cannot see fonts the app registers through
/// `UIAppFonts`, so a CSS `font-family: Bookerly` silently fell back to Iowan Old Style. The page
/// cannot fetch them either: it is loaded with the article's https URL as its base, and WebKit
/// blocks fonts from a custom URL scheme there as mixed content. So the app passes each face's
/// bytes to `__pigeonInstallFonts`, which adds them with the `FontFace` API. That is not a fetch,
/// so neither mixed-content rules nor the page's CSP apply.
@MainActor
enum ReaderWebFonts {
	nonisolated struct Face: Equatable, Sendable {
		let family: String
		let fileName: String
		var fileExtension = "ttf"
		let weight: Int
		let italic: Bool
	}

	nonisolated static func faces(for typeface: ReaderTypeface) -> [Face] {
		switch typeface {
		case .geistSerif:
			// One face; WebKit synthesizes bold and italic from it.
			[Face(family: "Geist Serif", fileName: "GeistSerif-Regular", weight: 400, italic: false)]
		case .bookerly:
			[
				Face(family: "Bookerly", fileName: "Bookerly-Regular", weight: 400, italic: false),
				Face(family: "Bookerly", fileName: "Bookerly-Bold", weight: 700, italic: false),
				Face(family: "Bookerly", fileName: "Bookerly-Italic", weight: 400, italic: true),
				Face(family: "Bookerly", fileName: "Bookerly-BoldItalic", weight: 700, italic: true),
			]
		case .allo:
			// SemiBold for headings, to match the SwiftUI title; Bold for strong.
			[
				Face(family: "Allo", fileName: "Allo-Regular", fileExtension: "otf", weight: 400, italic: false),
				Face(family: "Allo", fileName: "Allo-SemiBold", fileExtension: "otf", weight: 600, italic: false),
				Face(family: "Allo", fileName: "Allo-Bold", fileExtension: "otf", weight: 700, italic: false),
				Face(family: "Allo", fileName: "Allo-Oblique", fileExtension: "otf", weight: 400, italic: true),
				Face(family: "Allo", fileName: "Allo-BoldOblique", fileExtension: "otf", weight: 700, italic: true),
			]
		}
	}

	private static var scripts: [ReaderTypeface: String] = [:]

	/// JavaScript that installs every face of `typeface`, or nil if a font file is missing.
	/// Built once per typeface (Bookerly is about 2.4 MB of base64) and reused by every reader.
	static func installScript(for typeface: ReaderTypeface, bundle: Bundle = .main) -> String? {
		if let script = scripts[typeface] { return script }
		var entries: [[String: Any]] = []
		for face in faces(for: typeface) {
			guard let url = bundle.url(forResource: face.fileName, withExtension: face.fileExtension),
				let data = try? Data(contentsOf: url, options: .mappedIfSafe) else {
				return nil
			}
			entries.append([
				"family": face.family,
				"weight": String(face.weight),
				"style": face.italic ? "italic" : "normal",
				"data": data.base64EncodedString(),
			])
		}
		guard let json = try? JSONSerialization.data(withJSONObject: entries),
			let list = String(data: json, encoding: .utf8) else {
			return nil
		}
		let script = "window.__pigeonInstallFonts(\(list));"
		scripts[typeface] = script
		return script
	}
}
