import Foundation

@MainActor
protocol SessionStore {
	func load() throws -> PigeonSession?
	func save(_ session: PigeonSession) throws
	func remove() throws
}
