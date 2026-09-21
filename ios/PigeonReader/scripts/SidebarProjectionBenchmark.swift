import Foundation

@main
struct SidebarProjectionBenchmark {
	static func main() {
		for (folders, feedsPerFolder, iterations) in [(20, 20, 100), (100, 30, 60), (300, 30, 30)] {
			let navigation = makeLibrary(folders: folders, feedsPerFolder: feedsPerFolder)
			var oldTimes: [Double] = []
			var newTimes: [Double] = []
			var checksum = 0
			for iteration in 0..<(iterations + 10) {
				let filter: ReaderSidebarFilter = iteration.isMultiple(of: 2) ? .all : .unread
				// Alternate order to reduce warm-cache and scheduling bias.
				let oldFirst = iteration.isMultiple(of: 3)
				let first = measure(navigation, filter: filter, previous: oldFirst)
				let second = measure(navigation, filter: filter, previous: !oldFirst)
				precondition(first.1 == second.1, "Projection changed visible content")
				checksum += first.1.feedsByFolderID.values.reduce(0) { $0 + $1.count }
				if iteration >= 10 {
					oldTimes.append(oldFirst ? first.0 : second.0)
					newTimes.append(oldFirst ? second.0 : first.0)
				}
			}
			let old = oldTimes.sorted()[oldTimes.count / 2]
			let new = newTimes.sorted()[newTimes.count / 2]
			print(String(format: "%d folders / %d feeds: previous %.3f ms, current %.3f ms, %.1fx faster; checksum %d",
				folders, folders * feedsPerFolder, old, new, old / max(new, 0.000001), checksum))
		}
	}

	@inline(never)
	static func measure(_ navigation: ReaderNavigationState, filter: ReaderSidebarFilter, previous: Bool) -> (Double, ReaderSidebarPresentationSnapshot) {
		let start = ContinuousClock.now
		let snapshot = previous ? previousProjection(navigation, filter: filter)
			: ReaderSidebarPresentationSnapshot.make(accountID: "benchmark", selectedNavigationID: "forYou",
				sidebarFilter: filter, enabledSmartViewSections: [.forYou, .today, .starred], navigation: navigation)
		let duration = start.duration(to: .now).components
		return (Double(duration.seconds) * 1_000 + Double(duration.attoseconds) / 1e15, snapshot)
	}

	/// Frozen pre-change algorithm, retaining the same order and filter rules.
	@inline(never)
	static func previousProjection(_ navigation: ReaderNavigationState, filter: ReaderSidebarFilter) -> ReaderSidebarPresentationSnapshot {
		let visible: (ReaderNavigationItem) -> Bool = { filter == .all || $0.unreadCount > 0 }
		let folders = navigation.folderItems.filter(visible)
		let enabled: Set<ReaderSection> = [.forYou, .today, .starred]
		return ReaderSidebarPresentationSnapshot(accountID: "benchmark", selectedNavigationID: "forYou", sidebarFilter: filter,
			enabledSmartViewSections: enabled,
			smartItems: navigation.smartItems.filter { $0.smartSection.map { $0 != .unread && enabled.contains($0) } ?? false },
			folderItems: folders,
			feedsByFolderID: Dictionary(uniqueKeysWithValues: folders.map { ($0.id, navigation.children(of: $0.id).filter(visible)) }),
			uncategorizedFeedItems: navigation.uncategorizedFeedItems.filter(visible), expandedFolderIDs: navigation.expandedFolderIDs)
	}

	static func makeLibrary(folders: Int, feedsPerFolder: Int) -> ReaderNavigationState {
		var items = ReaderSection.allCases.map { ReaderNavigationItem.smart($0) }
		for folder in 0..<folders {
			let id = "folder-\(folder)"
			items.append(ReaderNavigationItem(id: id, title: id, streamID: id, kind: .folder,
				unreadCount: 10, parentID: nil, feedKey: nil, iconURL: nil, smartSection: nil))
			for feed in 0..<feedsPerFolder {
				let feedID = "\(id)-feed-\(feed)"
				items.append(ReaderNavigationItem(id: feedID, title: feedID, streamID: feedID, kind: .feed,
					unreadCount: feed.isMultiple(of: 3) ? 0 : 2, parentID: id, feedKey: feedID, iconURL: nil, smartSection: nil))
			}
		}
		return ReaderNavigationState(items: items)
	}
}
