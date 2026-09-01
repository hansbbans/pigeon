import SwiftUI

struct StaleFeedsView: View {
	private static let maximumSelection = 100
	@Environment(ReaderAppModel.self) private var model
	@State private var selectedIDs: Set<String> = []
	@State private var isConfirmingUnsubscribe = false

	var body: some View {
		List {
			SettingsErrorSection()
			if let undoTitle = model.staleFeedUndoTitle {
				Section {
					Button(undoTitle, systemImage: "arrow.uturn.backward") {
						Task { await model.undoStaleFeedAction() }
					}
				}
			}
			if let snapshot = model.staleFeedSnapshot {
				Section {
					Text("Feeds appear here after no new article for 90 days. Archive moves a feed into the Archived section without unsubscribing; both actions can be undone. Select up to 100 feeds at a time.")
						.font(.footnote)
						.foregroundStyle(.secondary)
					LabeledContent("Inactive since", value: snapshot.cutoff.formatted(date: .abbreviated, time: .omitted))
				}
				feedSection("Stale", feeds: snapshot.feeds.filter { $0.archived == false })
				feedSection("Archived", feeds: snapshot.feeds.filter(\.archived))
				if selectedFeeds.isEmpty == false {
					Section("Selected") {
						if selectedFeeds.allSatisfy(\.archived) {
							Button("Restore from Archive", systemImage: "arrow.uturn.backward") {
								Task {
									if await model.unarchiveStaleFeeds(selectedFeeds) { selectedIDs = [] }
								}
							}
						} else if selectedFeeds.allSatisfy({ $0.archived == false }) {
							Button("Archive", systemImage: "archivebox") {
								Task {
									if await model.archiveStaleFeeds(selectedFeeds) { selectedIDs = [] }
								}
							}
						}
						Button("Unsubscribe", systemImage: "trash", role: .destructive) {
							isConfirmingUnsubscribe = true
						}
					}
				}
			} else if model.isLoadingStaleFeeds {
				ProgressView("Checking feed activity…")
			} else {
				ContentUnavailableView("No Stale Feeds", systemImage: "checkmark.circle", description: Text("Feeds quiet for 90 days will appear here."))
			}
		}
		.navigationTitle("Stale Feeds")
		.refreshable { await model.loadStaleFeeds() }
		.task { await model.loadStaleFeeds() }
		.confirmationDialog("Unsubscribe from selected feeds?", isPresented: $isConfirmingUnsubscribe, titleVisibility: .visible) {
			Button("Unsubscribe \(selectedFeeds.count) Feed\(selectedFeeds.count == 1 ? "" : "s")", role: .destructive) {
				Task {
					if await model.unsubscribeStaleFeeds(selectedFeeds) { selectedIDs = [] }
				}
			}
		} message: {
			Text("Pigeon keeps one undo step. Existing downloaded articles are not deleted.")
		}
	}

	@ViewBuilder
	private func feedSection(_ title: String, feeds: [StaleFeed]) -> some View {
		if feeds.isEmpty == false {
			Section(title) {
				ForEach(feeds) { feed in
					Button { toggle(feed.id) } label: {
						HStack(alignment: .top) {
							Image(systemName: selectedIDs.contains(feed.id) ? "checkmark.circle.fill" : "circle")
							VStack(alignment: .leading, spacing: 4) {
								Text(feed.title).foregroundStyle(.primary)
								Text(evidence(for: feed)).font(.caption).foregroundStyle(.secondary)
							}
						}
					}
					.accessibilityLabel("\(selectedIDs.contains(feed.id) ? "Selected" : "Not selected"), \(feed.title), \(evidence(for: feed))")
				}
			}
		}
	}

	private var selectedFeeds: [StaleFeed] {
		model.staleFeedSnapshot?.feeds.filter { selectedIDs.contains($0.id) } ?? []
	}

	private func toggle(_ id: String) {
		if selectedIDs.contains(id) {
			selectedIDs.remove(id)
		} else if selectedIDs.count < Self.maximumSelection {
			selectedIDs.insert(id)
		}
	}

	private func evidence(for feed: StaleFeed) -> String {
		let article = feed.lastArticleAt.map { "Last article \($0.formatted(date: .abbreviated, time: .omitted))" } ?? "No articles"
		let success = feed.lastSuccessAt.map { "last success \($0.formatted(date: .abbreviated, time: .omitted))" } ?? "no successful refresh"
		let status = feed.httpStatus.map { "HTTP \($0)" } ?? "no HTTP result"
		return "\(article) · \(success) · \(status)"
	}
}
