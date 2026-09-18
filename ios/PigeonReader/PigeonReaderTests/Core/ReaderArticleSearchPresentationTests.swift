import Testing
@testable import PigeonReader

struct ReaderArticleSearchPresentationTests {
	@Test func firstKeystrokeIsSearchingBeforeTheDebounceStarts() {
		let state = ReaderArticleSearchPresentation()
		#expect(state.phase(for: request("")) == .idle)
		#expect(state.phase(for: request("swift")) == .searching)
		#expect(state.canDisplayResults(for: request("swift")) == false)
	}

	@Test func onlyCompletedSearchesCanPresentNoMatches() {
		var state = ReaderArticleSearchPresentation()
		let query = request("missing")
		#expect(state.phase(for: query) == .searching)
		state.finish(query, outcome: .completed, current: query)
		#expect(state.phase(for: query) == .results)
		#expect(state.canDisplayResults(for: query))
	}

	@Test func previousResultsRemainVisibleWhileTheNextQueryIsPending() {
		var state = ReaderArticleSearchPresentation()
		let first = request("swift")
		let next = request("swiftui")
		state.finish(first, outcome: .completed, current: first)
		#expect(state.phase(for: next) == .searching)
		#expect(state.canDisplayResults(for: next))
	}

	@Test func resultsCannotLeakIntoAnotherScopeFeedOrAccount() {
		var state = ReaderArticleSearchPresentation()
		let first = request("swift")
		state.finish(first, outcome: .completed, current: first)
		for next in [
			request("swift", scope: .library),
			request("swift", collection: "feed-b"),
			request("swift", account: "account-b"),
		] {
			#expect(state.phase(for: next) == .searching)
			#expect(state.canDisplayResults(for: next) == false)
		}
	}

	@Test func staleAndCancelledRequestsCannotSettleTheVisibleQuery() {
		var state = ReaderArticleSearchPresentation()
		let old = request("s")
		let current = request("swift")
		state.finish(old, outcome: .completed, current: current)
		#expect(state.phase(for: current) == .searching)
		#expect(state.canDisplayResults(for: current) == false)
		state.finish(current, outcome: .cancelled, current: current)
		#expect(state.phase(for: current) == .searching)
	}

	@Test func failureKeepsPriorResultsAndRetryImmediatelyBecomesPending() {
		var state = ReaderArticleSearchPresentation()
		let first = request("swift")
		let next = request("swiftui")
		state.finish(first, outcome: .completed, current: first)
		state.finish(next, outcome: .failed, current: next)
		#expect(state.phase(for: next) == .failed)
		#expect(state.canDisplayResults(for: next))
		var retry = next
		retry.attempt += 1
		#expect(state.phase(for: retry) == .searching)
		#expect(state.canDisplayResults(for: retry))
	}

	@Test func firstSearchFailureDoesNotBecomeAnEmptyResult() {
		var state = ReaderArticleSearchPresentation()
		let query = request("swift")
		state.finish(query, outcome: .failed, current: query)
		#expect(state.phase(for: query) == .failed)
		#expect(state.canDisplayResults(for: query) == false)
	}

	private func request(
		_ query: String, scope: ReaderSearchScope = .collection,
		collection: String = "feed-a", account: String = "account-a",
	) -> ReaderArticleSearchRequest {
		ReaderArticleSearchRequest(accountID: account, collectionID: collection, scope: scope, query: query)
	}
}
