import Foundation

struct ServerStatusResponse: Decodable, Sendable {
	let syncHealth: SyncHealthSnapshot
}

struct SyncHealthSnapshot: Decodable, Sendable {
	let generatedAt: Date
	let dueCount: Int
	let backedOffCount: Int
	let leasedCount: Int
	let healthyCount: Int
	let feeds: [SyncHealthFeed]
	let recentActivity: [SyncHealthActivity]
}

struct SyncHealthFeed: Decodable, Identifiable, Sendable {
	let feedKey: String
	let title: String
	let host: String
	let state: String
	let lastAttemptAt: Date?
	let lastSuccessAt: Date?
	let nextFetchAt: Date?
	let retryAt: Date?
	let consecutiveFailures: Int
	let httpStatus: Int?
	let outcome: String?
	let durationMs: Int?
	let error: String?
	let canRetry: Bool

	var id: String { feedKey }
}

struct SyncHealthActivity: Decodable, Identifiable, Sendable {
	let feedKey: String
	let title: String
	let attemptedAt: Date
	let outcome: String
	let httpStatus: Int?
	let durationMs: Int
	let itemsProcessed: Int
	let errorCode: String?
	let error: String?
	let retryAt: Date?

	var id: String {
		"\(feedKey)|\(attemptedAt.timeIntervalSince1970)|\(outcome)"
	}
}
