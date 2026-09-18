import Foundation

/// The rows currently presented by the sidebar. The model remains the source of
/// truth; this value only keeps a stable presentation while background refreshes
/// arrive during a user scroll or a sidebar animation.
nonisolated struct ReaderSidebarPresentationSnapshot: Equatable, Sendable {
	let accountID: String?
	let selectedNavigationID: String
	let sidebarFilter: ReaderSidebarFilter
	let enabledSmartViewSections: Set<ReaderSection>
	let smartItems: [ReaderNavigationItem]
	let folderItems: [ReaderNavigationItem]
	let feedsByFolderID: [String: [ReaderNavigationItem]]
	let uncategorizedFeedItems: [ReaderNavigationItem]
	let expandedFolderIDs: Set<String>

	func feeds(in folderID: String) -> [ReaderNavigationItem] {
		feedsByFolderID[folderID, default: []]
	}

	func hasSameUserIntent(as other: Self) -> Bool {
		accountID == other.accountID
			&& selectedNavigationID == other.selectedNavigationID
			&& sidebarFilter == other.sidebarFilter
			&& enabledSmartViewSections == other.enabledSmartViewSections
	}
}

/// Reduces background sidebar snapshots into a stable presentation. Explicit
/// user actions call `presentImmediately`, while refreshes use
/// `receiveBackground` and are released once scrolling and animations settle.
nonisolated struct ReaderSidebarPresentationState: Equatable, Sendable {
	private(set) var presentedSnapshot: ReaderSidebarPresentationSnapshot?
	private(set) var deferredSnapshot: ReaderSidebarPresentationSnapshot?
	private(set) var isScrolling = false
	private var animationTokens: Set<UUID> = []

	init(initialSnapshot: ReaderSidebarPresentationSnapshot? = nil) {
		presentedSnapshot = initialSnapshot
	}

	var isDeferringBackgroundUpdates: Bool {
		isScrolling || animationTokens.isEmpty == false
	}

	func snapshot(for liveSnapshot: ReaderSidebarPresentationSnapshot) -> ReaderSidebarPresentationSnapshot {
		guard let presentedSnapshot,
			presentedSnapshot.hasSameUserIntent(as: liveSnapshot) else {
			return liveSnapshot
		}
		return presentedSnapshot
	}

	mutating func receiveBackground(_ snapshot: ReaderSidebarPresentationSnapshot) {
		guard let presentedSnapshot else {
			self.presentedSnapshot = snapshot
			deferredSnapshot = nil
			return
		}

		// Account and explicit-intent changes must never show content from the old
		// presentation, even if a scroll or animation is still active.
		guard presentedSnapshot.hasSameUserIntent(as: snapshot) else {
			self.presentedSnapshot = snapshot
			deferredSnapshot = nil
			return
		}

		if isDeferringBackgroundUpdates {
			guard deferredSnapshot != snapshot else { return }
			deferredSnapshot = snapshot
		} else {
			guard self.presentedSnapshot != snapshot else { return }
			self.presentedSnapshot = snapshot
			deferredSnapshot = nil
		}
	}

	mutating func presentImmediately(_ snapshot: ReaderSidebarPresentationSnapshot) {
		guard presentedSnapshot != snapshot || deferredSnapshot != nil else { return }
		presentedSnapshot = snapshot
		deferredSnapshot = nil
	}

	mutating func setScrolling(_ active: Bool) {
		guard isScrolling != active else { return }
		isScrolling = active
		releaseDeferredIfIdle()
	}

	@discardableResult
	mutating func beginAnimation() -> UUID {
		let token = UUID()
		animationTokens.insert(token)
		return token
	}

	mutating func finishAnimation(_ token: UUID) {
		guard animationTokens.remove(token) != nil else { return }
		releaseDeferredIfIdle()
	}

	mutating func cancelAnimations() {
		guard animationTokens.isEmpty == false else { return }
		animationTokens.removeAll()
		releaseDeferredIfIdle()
	}

	mutating func discard() {
		presentedSnapshot = nil
		deferredSnapshot = nil
		isScrolling = false
		animationTokens.removeAll()
	}

	private mutating func releaseDeferredIfIdle() {
		guard isDeferringBackgroundUpdates == false,
			let deferredSnapshot else {
			return
		}
		presentedSnapshot = deferredSnapshot
		self.deferredSnapshot = nil
	}
}
