import SwiftUI

private struct ReaderSidebarPrewarmRequest: Equatable, Sendable {
	let id: UUID
	let folder: ReaderNavigationItem
	let accountID: String
	let sidebarFilter: ReaderSidebarFilter
	let selectedNavigationID: String
}

struct ReaderSidebarView: View {
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.readerWindowHorizontalSizeClass) private var windowHorizontalSizeClass
	@State private var editorRoute: LibraryEditorRoute?
	@State private var folderPendingDeletion: String?
	@State private var feedPendingUnsubscribe: FeedSubscription?
	@State private var sidebarViewportCoordinator = ReaderSidebarViewportCoordinator()
	@State private var sidebarNativeScrollView = ReaderSidebarNativeScrollViewProxy()
	@State private var sidebarPresentationState = ReaderSidebarPresentationState()
	@State private var prewarmRequest: ReaderSidebarPrewarmRequest?
	/// Set on iPhone, where this list is reached from the tile home.
	var onShowHome: (() -> Void)?

	var body: some View {
		@Bindable var model = model
		let liveSnapshot = makePresentationSnapshot()
		let presentedSnapshot = sidebarPresentationState.snapshot(for: liveSnapshot)
		let selection = Binding<String?>(
			get: { model.preferredCompactColumn == .sidebar ? nil : model.selectedNavigationID },
			set: { id in
				guard let id, let item = model.navigation.item(withID: id), item.kind != .folder else {
					// List can synthesize row selection during repeated disclosure taps.
					// Folder navigation belongs exclusively to its title button.
					return
				}
				selectNavigationItem(item)
			},
		)

		ScrollViewReader { proxy in
			List(selection: selection) {
				Section {
					ReaderLibraryGroupLabel("Views")
					ForEach(presentedSnapshot.smartItems) { item in
						let frameGeneration = sidebarViewportCoordinator.currentGeneration
						ReaderNavigationRowView(
							item: item,
							isSelected: model.selectedNavigationID == item.id,
							onFrameChange: { frame in
								sidebarViewportCoordinator.updateRowFrame(frame, for: item.id, generation: frameGeneration)
								attemptFolderAdjustment(using: proxy)
							},
						)
						.background {
							ReaderSidebarScrollViewAnchor(proxy: sidebarNativeScrollView)
						}
						.keyboardShortcut(item.smartSection?.keyboardKey ?? "1", modifiers: .command)
						.readerLibraryRowChrome()
					}
				}

				if presentedSnapshot.folderItems.isEmpty == false {
					Section {
						ReaderLibraryGroupLabel("Folders")
						ForEach(presentedSnapshot.folderItems) { folder in
							let frameGeneration = sidebarViewportCoordinator.currentGeneration
							ReaderFolderNavigationRowView(
								folder: folder,
								isExpanded: presentedSnapshot.expandedFolderIDs.contains(folder.id),
								isSelected: model.selectedNavigationID == folder.id,
								onToggle: { toggleFolder(folder, proxy: proxy) },
								onSelect: { selectNavigationItem(folder) },
								onFrameChange: { frame in
									sidebarViewportCoordinator.updateRowFrame(frame, for: folder.id, generation: frameGeneration)
								attemptFolderAdjustment(using: proxy)
								},
							)
							.background {
								ReaderSidebarScrollViewAnchor(proxy: sidebarNativeScrollView)
							}
							.contextMenu {
								ReaderFolderMenu(
									folder: folder,
									editorRoute: $editorRoute,
									folderPendingDeletion: $folderPendingDeletion,
								)
							}
							.readerLibraryRowChrome()

							if presentedSnapshot.expandedFolderIDs.contains(folder.id) {
								ForEach(presentedSnapshot.feeds(in: folder.id)) { feed in
									// Favicons line up under the folder's title.
									feedRow(feed, indentation: 30, proxy: proxy)
								}
							}
						}
					}
				}

				if presentedSnapshot.uncategorizedFeedItems.isEmpty == false {
					Section {
						ReaderLibraryGroupLabel("Feeds")
						ForEach(presentedSnapshot.uncategorizedFeedItems) { feed in
							feedRow(feed, proxy: proxy)
						}
					}
				}
			}
			// The Reeder library: a quiet grey column, not the stock sidebar.
			// The links stay (they carry the native push and ⌘1 to ⌘6); only
			// their chevrons go.
			.listStyle(.plain)
			.environment(\.defaultMinListRowHeight, 1)
			.scrollContentBackground(.hidden)
			.background(PigeonPalette.libraryGround)
			.navigationLinkIndicatorVisibility(.hidden)
			.background {
				ReaderSidebarScrollViewAnchor(proxy: sidebarNativeScrollView)
			}
			.coordinateSpace(name: ReaderSidebarCoordinateSpace.name)
			.accessibilityIdentifier(ReaderSidebarAccessibility.sidebar)
			.onGeometryChange(for: CGRect.self) { geometry in
				geometry.frame(in: .named(ReaderSidebarCoordinateSpace.name))
			} action: { _, frame in
				sidebarViewportCoordinator.updateViewportFrame(frame)
				attemptFolderAdjustment(using: proxy)
			}
			.onScrollGeometryChange(for: ReaderSidebarScrollMetrics.self) { geometry in
				ReaderSidebarScrollMetrics(
					contentOffsetY: geometry.contentOffset.y,
					contentHeight: geometry.contentSize.height,
					viewportHeight: geometry.containerSize.height,
					topInset: geometry.contentInsets.top,
					bottomInset: geometry.contentInsets.bottom,
				)
			} action: { _, metrics in
				sidebarViewportCoordinator.updateScrollMetrics(metrics)
				attemptFolderAdjustment(using: proxy)
			}
			.onScrollPhaseChange { _, phase in
				sidebarViewportCoordinator.updateScrollPhase(phase)
				sidebarPresentationState.setScrolling(phase != .idle)
				if phase == .tracking || phase == .interacting {
					sidebarPresentationState.cancelAnimations()
				}
				attemptFolderAdjustment(using: proxy)
			}
		}
		.navigationTitle("Pigeon")
		// The split view's sidebar column has no room for a title beside its
		// four buttons; it truncated to "Pi…".
		.toolbar(removing: windowHorizontalSizeClass == .regular ? .title : nil)
		.toolbar {
			if let onShowHome {
				ToolbarItem(placement: .topBarLeading) {
					Button("Home", systemImage: "square.grid.2x2", action: onShowHome)
						.accessibilityIdentifier(ReaderHomeAccessibility.showTiles)
						.accessibilityHint("Returns to the tile view")
				}
			}
			// Also in the library on an iPad, where the list beside it has one
			// too: in portrait the library slides over and covers the list's bar.
			ReaderLookToolbarItem()
			ReaderLibraryToolbarItems(editorRoute: $editorRoute, collectsMenus: true)
		}
		.refreshable {
			await model.refreshLibrary()
		}
		.task(id: prewarmRequest?.id) {
			guard let request = prewarmRequest,
				isCurrentPrewarmRequest(request),
				model.isFolderExpanded(request.folder),
				model.sidebarFilter == request.sidebarFilter,
				model.selectedNavigationID == request.selectedNavigationID,
				model.session?.storageIdentity == request.accountID else {
				return
			}
			await model.prewarmFeeds(in: request.folder)
			guard Task.isCancelled == false, isCurrentPrewarmRequest(request) else { return }
		}
		.onAppear {
			sidebarPresentationState.presentImmediately(makePresentationSnapshot())
		}
		.onChange(of: model.navigation) { _, _ in
			receiveNavigationSnapshot()
		}
		.onChange(of: model.enabledSmartViewSections) { _, _ in
			receiveNavigationSnapshot()
		}
		.onChange(of: model.sidebarFilter) { _, _ in
			sidebarViewportCoordinator.cancelPendingReveal()
			cancelPrewarm()
			sidebarPresentationState.cancelAnimations()
			presentSidebarSnapshotImmediately()
		}
		.onChange(of: model.selectedNavigationID) { _, _ in
			sidebarViewportCoordinator.cancelPendingReveal()
			cancelPrewarm()
			presentSidebarSnapshotImmediately()
		}
		.onChange(of: model.selectedArticleID) { _, _ in
			cancelPrewarm()
		}
		.onChange(of: model.readerTypography.remoteImagePolicy) { _, _ in
			cancelPrewarm()
		}
		.onChange(of: model.readerTypography.timelineDensity) { _, _ in
			cancelPrewarm()
		}
		.onChange(of: model.session?.storageIdentity) { _, _ in
			cancelPrewarm()
			sidebarViewportCoordinator.cancelPendingReveal()
			sidebarPresentationState.discard()
		}
		.onDisappear {
			cancelPrewarm()
			sidebarViewportCoordinator.cancelPendingReveal()
			sidebarPresentationState.discard()
		}
		.sheet(item: $editorRoute) { route in
			LibraryManagementView(route: route)
		}
		.modifier(ReaderLibraryItemDialogs(
			folderPendingDeletion: $folderPendingDeletion,
			feedPendingUnsubscribe: $feedPendingUnsubscribe,
		))
	}

	private func feedRow(_ feed: ReaderNavigationItem, indentation: CGFloat = 0, proxy: ScrollViewProxy) -> some View {
		let frameGeneration = sidebarViewportCoordinator.currentGeneration
		return ReaderNavigationRowView(
			item: feed,
			isSelected: model.selectedNavigationID == feed.id,
			indentation: indentation,
			onFrameChange: { frame in
				sidebarViewportCoordinator.updateRowFrame(frame, for: feed.id, generation: frameGeneration)
				attemptFolderAdjustment(using: proxy)
			},
		)
		.background {
			ReaderSidebarScrollViewAnchor(proxy: sidebarNativeScrollView)
		}
		.contextMenu {
			ReaderFeedMenu(
				feed: feed,
				editorRoute: $editorRoute,
				feedPendingUnsubscribe: $feedPendingUnsubscribe,
				open: { selectNavigationItem(feed) },
			)
		} preview: {
			// UIKit builds this preview in a detached hosting hierarchy, so it does
			// not inherit the model environment from the sidebar row.
			ReaderSidebarFeedPreview(feed: feed)
				.environment(model)
		}
		.readerLibraryRowChrome()
	}

	private func toggleFolder(_ folder: ReaderNavigationItem, proxy: ScrollViewProxy) {
		let isExpanding = model.isFolderExpanded(folder) == false
		let childIDs = model.visibleFeedNavigationItems(in: folder).map(\.id)
		let firstChildID = model.visibleFeedNavigationItems(in: folder).first?.id
		cancelPrewarm()
		sidebarPresentationState.cancelAnimations()
		if isExpanding {
			if firstChildID != nil {
				let animation = ReaderMotion.folderExpansion(reduceMotion: reduceMotion)
				sidebarViewportCoordinator.beginReveal(
					folderID: folder.id,
					firstChildID: firstChildID,
					refreshingRowIDs: childIDs,
					animationDuration: animation.map { _ in ReaderMotion.folderExpansionDuration },
				)
			} else {
				sidebarViewportCoordinator.cancelPendingReveal()
			}
		} else {
			sidebarViewportCoordinator.beginCollapse(
				folderID: folder.id,
				removingRowIDs: childIDs,
			)
		}
		let toggleGeneration = sidebarViewportCoordinator.currentGeneration
		let animation = ReaderMotion.folderExpansion(reduceMotion: reduceMotion)
		let animationToken = animation.map { _ in sidebarPresentationState.beginAnimation() }
		withAnimation(animation, completionCriteria: .logicallyComplete) {
			model.toggleFolder(folder)
			presentSidebarSnapshotImmediately()
		} completion: {
			if let animationToken {
				finishSidebarAnimation(animationToken)
			}
			if isExpanding, animation != nil {
				// Reveal from the settled layout first; only then close the window.
				if sidebarViewportCoordinator.isCurrentGeneration(toggleGeneration) {
					attemptFolderReveal(using: proxy, settled: true)
				}
				sidebarViewportCoordinator.finishRevealWindow(expectedGeneration: toggleGeneration)
			}
			attemptFolderAdjustment(
				using: proxy,
				layoutSettled: true,
				expectedGeneration: toggleGeneration,
			)
		}
		if isExpanding, let accountID = model.session?.storageIdentity {
			prewarmRequest = ReaderSidebarPrewarmRequest(
				id: UUID(),
				folder: folder,
				accountID: accountID,
				sidebarFilter: model.sidebarFilter,
				selectedNavigationID: model.selectedNavigationID,
			)
		}
	}

	private func attemptFolderAdjustment(
		using proxy: ScrollViewProxy,
		layoutSettled: Bool = false,
		expectedGeneration: Int? = nil,
	) {
		if let expectedGeneration,
			sidebarViewportCoordinator.isCurrentGeneration(expectedGeneration) == false {
			return
		}
		// A reveal must join the folder's existing expansion transaction as soon
		// as the first child has a usable frame. Background refreshes remain
		// deferred below while that shared motion is in flight.
		attemptFolderReveal(using: proxy)
		guard sidebarPresentationState.isDeferringBackgroundUpdates == false else {
			return
		}
		guard sidebarViewportCoordinator.hasPendingCollapse else {
			return
		}
		guard let plan = sidebarViewportCoordinator.consumeCollapsePlan(
			layoutSettled: layoutSettled,
			expectedGeneration: expectedGeneration,
		) else {
			return
		}
		// The native bridge applies the exact bounded offset. If the List has not
		// attached it yet, leave the content untouched rather than guessing with
		// an oversized ScrollViewReader jump.
		_ = sidebarNativeScrollView.apply(
			plan,
			animated: false,
		)
	}

	private func attemptFolderReveal(using proxy: ScrollViewProxy, settled: Bool = false) {
		guard let plan = sidebarViewportCoordinator.consumeRevealPlan(settled: settled) else {
			return
		}
		guard let targetID = plan.targetID else {
			return
		}
		let animation = ReaderMotion.folderExpansion(
			reduceMotion: reduceMotion,
			duration: plan.animationDuration,
		)
		let revealGeneration = sidebarViewportCoordinator.currentGeneration
		let animationToken = animation.map { _ in sidebarPresentationState.beginAnimation() }
		withAnimation(animation, completionCriteria: .logicallyComplete) {
			proxy.scrollTo(targetID, anchor: .bottom)
		} completion: {
			if let animationToken {
				finishSidebarAnimation(animationToken)
			}
			attemptFolderAdjustment(using: proxy, expectedGeneration: revealGeneration)
		}
	}

	private func makePresentationSnapshot() -> ReaderSidebarPresentationSnapshot {
		ReaderSidebarPresentationSnapshot.make(
			accountID: model.session?.storageIdentity,
			selectedNavigationID: model.selectedNavigationID,
			sidebarFilter: model.sidebarFilter,
			enabledSmartViewSections: model.enabledSmartViewSections,
			navigation: model.navigation,
		)
	}

	private func presentSidebarSnapshotImmediately() {
		sidebarPresentationState.presentImmediately(makePresentationSnapshot())
	}

	private func receiveNavigationSnapshot() {
		if let request = prewarmRequest, model.isFolderExpanded(request.folder) == false {
			cancelPrewarm()
		}
		sidebarPresentationState.receiveBackground(makePresentationSnapshot())
	}

	private func selectNavigationItem(_ item: ReaderNavigationItem) {
		cancelPrewarm()
		sidebarViewportCoordinator.cancelPendingReveal()
		sidebarPresentationState.cancelAnimations()
		// Let NavigationLink carry the platform's native navigation transaction.
		// The snapshot still updates in the same binding action, so an explicit
		// selection is never held behind a background-refresh buffer.
		model.select(item: item)
		presentSidebarSnapshotImmediately()
	}

	private func finishSidebarAnimation(_ token: UUID) {
		sidebarPresentationState.finishAnimation(token)
	}

	private func cancelPrewarm() {
		prewarmRequest = nil
	}

	private func isCurrentPrewarmRequest(_ request: ReaderSidebarPrewarmRequest) -> Bool {
		prewarmRequest?.id == request.id
			&& model.session?.storageIdentity == request.accountID
	}
}
