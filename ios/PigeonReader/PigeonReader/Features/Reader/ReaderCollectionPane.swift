import SwiftUI

struct ReaderCollectionPane: View {
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.horizontalSizeClass) private var columnHorizontalSizeClass
	@Environment(\.readerWindowHorizontalSizeClass) private var windowHorizontalSizeClass
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var displayedCollection: ReaderNavigationItem?
	@State private var displayedAccountID: String?
	@State private var transitionID = UUID()
	@State private var isTransitioning = false

	var body: some View {
		let rootCollection = model.contentRootCollection
		let collection = displayedAccountID == model.session?.storageIdentity
			? displayedCollection ?? rootCollection : rootCollection
		ZStack {
			Group {
				if collection.smartSection == .saved {
					ReadItLaterListView(collection: collection)
				} else {
					ArticleListView(collection: collection)
				}
			}
				.id(collection.id)
				.transition(horizontalSizeClass == .regular ? .opacity : .identity)
		}
		.environment(\.readerCollectionIsTransitioning, isTransitioning)
		// Compact navigation owns its push/pop animation. The stationary iPad
		// column changes only opacity, leaving its sidebar and row geometry alone.
		.id(model.session?.storageIdentity)
		.navigationTitle(navigationTitle(for: rootCollection))
		.onChange(of: rootCollection, initial: true) { _, root in
			show(root)
		}
		.onChange(of: model.session?.storageIdentity) { _, _ in
			show(model.contentRootCollection)
		}
	}

	/// The stationary-column fade is for a regular window; the column's own
	/// size class can read compact inside an iPad split view.
	private var horizontalSizeClass: UserInterfaceSizeClass? {
		windowHorizontalSizeClass ?? columnHorizontalSizeClass
	}

	private func navigationTitle(for collection: ReaderNavigationItem) -> String {
		guard collection.smartSection?.usesDayWindow == true else { return collection.title }
		let unreadCount = model.navigation.item(withID: collection.id)?.unreadCount ?? collection.unreadCount
		return "\(collection.title) (\(unreadCount.formatted()))"
	}

	private func show(_ collection: ReaderNavigationItem) {
		let sameAccount = displayedAccountID == model.session?.storageIdentity
		let changesFeed = displayedCollection != nil && displayedCollection?.id != collection.id
		displayedAccountID = model.session?.storageIdentity
		guard sameAccount, changesFeed, horizontalSizeClass == .regular else {
			displayedCollection = collection
			if sameAccount == false || changesFeed {
				transitionID = UUID()
				isTransitioning = false
			}
			return
		}
		let requestID = UUID()
		transitionID = requestID
		isTransitioning = true
		withAnimation(ReaderMotion.feedSwitch(reduceMotion: reduceMotion), completionCriteria: .removed) {
			displayedCollection = collection
		} completion: {
			guard transitionID == requestID else { return }
			isTransitioning = false
		}
	}
}
