import Foundation

@MainActor
protocol ReadwiseTokenStore {
	func load() throws -> String?
	func save(_ token: String) throws
	func remove() throws
}
