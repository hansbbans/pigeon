import Foundation

actor OfflineMutationReplayer {
	private let store: any OfflineLibraryStoring

	init(store: any OfflineLibraryStoring) {
		self.store = store
	}

	/// Replays in FIFO pages. Applied and already-applied receipts are both terminal,
	/// which makes a lost HTTP response safe to retry without repeating the mutation.
	@discardableResult
	func replay(accountID: String, apiClient: PigeonAPIClient) async throws -> Int {
		var appliedCount = 0
		while true {
			try Task.checkCancellation()
			let pending = try await store.pendingMutations(accountID: accountID, limit: 100)
			guard pending.isEmpty == false else { return appliedCount }
			var droppedInvalidMutation = false
			for action in pending {
				guard let validationError = Self.permanentValidationError(for: action.mutation) else {
					continue
				}
				try await store.recordMutationFailure(
					id: action.mutation.id,
					message: validationError,
					accountID: accountID,
				)
				try await store.markMutationApplied(id: action.mutation.id, accountID: accountID)
				droppedInvalidMutation = true
			}
			if droppedInvalidMutation {
				continue
			}
			var page: [PendingOfflineMutation] = []
			var itemIDCount = 0
			for action in pending {
				let nextCount = itemIDCount + action.mutation.itemIds.count
				if page.isEmpty == false, nextCount > 200 { break }
				page.append(action)
				itemIDCount = nextCount
			}

			let response: OfflineMutationBatchResponse
			do {
				response = try await apiClient.sendMutations(page.map(\.mutation))
			} catch {
				for action in page {
					try? await store.recordMutationFailure(
						id: action.mutation.id,
						message: error.localizedDescription,
						accountID: accountID,
					)
				}
				throw error
			}
			let results = Dictionary(uniqueKeysWithValues: response.results.map { ($0.mutationId, $0) })
			var pageMadeProgress = false
			var pageHasFailure = false
			for action in page {
				guard let result = results[action.mutation.id] else {
					try await store.recordMutationFailure(
						id: action.mutation.id,
						message: "The server omitted this mutation result.",
						accountID: accountID,
					)
					pageHasFailure = true
					continue
				}
				switch result.status {
				case .applied, .alreadyApplied:
					try await store.markMutationApplied(id: action.mutation.id, accountID: accountID)
					appliedCount += 1
					pageMadeProgress = true
				case .failed:
					try await store.recordMutationFailure(
						id: action.mutation.id,
						message: result.error ?? "The server rejected this mutation.",
						accountID: accountID,
					)
					// The server uses `failed` for retryable resolution and D1 errors.
					// Keep the action queued, but still apply later successful receipts
					// from this page before stopping the replay.
					pageHasFailure = true
				}
			}

			// Omitted receipts stay queued. Stop this replay instead of immediately
			// resending them in a hot loop. Later launches/refreshes retry them.
			if pageHasFailure || pageMadeProgress == false { return appliedCount }
		}
	}

	private static func permanentValidationError(for mutation: OfflineMutation) -> String? {
		guard mutation.id.isEmpty == false, mutation.id.count <= 200 else {
			return "The mutation id is invalid."
		}
		guard mutation.itemIds.count <= 200,
			mutation.itemIds.allSatisfy({ $0.isEmpty == false && $0.count <= 200 }) else {
			return "The mutation references too many or invalid items."
		}

		switch mutation.kind {
		case .setRead, .setStarred:
			guard mutation.itemIds.count == 1, mutation.value != nil else {
				return "The item-state mutation is incomplete."
			}
		case .setReadBatch:
			guard mutation.itemIds.isEmpty == false, mutation.value != nil else {
				return "The bulk-read mutation is incomplete."
			}
		case .feedback:
			guard mutation.itemIds.count == 1,
				mutation.feedback == "more_like_this" || mutation.feedback == "not_interested" else {
				return "The feedback mutation is invalid."
			}
		case .renameFeed:
			guard let feedID = mutation.feedId, feedID.isEmpty == false, feedID.count <= 300,
				let title = mutation.title?.trimmingCharacters(in: .whitespacesAndNewlines),
				title.isEmpty == false, title.count <= 200 else {
				return "The feed rename is invalid."
			}
		case .moveFeed:
			guard let feedID = mutation.feedId, feedID.isEmpty == false, feedID.count <= 300,
				(mutation.folders ?? []).allSatisfy({ $0.count <= 80 }) else {
				return "The feed move is invalid."
			}
		case .unsubscribeFeed, .restoreFeed:
			guard let feedID = mutation.feedId, feedID.isEmpty == false, feedID.count <= 300 else {
				return "The feed mutation is invalid."
			}
		}
		return nil
	}
}
