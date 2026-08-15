import SwiftUI

struct SyncHealthView: View {
	@State private var model: SyncHealthViewModel

	init(service: any SyncHealthServicing) {
		_model = State(initialValue: SyncHealthViewModel(service: service))
	}

	var body: some View {
		List {
			content
		}
		.navigationTitle("Sync Health")
		.refreshable {
			await model.load()
		}
		.task {
			await model.load()
		}
		.toolbar {
			ToolbarItem(placement: .topBarTrailing) {
				Button("Refresh", systemImage: "arrow.clockwise") {
					Task { await model.load() }
				}
				.disabled(model.state == .loading)
			}
		}
	}

	@ViewBuilder
	private var content: some View {
		if let snapshot = model.snapshot {
			if case let .failed(message) = model.state {
				Section {
					Label("Couldn’t refresh sync health", systemImage: "exclamationmark.triangle")
						.foregroundStyle(.red)
					Text(message)
						.font(.footnote)
						.foregroundStyle(.secondary)
				}
			}
			summarySection(snapshot)
			feedsSection(snapshot.feeds)
			activitySection(snapshot.recentActivity)
		} else {
			switch model.state {
			case .idle, .loading:
				Section {
					HStack {
						Spacer()
						ProgressView("Checking feeds…")
						Spacer()
					}
				}
			case let .failed(message):
				Section {
					ContentUnavailableView {
						Label("Couldn’t Check Sync", systemImage: "exclamationmark.triangle")
					} description: {
						Text(message)
					} actions: {
						Button("Try Again") {
							Task { await model.load() }
						}
					}
				}
			case .loaded:
				EmptyView()
			}
		}
	}

	private func summarySection(_ snapshot: SyncHealthSnapshot) -> some View {
		Section("Overview") {
			LabeledContent("Healthy", value: snapshot.healthyCount, format: .number)
			LabeledContent("Due", value: snapshot.dueCount, format: .number)
			LabeledContent("Waiting to retry", value: snapshot.backedOffCount, format: .number)
			LabeledContent("Refreshing now", value: snapshot.leasedCount, format: .number)
			LabeledContent("Last checked") {
				Text(snapshot.generatedAt, style: .relative)
					.foregroundStyle(.secondary)
			}
		}
	}

	@ViewBuilder
	private func feedsSection(_ feeds: [SyncHealthFeed]) -> some View {
		Section("Feeds") {
			if feeds.isEmpty {
				ContentUnavailableView(
					"No RSS Feeds",
					systemImage: "dot.radiowaves.left.and.right",
					description: Text("Subscribed RSS feeds will appear here."),
				)
			} else {
				ForEach(feeds) { feed in
					feedRow(feed)
				}
			}
		}
	}

	private func feedRow(_ feed: SyncHealthFeed) -> some View {
		VStack(alignment: .leading, spacing: 8) {
			Label(feed.title, systemImage: symbol(for: feed.state))
				.font(.headline)
				.foregroundStyle(color(for: feed.state))

			Text(feed.host)
				.font(.subheadline)
				.foregroundStyle(.secondary)

			if let detail = feedDetail(feed) {
				Text(detail)
					.font(.footnote)
					.foregroundStyle(.secondary)
			}

			if let error = feed.error {
				Text(error)
					.font(.footnote)
					.foregroundStyle(.red)
					.accessibilityLabel("Sync error: \(error)")
			}

			if shouldOfferRetry(feed) {
				Button {
					Task { await model.retry(feed) }
				} label: {
					if model.isRetrying(feed) {
						ProgressView()
							.accessibilityLabel("Queueing retry for \(feed.title)")
					} else {
						Label("Retry Now", systemImage: "arrow.clockwise")
					}
				}
				.buttonStyle(.bordered)
				.disabled(model.isRetrying(feed))
				.accessibilityLabel("Retry \(feed.title) now")
			}

			if let retryError = model.retryErrors[feed.feedKey] {
				Text(retryError)
					.font(.footnote)
					.foregroundStyle(.red)
			}
		}
		.padding(.vertical, 4)
	}

	@ViewBuilder
	private func activitySection(_ activities: [SyncHealthActivity]) -> some View {
		if activities.isEmpty == false {
			Section("Recent Activity") {
				ForEach(activities) { activity in
					VStack(alignment: .leading, spacing: 4) {
						Text(activity.title)
							.font(.headline)
						Text(activitySummary(activity))
							.font(.footnote)
							.foregroundStyle(.secondary)
						if let error = activity.error {
							Text(error)
								.font(.footnote)
								.foregroundStyle(.red)
						}
					}
				}
			}
		}
	}

	private func feedDetail(_ feed: SyncHealthFeed) -> String? {
		if let retryAt = feed.retryAt, feed.canRetry == false {
			return "Will retry \(retryAt.formatted(.relative(presentation: .named)))"
		}
		if let lastSuccessAt = feed.lastSuccessAt {
			return "Last updated \(lastSuccessAt.formatted(.relative(presentation: .named)))"
		}
		if let nextFetchAt = feed.nextFetchAt {
			return "Next check \(nextFetchAt.formatted(.relative(presentation: .named)))"
		}
		return "Not refreshed yet"
	}

	private func activitySummary(_ activity: SyncHealthActivity) -> String {
		let outcome = activity.outcome.replacingOccurrences(of: "_", with: " ").capitalized
		let duration = Double(activity.durationMs) / 1_000
		return "\(outcome) · \(activity.attemptedAt.formatted(.relative(presentation: .named))) · \(duration.formatted(.number.precision(.fractionLength(1))))s"
	}

	private func shouldOfferRetry(_ feed: SyncHealthFeed) -> Bool {
		feed.canRetry && ["failing", "due", "never_refreshed"].contains(feed.state)
	}

	private func symbol(for state: String) -> String {
		switch state {
		case "healthy": "checkmark.circle.fill"
		case "failing": "exclamationmark.triangle.fill"
		case "backing_off": "clock.badge.exclamationmark"
		case "due": "clock.arrow.circlepath"
		default: "questionmark.circle"
		}
	}

	private func color(for state: String) -> Color {
		switch state {
		case "healthy": .green
		case "failing": .red
		case "backing_off", "due": .orange
		default: .secondary
		}
	}
}
