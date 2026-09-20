import Foundation
import Testing
@testable import PigeonReader

struct ReaderListUpdateBufferTests {
	@Test func backgroundInsertionWaitsForAcceptanceEvenAfterScrollingStops() {
		var buffer = ReaderListUpdateBuffer()
		let original = [story("a"), story("b")]
		let updated = [story("new"), story("a"), story("b")]
		buffer.receive(original, context: "feed", holding: false)
		buffer.receive(updated, context: "feed", holding: true)
		#expect(buffer.articles == original)
		buffer.receive(updated, context: "feed", holding: false)
		#expect(buffer.articles == original)
		#expect(buffer.newStoryCount == 1)
		#expect(buffer.needsAcceptance)
		buffer.acceptPending()
		#expect(buffer.articles == updated)
		#expect(buffer.hasPendingUpdate == false)
	}

	@Test func sparseCacheHydrationDoesNotAdvertiseExistingLiveStories() {
		var buffer = ReaderListUpdateBuffer()
		let cached = [story("august"), story("may"), story("march")]
		let hydrated = [story("today"), story("september"), story("august"), story("may"), story("march")]
		buffer.receive(cached, context: "feed", holding: false)
		let loadID = buffer.beginInitialLoad(context: "feed")
		buffer.receive(hydrated, context: "feed", holding: true)
		#expect(buffer.articles == hydrated)
		#expect(buffer.needsAcceptance == false)
		#expect(buffer.newStoryCount == 0)
		#expect(buffer.hasPendingUpdate == false)
		buffer.finishInitialLoad(context: "feed", loadID: loadID)
		#expect(buffer.articles == hydrated)
		#expect(buffer.needsAcceptance == false)
	}

	@Test func cancelledHydrationCannotClearAnotherContextUpdate() {
		var buffer = ReaderListUpdateBuffer()
		buffer.receive([story("cached")], context: "feed-a", holding: false)
		let loadID = buffer.beginInitialLoad(context: "feed-a")
		buffer.receive([story("cached-b")], context: "feed-b", holding: false)
		buffer.receive([story("new"), story("cached-b")], context: "feed-b", holding: false)
		#expect(buffer.needsAcceptance)
		buffer.finishInitialLoad(context: "feed-a", loadID: loadID)
		#expect(buffer.needsAcceptance)
		#expect(buffer.newStoryCount == 1)
	}

	@Test func staleHydrationCompletionCannotEndANewerLoad() {
		var buffer = ReaderListUpdateBuffer()
		buffer.receive([story("cached")], context: "feed", holding: false)
		let firstLoadID = buffer.beginInitialLoad(context: "feed")
		let secondLoadID = buffer.beginInitialLoad(context: "feed")
		buffer.receive([story("today"), story("cached")], context: "feed", holding: true)
		buffer.finishInitialLoad(context: "feed", loadID: firstLoadID)
		buffer.receive([story("newer"), story("today"), story("cached")], context: "feed", holding: true)
		#expect(buffer.articles.map(\.id) == ["newer", "today", "cached"])
		#expect(buffer.hasPendingUpdate == false)
		buffer.finishInitialLoad(context: "feed", loadID: secondLoadID)
		buffer.receive([story("actual"), story("newer"), story("today"), story("cached")], context: "feed", holding: false)
		#expect(buffer.needsAcceptance)
		#expect(buffer.newStoryCount == 1)
	}

	@Test func acceptedStoriesStayAcknowledgedWhenTheSameSourceReplays() {
		var buffer = ReaderListUpdateBuffer()
		let original = [story("a"), story("b")]
		let updated = [story("new"), story("a"), story("b")]
		buffer.receive(original, context: "feed", holding: false)
		buffer.receive(updated, context: "feed", holding: false)
		#expect(buffer.needsAcceptance)
		buffer.acceptPending()
		buffer.receive(updated, context: "feed", holding: false)
		#expect(buffer.articles == updated)
		#expect(buffer.hasPendingUpdate == false)
		#expect(buffer.needsAcceptance == false)
	}

	@Test func paginationAndRemovalsWaitForIdleButDoNotNeedANewStoriesPrompt() {
		var buffer = ReaderListUpdateBuffer()
		buffer.receive([story("a"), story("b")], context: "feed", holding: false)
		buffer.receive([story("a"), story("b"), story("c")], context: "feed", holding: true)
		#expect(buffer.articles.map(\.id) == ["a", "b"])
		#expect(buffer.needsAcceptance == false)
		buffer.receive([story("a"), story("b"), story("c")], context: "feed", holding: false)
		#expect(buffer.articles.map(\.id) == ["a", "b", "c"])
		buffer.receive([story("b"), story("c")], context: "feed", holding: true)
		#expect(buffer.articles.count == 3)
		buffer.receive([story("b"), story("c")], context: "feed", holding: false)
		#expect(buffer.articles.map(\.id) == ["b", "c"])
	}

