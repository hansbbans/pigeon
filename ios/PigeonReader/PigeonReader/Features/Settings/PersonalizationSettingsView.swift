import SwiftUI

struct PersonalizationSettingsView: View {
	@Environment(ReaderAppModel.self) private var model
	@State private var isShowingResetConfirmation = false
	@State private var exportText: String?
	@State private var monitoredTopics: [String] = []
	@State private var newTopic = ""
	@State private var topicMessage: String?
	@State private var topicMessageIsError = false

	var body: some View {
		Form {
			SettingsErrorSection()
			if let snapshot = model.personalization {
				Section("Topics to Monitor") {
					Text("For You prioritizes matching stories from your existing subscriptions. Topics do not create subscriptions or send notifications.")
						.font(.footnote)
						.foregroundStyle(.secondary)

					HStack {
						TextField("Topic to monitor", text: $newTopic)
							.textInputAutocapitalization(.sentences)
							.autocorrectionDisabled()
							.disabled(model.isUpdatingPersonalization)
							.accessibilityIdentifier("monitored-topic-input")
							.submitLabel(.done)
							.onSubmit { addTopic() }
						Button("Add Topic", systemImage: "plus") {
							addTopic()
						}
						.labelStyle(.iconOnly)
						.accessibilityLabel("Add Topic")
						.disabled(model.isUpdatingPersonalization)
					}

					if monitoredTopics.isEmpty {
						ContentUnavailableView(
							"No monitored topics",
							systemImage: "text.magnifyingglass",
							description: Text("Add a topic to tune For You. Examples: SwiftUI, climate policy, or design systems."),
						)
					} else {
						ForEach(monitoredTopics, id: \.self) { topic in
							HStack {
								Text(topic)
									.accessibilityIdentifier("monitored-topic-\(topic)")
								Spacer()
								Button("Remove \(topic)", systemImage: "xmark.circle", role: .destructive) {
									removeTopic(topic)
								}
								.labelStyle(.iconOnly)
								.disabled(model.isUpdatingPersonalization)
							}
						}
					}

					LabeledContent("Topics saved", value: "\(monitoredTopics.count)/\(PersonalizationTopicRules.maximumTopicCount)")
					if let personalizationError = model.personalizationErrorMessage {
						Label(personalizationError, systemImage: "exclamationmark.triangle")
							.font(.footnote)
							.foregroundStyle(.red)
					} else if let topicMessage {
						Label(topicMessage, systemImage: topicMessageIsError ? "exclamationmark.triangle" : "checkmark.circle")
							.font(.footnote)
							.foregroundStyle(topicMessageIsError ? .red : .secondary)
					}
					if model.isUpdatingPersonalization {
						ProgressView("Saving topics")
							.font(.footnote)
					}
				}

				Section("How Ranking Works") {
					Text(snapshot.policy.plainLanguageSummary)
					Text("Recommended puts your strongest matches first. Monitored topics make matching stories more important within your subscriptions.")
						.font(.footnote)
						.foregroundStyle(.secondary)
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
								.disabled(model.isUpdatingPersonalization)
							}
						}
					}
				}
			} else if model.isLoadingPersonalization {
				ProgressView("Loading personalization")
			} else {
				if let personalizationError = model.personalizationErrorMessage {
					Section {
						Label(personalizationError, systemImage: "exclamationmark.triangle")
							.foregroundStyle(.red)
					}
				}
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
				.disabled(model.isUpdatingPersonalization || model.isLoadingPersonalization)
				Button("Reset All Preferences", systemImage: "arrow.counterclockwise", role: .destructive) {
					isShowingResetConfirmation = true
				}
				.disabled(model.isUpdatingPersonalization || model.isLoadingPersonalization)
			}
		}
		.navigationTitle("Personalization")
		.task(id: model.session?.storageIdentity) {
			// A new account must never inherit the previous account's draft or topics.
			monitoredTopics = []
			newTopic = ""
			topicMessage = nil
			let accountID = model.session?.storageIdentity
			await model.loadPersonalization()
			guard !Task.isCancelled,
				model.session?.storageIdentity == accountID,
				let snapshot = model.personalization else { return }
			monitoredTopics = snapshot.monitoredTopics
		}
		.refreshable {
			let accountID = model.session?.storageIdentity
			await model.loadPersonalization()
			guard !Task.isCancelled,
				model.session?.storageIdentity == accountID,
				let snapshot = model.personalization else { return }
			monitoredTopics = snapshot.monitoredTopics
		}
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
				Task { await resetPersonalization() }
			}
		} message: {
			Text("This permanently deletes monitored topics and confirmed ranking history from your Pigeon server. Read and starred story state is not changed.")
		}
	}

	private func addTopic() {
		guard model.isUpdatingPersonalization == false else { return }
		model.clearPersonalizationError()
		topicMessage = nil
		guard let topic = PersonalizationTopicRules.normalizedTopic(newTopic) else {
			showTopicError(PersonalizationTopicValidationError.invalidLength.localizedDescription)
			return
		}
		guard monitoredTopics.contains(where: { $0.caseInsensitiveCompare(topic) == .orderedSame }) == false else {
			showTopicError(PersonalizationTopicValidationError.duplicate.localizedDescription)
			return
		}
		guard monitoredTopics.count < PersonalizationTopicRules.maximumTopicCount else {
			showTopicError(PersonalizationTopicValidationError.tooMany.localizedDescription)
			return
		}

		let accountID = model.session?.storageIdentity
		let previousTopics = monitoredTopics
		let submittedDraft = newTopic
		monitoredTopics.append(topic)
		let proposedTopics = monitoredTopics
		Task { @MainActor in
			let saved = await model.saveMonitoredTopics(proposedTopics)
			guard !Task.isCancelled, model.session?.storageIdentity == accountID else { return }
			if saved {
				monitoredTopics = model.personalization?.monitoredTopics ?? proposedTopics
				if newTopic == submittedDraft {
					newTopic = ""
				}
				topicMessage = "Topics saved."
				topicMessageIsError = false
			} else {
				monitoredTopics = previousTopics
				showTopicError(model.personalizationErrorMessage ?? "Topics could not be saved. Try again.")
			}
		}
	}

	private func removeTopic(_ topic: String) {
		guard model.isUpdatingPersonalization == false else { return }
		let accountID = model.session?.storageIdentity
		let previousTopics = monitoredTopics
		monitoredTopics.removeAll { $0 == topic }
		let proposedTopics = monitoredTopics
		model.clearPersonalizationError()
		topicMessage = nil
		Task { @MainActor in
			let saved = await model.saveMonitoredTopics(proposedTopics)
			guard !Task.isCancelled, model.session?.storageIdentity == accountID else { return }
			if saved {
				monitoredTopics = model.personalization?.monitoredTopics ?? proposedTopics
				topicMessage = "Topics saved."
				topicMessageIsError = false
			} else {
				monitoredTopics = previousTopics
				showTopicError(model.personalizationErrorMessage ?? "Topics could not be saved. Try again.")
			}
		}
	}

	private func resetPersonalization() async {
		let reset = await model.resetPersonalization()
		guard !Task.isCancelled, reset else { return }
		monitoredTopics = model.personalization?.monitoredTopics ?? []
		newTopic = ""
		topicMessage = "Preferences reset."
		topicMessageIsError = false
	}

	private func showTopicError(_ message: String) {
		topicMessage = message
		topicMessageIsError = true
	}
}
