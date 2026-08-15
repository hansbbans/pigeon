import SwiftUI

struct PersonalizationSettingsView: View {
	@Environment(ReaderAppModel.self) private var model
	@State private var isShowingResetConfirmation = false
	@State private var exportText: String?

	var body: some View {
		Form {
			if let snapshot = model.personalization {
				Section("How Ranking Works") {
					Text(snapshot.policy.plainLanguageSummary)
					ForEach(snapshot.policy.confirmedSignals) { signal in
						LabeledContent(signal.name, value: signal.effect)
					}
				}

				Section("Confirmation and Retention") {
					Label(snapshot.policy.confirmationRule, systemImage: "checkmark.shield")
					Label(snapshot.policy.retention, systemImage: "clock.arrow.circlepath")
				}

				Section("Signal History") {
					if snapshot.history.isEmpty {
						ContentUnavailableView(
							"No confirmed signals",
							systemImage: "hand.thumbsup",
							description: Text("Pending and failed actions never appear here."),
						)
					} else {
						ForEach(snapshot.history) { entry in
							HStack(alignment: .top) {
								VStack(alignment: .leading, spacing: 3) {
									Text(entry.eventTitle)
										.font(.body.weight(.semibold))
									Text(entry.title ?? entry.source ?? "Story no longer retained")
										.font(.footnote)
										.foregroundStyle(.secondary)
									Text(entry.occurredAt, format: .dateTime.month().day().year().hour().minute())
										.font(.caption)
										.foregroundStyle(.secondary)
								}
								Spacer()
								Button("Delete", systemImage: "trash", role: .destructive) {
									Task { await model.deletePersonalizationHistory(id: entry.id) }
								}
								.labelStyle(.iconOnly)
								.accessibilityLabel("Delete \(entry.eventTitle) for \(entry.title ?? "story")")
							}
						}
					}
				}
			} else if model.isLoadingPersonalization {
				ProgressView("Loading confirmed signals")
			} else {
				ContentUnavailableView(
					"Personalization unavailable",
					systemImage: "wifi.exclamationmark",
					description: Text("Reconnect and try again."),
				)
			}

			Section {
				Button("Export Personalization Data", systemImage: "square.and.arrow.up") {
					Task { exportText = await model.exportPersonalization() }
				}
				Button("Reset All Preferences", systemImage: "arrow.counterclockwise", role: .destructive) {
					isShowingResetConfirmation = true
				}
			}
		}
		.navigationTitle("Personalization")
		.task { await model.loadPersonalization() }
		.refreshable { await model.loadPersonalization() }
		.sheet(isPresented: Binding(
			get: { exportText != nil },
			set: { if $0 == false { exportText = nil } },
		)) {
			if let exportText {
				ReaderTextShareSheet(text: exportText)
			}
		}
		.confirmationDialog(
			"Reset all personalization?",
			isPresented: $isShowingResetConfirmation,
			titleVisibility: .visible,
		) {
			Button("Reset All Preferences", role: .destructive) {
				Task { await model.resetPersonalization() }
			}
		} message: {
			Text("This permanently deletes confirmed ranking history from your Pigeon server. Read and starred story state is not changed.")
		}
	}
}
