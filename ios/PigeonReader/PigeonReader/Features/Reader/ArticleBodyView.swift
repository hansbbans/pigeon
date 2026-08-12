import SwiftUI

struct ArticleBodyView: View {
	let content: AttributedString
	let openedDestination: (OutboundDestination) -> Void
	@Environment(\.openURL) private var openURL
	@State private var linkChoiceState = OutboundLinkChoiceState()
	@State private var shareDestination: OutboundDestination?

	var body: some View {
		Text(content)
			.font(ReaderTypography.articleBody)
			.textSelection(.enabled)
			.accessibilityElement(children: .combine)
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
			.sheet(item: $shareDestination) { destination in
				ReaderShareSheet(items: [destination.url])
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
			shareDestination = destination
		}
	}
}
