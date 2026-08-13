#if DEBUG
import Foundation

@MainActor
final class PreviewReadwiseTokenStore: ReadwiseTokenStore {
	func load() throws -> String? {
		nil
	}

	func save(_ token: String) throws {}

	func remove() throws {}
}
#endif
