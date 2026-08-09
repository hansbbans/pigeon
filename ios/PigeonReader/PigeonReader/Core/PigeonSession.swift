import Foundation

struct PigeonSession: Codable, Equatable, Sendable {
	let baseURL: URL
	let token: String
}
