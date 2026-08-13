import SwiftUI

struct ArticleBodyView: View {
	let content: AttributedString
	let openedDestination: (OutboundDestination) -> Void
	let saveToReader: (OutboundDestination) async throws -> ReadwiseSaveOutcome
	@Environment(\.openURL) private var openURL
	@State private var linkChoiceState = OutboundLinkChoiceState()
	@State private var readwiseSaveRequest: ReadwiseSaveRequest?
	@State private var saveMessage: String?
	@State private var isShowingSaveMessage = false

	var body: some View {
		Text(content)
			.font(.body)
			.textSelection(.enabled)
			.environment(\.openURL, OpenURLAction(handler: handleOpenURL))
			.confirmationDialog(
				"Open article link",
				isPresented: $linkChoiceState.isDialogPresented,
				titleVisibility: .visible,
				presenting: linkChoiceState.pendingDestination,
			) { destination in
				Button("Open in Browser") {
					choose(.openInBrowser, for: destination)
				}
				Button("Share to Reader") {
					choose(.shareToReader, for: destination)
				}
				Button("Cancel", role: .cancel) {}
			} message: { destination in
				Text(destination.url.absoluteString)
			}
			.task(id: readwiseSaveRequest?.id) {
				await performReadwiseSave()
			}
			.alert("Readwise Reader", isPresented: $isShowingSaveMessage) {
				Button("OK") {}
			} message: {
				Text(saveMessage ?? "")
			}
	}

	private func handleOpenURL(_ url: URL) -> OpenURLAction.Result {
		guard let destination = linkChoiceState.accept(url) else {
			return .discarded
		}
		openedDestination(destination)
		return .handled
	}

	private func choose(_ choice: OutboundLinkChoice, for destination: OutboundDestination) {
		guard linkChoiceState.pendingDestination == destination else {
			return
		}
		guard let route = linkChoiceState.choose(choice) else {
			return
		}

		switch route {
		case .openInBrowser(let destination):
			openURL(destination.url)
		case .shareToReader(let destination):
			readwiseSaveRequest = ReadwiseSaveRequest(destination: destination)
		}
	}

	private func performReadwiseSave() async {
		guard let request = readwiseSaveRequest else {
			return
		}
		defer {
			if readwiseSaveRequest?.id == request.id {
				readwiseSaveRequest = nil
			}
		}

		do {
			switch try await saveToReader(request.destination) {
			case .saved:
				presentSaveMessage("Saved to Reader.")
			case .alreadyInFlight:
				presentSaveMessage("This link is already being saved.")
			}
		} catch is CancellationError {
			// Leaving the article is a normal cancellation.
		} catch {
			presentSaveMessage(error.localizedDescription)
		}
	}

	private func presentSaveMessage(_ message: String) {
		saveMessage = message
		isShowingSaveMessage = true
	}
}
