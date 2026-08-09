import SwiftUI

struct ArticleBodyView: View {
	let content: AttributedString
	let openedDestination: (OutboundDestination) -> Void

	var body: some View {
		Text(content)
			.font(ReaderTypography.articleBody)
			.textSelection(.enabled)
			.accessibilityElement(children: .combine)
			.environment(\.openURL, OpenURLAction(handler: handleOpenURL))
	}

	private func handleOpenURL(_ url: URL) -> OpenURLAction.Result {
		guard let destination = OutboundDestination(url: url) else {
			return .discarded
		}
		openedDestination(destination)
		return .systemAction(destination.url)
	}
}
