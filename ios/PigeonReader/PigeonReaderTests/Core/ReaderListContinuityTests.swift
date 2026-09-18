import Testing
@testable import PigeonReader

@MainActor
struct ReaderListContinuityTests {
	@Test func repeatedAppearancesDoNotRequestTheSamePageTwice() {
		var gate = ReaderAutomaticPaginationGate()
		#expect(gate.claim("page-2", hasError: false) == true)
		#expect(gate.claim("page-2", hasError: false) == false)
		gate.userDidScroll()
		#expect(gate.claim("page-2", hasError: false) == false)
	}

	@Test func filteredOutPagesHaveABoundedAutomaticBudget() {
		var gate = ReaderAutomaticPaginationGate()
		for token in ["2", "3", "4"] { #expect(gate.claim(token, hasError: false) == true) }
		#expect(gate.claim("5", hasError: false) == false)
		#expect(gate.userDidScroll() == true)
		#expect(gate.claim("5", hasError: false) == true)
	}

	@Test func failuresRequireExplicitRetryButCancellationCanResume() {
		var gate = ReaderAutomaticPaginationGate()
		#expect(gate.claim("2", hasError: true) == false)
		#expect(gate.claim("2", hasError: false) == true)
		gate.cancelClaim("2")
		#expect(gate.claim("2", hasError: false) == true)
	}

	@Test func rowIdentitySurvivesInsertionAndFallsBackWhenTheRowDisappears() {
		let position = ReaderListPosition(articleID: "middle", viewportOffset: -24, neighbors: ["next", "previous"])
		#expect(position.target(in: ["new", "previous", "middle", "next"]) == "middle")
		#expect(position.target(in: ["previous", "next"]) == "next")
		#expect(position.target(in: ["previous"]) == "previous")
		#expect(position.target(in: ["unrelated"]) == nil)
	}

	@Test func positionsStaySeparateForEachFeedFilterAndAccountAndClearOnReset() {
		let store = ReaderListPositionStore()
		let first = ReaderListPosition(articleID: "one", viewportOffset: -18, neighbors: [])
		let second = ReaderListPosition(articleID: "two", viewportOffset: 4, neighbors: [])
		store.save(first, for: "account-a|feed-a|unread")
		store.save(second, for: "account-a|feed-a|all")
		#expect(store.position(for: "account-a|feed-a|unread") == first)
		#expect(store.position(for: "account-a|feed-a|all") == second)
		#expect(store.position(for: "account-b|feed-a|unread") == nil)
		store.reset()
		#expect(store.position(for: "account-a|feed-a|unread") == nil)
	}

	@Test func explicitChangesCanHandoffWithinACollectionButNeverAcrossNavigation() {
		let accountFeed = ReaderListCollectionScope(accountID: "account-a", collectionID: "feed-a")
		let sameFeed = ReaderListCollectionScope(accountID: "account-a", collectionID: "feed-a")
		let otherFeed = ReaderListCollectionScope(accountID: "account-a", collectionID: "feed-b")
		let otherAccount = ReaderListCollectionScope(accountID: "account-b", collectionID: "feed-a")

		#expect(ReaderListContextContinuity.canHandoff(from: accountFeed, to: sameFeed))
		#expect(ReaderListContextContinuity.canHandoff(from: accountFeed, to: otherFeed) == false)
		#expect(ReaderListContextContinuity.canHandoff(from: accountFeed, to: otherAccount) == false)
	}

	@Test func explicitHandoffCopiesTheAnchorAndLeavesTheSourcePositionUsable() {
		let store = ReaderListPositionStore()
		let position = ReaderListPosition(articleID: "read-story", viewportOffset: -32, neighbors: ["unread-story", "older-story"])
		let scope = ReaderListCollectionScope(accountID: "account-a", collectionID: "feed-a")
		store.save(position, for: "account-a|feed-a|all|newest|collection|")

		#expect(store.handoffPosition(
			position,
			from: "account-a|feed-a|all|newest|collection|",
			to: "account-a|feed-a|unread|newest|collection|",
			sourceScope: scope,
			targetScope: scope,
		))
		#expect(store.position(for: "account-a|feed-a|unread|newest|collection|") == position)
		#expect(store.position(for: "account-a|feed-a|all|newest|collection|") == position)
		#expect(position.target(in: ["unread-story", "older-story"]) == "unread-story")
		#expect(store.handoffPosition(
			position,
			from: "account-a|feed-a|all|newest|collection|",
			to: "account-a|feed-b|unread|newest|collection|",
			sourceScope: scope,
			targetScope: ReaderListCollectionScope(accountID: "account-a", collectionID: "feed-b"),
		) == false)
	}

	@Test func handoffDoesNotInventAnAnchorWhenTheSourceWasNeverObserved() {
		let store = ReaderListPositionStore()
		let scope = ReaderListCollectionScope(accountID: "account-a", collectionID: "feed-a")
		let position = ReaderListPosition(articleID: "missing", viewportOffset: 0, neighbors: [])
		#expect(store.handoffPosition(
			position,
			from: "account-a|feed-a|all",
			to: "account-a|feed-a|unread",
			sourceScope: scope,
			targetScope: scope,
		) == false)
		#expect(store.position(for: "account-a|feed-a|unread") == nil)
	}
}
