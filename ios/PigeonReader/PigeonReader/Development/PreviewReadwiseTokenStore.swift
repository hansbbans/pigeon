#if DEBUG
import Foundation

@MainActor
final class PreviewReadwiseTokenStore: ReadwiseTokenStore {
	func load() throws -> String? {
		ProcessInfo.processInfo.arguments.contains("-reader-save-success") ? "preview-readwise-token" : nil
	}

	func save(_ token: String) throws {}

	func remove() throws {}
}
#endif
