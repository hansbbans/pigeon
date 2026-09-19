import Foundation

/// Bounds automatic requests when a filter produces very few visible stories.
/// Moving through the list renews the budget; failures require an explicit retry.
nonisolated struct ReaderAutomaticPaginationGate {
	private var attemptedTokens = Set<String>()
	private var pagesWithoutMovement = 0

	mutating func claim(_ token: String, hasError: Bool) -> Bool {
		guard hasError == false, pagesWithoutMovement < 3,
			attemptedTokens.insert(token).inserted else { return false }
		pagesWithoutMovement += 1
		return true
	}

	@discardableResult
	mutating func userDidScroll() -> Bool {
		let wasExhausted = pagesWithoutMovement >= 3
		pagesWithoutMovement = 0
		return wasExhausted
	}

	mutating func cancelClaim(_ token: String) {
		if attemptedTokens.remove(token) != nil { pagesWithoutMovement = max(0, pagesWithoutMovement - 1) }
	}
}
