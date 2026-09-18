import Testing
@testable import PigeonReader

struct ReaderSidebarPresentationStateTests {
	@Test func backgroundSnapshotsStayStableUntilScrollingEndsAndThenApplyLatest() {
		let initial = makeSnapshot(accountID: "account-a", unreadCount: 1)
		let firstUpdate = makeSnapshot(accountID: "account-a", unreadCount: 2)
		let latestUpdate = makeSnapshot(accountID: "account-a", unreadCount: 3)
		var state = ReaderSidebarPresentationState(initialSnapshot: initial)

		state.setScrolling(true)
		state.receiveBackground(firstUpdate)
		state.receiveBackground(latestUpdate)

		#expect(state.presentedSnapshot == initial)
		#expect(state.deferredSnapshot == latestUpdate)

		state.setScrolling(false)

		#expect(state.presentedSnapshot == latestUpdate)
		#expect(state.deferredSnapshot == nil)
	}

	@Test func overlappingAnimationCompletionsKeepDeferringUntilAllTokensFinish() {
		let initial = makeSnapshot(accountID: "account-a", unreadCount: 1)
		let updated = makeSnapshot(accountID: "account-a", unreadCount: 2)
		var state = ReaderSidebarPresentationState(initialSnapshot: initial)
		let expansionToken = state.beginAnimation()
		let revealToken = state.beginAnimation()

		state.receiveBackground(updated)
		state.finishAnimation(expansionToken)
		#expect(state.presentedSnapshot == initial)
		#expect(state.deferredSnapshot == updated)

		state.finishAnimation(revealToken)
		#expect(state.presentedSnapshot == updated)
		#expect(state.deferredSnapshot == nil)
	}

	@Test func explicitPresentationReplacesDeferredBackgroundRows() {
		let initial = makeSnapshot(accountID: "account-a", unreadCount: 1)
		let background = makeSnapshot(accountID: "account-a", unreadCount: 2)
		let explicit = makeSnapshot(accountID: "account-a", unreadCount: 4)
		var state = ReaderSidebarPresentationState(initialSnapshot: initial)

		state.setScrolling(true)
		state.receiveBackground(background)
		state.presentImmediately(explicit)
		state.setScrolling(false)

		#expect(state.presentedSnapshot == explicit)
		#expect(state.deferredSnapshot == nil)
	}

	@Test func accountAndFilterChangesDiscardOldRowsDuringBusyState() {
		let initial = makeSnapshot(accountID: "account-a", unreadCount: 1)
		var state = ReaderSidebarPresentationState(initialSnapshot: initial)
		state.setScrolling(true)

		let newAccount = makeSnapshot(accountID: "account-b", unreadCount: 8)
		state.receiveBackground(newAccount)
		#expect(state.presentedSnapshot == newAccount)
		#expect(state.deferredSnapshot == nil)

		let unread = makeSnapshot(accountID: "account-b", unreadCount: 9, filter: .unread)
		state.receiveBackground(unread)
		#expect(state.presentedSnapshot == unread)
		#expect(state.deferredSnapshot == nil)
	}

	private func makeSnapshot(
		accountID: String,
		unreadCount: Int,
		filter: ReaderSidebarFilter = .all,
	) -> ReaderSidebarPresentationSnapshot {
		let folder = ReaderNavigationItem(
			id: "folder/work",
			title: "Work",
			streamID: "folder/work",
			kind: .folder,
			unreadCount: unreadCount,
			parentID: nil,
			feedKey: nil,
			iconURL: nil,
			smartSection: nil,
		)
		let feed = ReaderNavigationItem(
			id: "feed/1::folder/work",
			title: "Example",
			streamID: "feed/1",
			kind: .feed,
			unreadCount: unreadCount,
			parentID: folder.id,
			feedKey: "example",
			iconURL: nil,
			smartSection: nil,
		)
		return ReaderSidebarPresentationSnapshot(
			accountID: accountID,
			selectedNavigationID: ReaderSection.forYou.rawValue,
			sidebarFilter: filter,
			enabledSmartViewSections: [.forYou],
			smartItems: [.smart(.forYou, unreadCount: unreadCount)],
			folderItems: [folder],
			feedsByFolderID: [folder.id: [feed]],
			uncategorizedFeedItems: [],
			expandedFolderIDs: [folder.id],
		)
	}
}
