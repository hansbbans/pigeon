import SwiftUI

struct FeedNotificationSettingsView: View {
	@Environment(ReaderAppModel.self) private var model
	@State private var enabledFeedIDs: Set<String> = []
	@State private var deniedMessage: String?

	var body: some View {
		List {
			Section {
				Text("Choose the feeds that should alert you after a successful background refresh. Each alert includes Mark Read and Star actions.")
					.font(.footnote)
					.foregroundStyle(.secondary)
			}
			Section("Feeds") {
				ForEach(model.subscriptions) { subscription in
					Toggle(subscription.title, isOn: binding(for: subscription))
				}
				if model.subscriptions.isEmpty {
					ContentUnavailableView("No Feeds", systemImage: "bell.slash", description: Text("Add a feed before enabling notifications."))
				}
			}
			if let deniedMessage {
				Section { Text(deniedMessage).foregroundStyle(.red) }
			}
		}
		.navigationTitle("Feed Notifications")
		.task {
			enabledFeedIDs = Set(model.subscriptions.filter {
				ReaderNotificationManager.shared.isEnabled(feedID: $0.feedKey)
			}.map(\.feedKey))
		}
	}

	private func binding(for subscription: FeedSubscription) -> Binding<Bool> {
		Binding(
			get: { enabledFeedIDs.contains(subscription.feedKey) },
			set: { enabled in
				if enabled { enabledFeedIDs.insert(subscription.feedKey) } else { enabledFeedIDs.remove(subscription.feedKey) }
				Task {
					let saved = await ReaderNotificationManager.shared.setEnabled(enabled, feedID: subscription.feedKey)
					if saved == false {
						enabledFeedIDs.remove(subscription.feedKey)
						deniedMessage = "Notifications are disabled in Settings. Pigeon will continue refreshing quietly."
					}
				}
			},
		)
	}
}
