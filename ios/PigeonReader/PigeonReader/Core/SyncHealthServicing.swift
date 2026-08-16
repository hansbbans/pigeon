import Foundation

protocol SyncHealthServicing: Sendable {
	func syncHealth() async throws -> SyncHealthSnapshot
	func retryFeed(feedKey: String) async throws
}

extension PigeonAPIClient: SyncHealthServicing {}