	@Test func latestRefreshReplacesPendingAndPreservesReadStarUpdates() {
		var buffer = ReaderListUpdateBuffer()
		buffer.receive([story("a")], context: "feed", holding: false)
		buffer.receive([story("obsolete"), story("a")], context: "feed", holding: true)
		var read = story("a")
		read.isRead = true
		read.isStarred = true
		buffer.receive([story("latest"), read], context: "feed", holding: false)
		#expect(buffer.articles.first?.isRead == true)
		#expect(buffer.articles.first?.isStarred == true)
		buffer.acceptPending()
		#expect(buffer.articles.map(\.id) == ["latest", "a"])
	}

	@Test func accountFilterAndExplicitRefreshDiscardOldPendingRows() {
		var buffer = ReaderListUpdateBuffer()
		buffer.receive([story("a")], context: "account-a|all", holding: false)
		buffer.receive([story("new"), story("a")], context: "account-a|all", holding: true)
		#expect(buffer.displayedArticles(in: "account-b|all", fallback: []).isEmpty)
		buffer.receive([story("b")], context: "account-b|all", holding: true)
		#expect(buffer.articles.map(\.id) == ["b"])
		#expect(buffer.hasPendingUpdate == false)
		buffer.receive([story("c"), story("b")], context: "account-b|all", holding: false, explicit: true)
		#expect(buffer.articles.map(\.id) == ["c", "b"])
	}

	@Test func reorderingExistingStoriesNeedsAcceptanceButFirstLoadDoesNot() {
		var buffer = ReaderListUpdateBuffer()
		buffer.receive([], context: "feed", holding: true)
		buffer.receive([story("a"), story("b")], context: "feed", holding: true)
		#expect(buffer.articles.count == 2)
		buffer.receive([story("b"), story("a")], context: "feed", holding: false)
		#expect(buffer.needsAcceptance)
		#expect(buffer.newStoryCount == 0)
	}

	@Test func markingAVisibleStoryReadDoesNotAcceptUnrelatedNewStories() {
		var buffer = ReaderListUpdateBuffer()
		buffer.receive([story("a"), story("b")], context: "unread", holding: false)
		var read = story("a")
		read.isRead = true
		buffer.receive([story("new"), story("b")], context: "unread", holding: false,
			knownArticles: [story("new"), read, story("b")])
		#expect(buffer.articles.map(\.id) == ["b"])
		#expect(buffer.needsAcceptance)
		#expect(buffer.newStoryCount == 1)
	}

	@Test func oldestFirstPaginationWaitsForIdleWithoutANewStoriesPrompt() {
		var buffer = ReaderListUpdateBuffer()
		let page = [story("older"), story("a"), story("b")]
		buffer.receive([story("a"), story("b")], context: "oldest", holding: false)
		buffer.receive(page, context: "oldest", holding: true, acceptsReordering: true)
		#expect(buffer.articles.map(\.id) == ["a", "b"])
		#expect(buffer.needsAcceptance == false)
		buffer.receive(page, context: "oldest", holding: false)
		#expect(buffer.articles == page)
		#expect(buffer.hasPendingUpdate == false)
	}

	@Test func paginationPermissionDoesNotApplyToALaterBackgroundRefresh() {
		var buffer = ReaderListUpdateBuffer()
		buffer.receive([story("a")], context: "feed", holding: false)
		buffer.receive([story("older"), story("a")], context: "feed", holding: true, acceptsReordering: true)
		buffer.receive([story("new"), story("a")], context: "feed", holding: false)
		#expect(buffer.articles.map(\.id) == ["a"])
		#expect(buffer.needsAcceptance)
	}

	@Test func undoRestoresOnlyItsStoryWhileUnrelatedNewStoriesStayPending() {
		var buffer = ReaderListUpdateBuffer()
		buffer.receive([story("a"), story("b")], context: "unread", holding: false)
		buffer.receive([story("new"), story("b")], context: "unread", holding: false,
			manuallyChangedArticleID: "a")
		#expect(buffer.articles.map(\.id) == ["b"])
		#expect(buffer.needsAcceptance)
		buffer.receive([story("new"), story("a"), story("b")], context: "unread", holding: true,
			manuallyChangedArticleID: "a")
		#expect(buffer.articles.map(\.id) == ["a", "b"])
		#expect(buffer.newStoryCount == 1)
		#expect(buffer.needsAcceptance)
	}

	private func story(_ id: String) -> Recommendation {
		Recommendation(id: id, readerId: id, feedKey: "feed", source: "Feed", title: id, html: "", text: nil,
			originalURL: nil, receivedAt: .distantPast, isRead: false, isStarred: false, score: 0,
			confidence: 0, sampleCount: 0, explanation: "", learningState: "")
	}
}
