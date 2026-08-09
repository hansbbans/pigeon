import Foundation
import UIKit

enum ArticleContentFormatter {
	static func make(html: String, fallback: String) -> AttributedString {
		let options: [NSAttributedString.DocumentReadingOptionKey: Any] = [
			.documentType: NSAttributedString.DocumentType.html,
			.characterEncoding: String.Encoding.utf8.rawValue,
		]
		guard let imported = try? NSMutableAttributedString(
			data: Data(html.utf8),
			options: options,
			documentAttributes: nil
		) else {
			return AttributedString(fallback)
		}

		let fullRange = NSRange(location: 0, length: imported.length)
		for attribute in [NSAttributedString.Key.font, .foregroundColor, .backgroundColor] {
			imported.removeAttribute(attribute, range: fullRange)
		}
		return AttributedString(imported)
	}
}
