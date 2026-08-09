import Testing
import UIKit
@testable import PigeonReader

struct ReaderTypographyTests {
	@Test(arguments: [
		"Bookerly-Regular",
		"Bookerly-Bold",
		"Bookerly-Italic",
		"Bookerly-BoldItalic",
	])
	func bundledBookerlyFaceIsRegistered(postScriptName: String) {
		#expect(UIFont(name: postScriptName, size: 17) != nil)
	}
}
