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
					// A permanent rejection will not succeed on retry. Drop it so it
					// cannot sit at the FIFO head and block later queued actions.
					try await store.markMutationApplied(id: action.mutation.id, accountID: accountID)
					pageMadeProgress = true
				}
			}

			// Omitted receipts stay queued. Stop this replay instead of immediately
			// resending them in a hot loop. Later launches/refreshes retry them.
			if pageHasFailure || pageMadeProgress == false { return appliedCount }
		}
	}
}
