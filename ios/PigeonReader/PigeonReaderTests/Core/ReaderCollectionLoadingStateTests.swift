import Testing
@testable import PigeonReader

struct ReaderCollectionLoadingStateTests {
	@Test func uncachedDestinationNeverShowsAnEmptyFeedBeforeItsTaskStarts() {
		let state = ReaderCollectionLoadingState()
		#expect(state.presentation(context: "feed-a", hasCachedCollection: false, isLoading: false) == .loading)
	}

	@Test func cachedStoriesAndKnownEmptyFeedsStayVisibleDuringRefresh() {
		var state = ReaderCollectionLoadingState()
		_ = state.begin(context: "feed-a")
		#expect(state.presentation(context: "feed-a", hasCachedCollection: true, isLoading: true) == .content)
		#expect(state.presentation(context: "feed-b", hasCachedCollection: true, isLoading: false) == .content)
	}

	@Test func completionFromAnOldFeedCannotReplaceTheNewFeedsPlaceholder() {
		var state = ReaderCollectionLoadingState()
		let oldRequest = state.begin(context: "feed-a")
		let currentRequest = state.begin(context: "feed-b")
		state.finish(requestID: oldRequest)
		#expect(state.presentation(context: "feed-b", hasCachedCollection: false, isLoading: false) == .loading)
		state.finish(requestID: currentRequest)
		#expect(state.presentation(context: "feed-b", hasCachedCollection: false, isLoading: false) == .unavailable)
	}

	@Test func retryAndAccountSwitchReturnToLoadingWithoutAFalseEmptyState() {
		var state = ReaderCollectionLoadingState()
		let failed = state.begin(context: "account-a|feed|0")
		state.finish(requestID: failed)
		#expect(state.presentation(context: "account-a|feed|0", hasCachedCollection: false, isLoading: false) == .unavailable)
		#expect(state.presentation(context: "account-a|feed|1", hasCachedCollection: false, isLoading: false) == .loading)
		#expect(state.presentation(context: "account-b|feed|0", hasCachedCollection: false, isLoading: false) == .loading)
	}
}
