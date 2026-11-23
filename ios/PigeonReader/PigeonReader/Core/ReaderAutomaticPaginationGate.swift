import Foundation

/// Bounds automatic requests when a filter produces very few visible stories.
/// Moving through the list renews the budget; failures require an explicit retry.
nonisolated struct ReaderAutomaticPaginationGate {
	/// Pages a list may load between two touches of the reader's finger.
	static let defaultBudget = 3

	private var attemptedTokens = Set<String>()
	private var pagesWithoutMovement = 0
	private var budget = Self.defaultBudget

	/// `budget` is the pages allowed without the reader scrolling. Cards
	/// pass 1: a page mostly lands behind "N more", so the page hardly grows
	/// and stays near its end.
	mutating func claim(_ token: String, hasError: Bool, budget: Int = Self.defaultBudget) -> Bool {
		self.budget = budget
		guard hasError == false, pagesWithoutMovement < budget,
			attemptedTokens.insert(token).inserted else { return false }
		pagesWithoutMovement += 1
		return true
	}

	@discardableResult
	mutating func userDidScroll() -> Bool {
		let wasExhausted = pagesWithoutMovement >= budget
		pagesWithoutMovement = 0
		return wasExhausted
	}

	mutating func cancelClaim(_ token: String) {
		if attemptedTokens.remove(token) != nil { pagesWithoutMovement = max(0, pagesWithoutMovement - 1) }
	}
}
