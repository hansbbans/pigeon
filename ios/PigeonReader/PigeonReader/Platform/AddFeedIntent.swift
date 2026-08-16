import AppIntents
import Foundation

struct AddFeedIntent: AppIntent {
	static let title: LocalizedStringResource = "Add Feed to Pigeon"
	static let description = IntentDescription("Open Pigeon with a website or feed ready to add.")
	static let openAppWhenRun = true

	@Parameter(title: "Website or Feed URL")
	var url: URL

	func perform() async throws -> some IntentResult & ProvidesDialog {
		guard let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme), url.host != nil else {
			throw AddFeedIntentError.invalidURL
		}
		PendingFeedStore.save(url)
		return .result(dialog: "Opening Pigeon to review this feed.")
	}
}

enum AddFeedIntentError: Error, CustomLocalizedStringResourceConvertible {
	case invalidURL

	var localizedStringResource: LocalizedStringResource {
		"Enter a complete HTTP or HTTPS website or feed URL."
	}
}
