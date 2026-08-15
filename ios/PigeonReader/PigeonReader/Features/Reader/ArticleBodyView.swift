import SwiftUI

struct ArticleBodyView: View {
	let content: String
	let fallbackText: String
	let baseURL: URL?
	let leadImageURL: URL?
	let textScale: Double
	let lineHeight: Double
	let openedDestination: (OutboundDestination) -> Void
	let saveToReader: (OutboundDestination) async throws -> ReadwiseSaveOutcome

	private let sanitizedContent: String
	private let bodyImageURLs: [URL]
	@Environment(\.openURL) private var openURL
	@State private var linkChoiceState = OutboundLinkChoiceState()
	@State private var readwiseSaveRequest: ReadwiseSaveRequest?
	@State private var saveMessage: String?
	@State private var isShowingSaveMessage = false
	@State private var imageSelection: ArticleImageSelection?
	@State private var linkedImage: LinkedArticleImage?
	@State private var isShowingLinkedImageDialog = false
	@State private var deferredLinkDestination: OutboundDestination?
	@State private var failedImageURLs: Set<String> = []
	@State private var webViewHeight: CGFloat = 1
	@State private var columnWidth: CGFloat = 0
	@Environment(\.dynamicTypeSize) private var dynamicTypeSize

	init(
		content: String,
		fallbackText: String,
		baseURL: URL?,
		leadImageURL: URL?,
		textScale: Double,
		lineHeight: Double,
		openedDestination: @escaping (OutboundDestination) -> Void,
		saveToReader: @escaping (OutboundDestination) async throws -> ReadwiseSaveOutcome,
	) {
		self.content = content
		self.fallbackText = fallbackText
		self.baseURL = baseURL
		self.leadImageURL = leadImageURL
		self.textScale = textScale
		self.lineHeight = lineHeight
		self.openedDestination = openedDestination
		self.saveToReader = saveToReader
		sanitizedContent = StructuredHTMLSanitizer.sanitize(html: content, baseURL: baseURL)
		bodyImageURLs = StructuredHTMLSanitizer.imageURLs(in: content, baseURL: baseURL)
	}

	var body: some View {
		let renderedTextScale = ReaderDynamicTypeScale.effectiveTextScale(
			manualTextScale: textScale,
			dynamicTypeSize: dynamicTypeSize,
		)

		VStack(alignment: .leading, spacing: 16) {
			if let fallbackImageURL {
				Button(action: {
					imageSelection = ArticleImageSelection(url: fallbackImageURL)
				}) {
					RemoteArticleImageView(url: fallbackImageURL)
					.clipShape(.rect(cornerRadius: 10))
				}
				.buttonStyle(.plain)
				.accessibilityLabel("View lead image")
				.accessibilityHint("Opens a zoomable image viewer")
			}

			if sanitizedContent.isEmpty {
				Text(fallbackText)
					.font(ReaderTypography.articleBody)
					.textSelection(.enabled)
			} else {
					StructuredHTMLView(
						html: sanitizedContent,
						baseURL: baseURL,
						textScale: renderedTextScale,
					lineHeight: lineHeight,
					contentHeight: $webViewHeight,
					onLink: handleLink,
					onImage: handleImage,
					onImageFailure: handleImageFailure,
				)
				.frame(width: columnWidth > 0 ? columnWidth : nil, alignment: .leading)
				.frame(maxWidth: .infinity, alignment: .leading)
				.frame(height: max(webViewHeight, 1))
				.clipped()
			}
		}
		.background {
			GeometryReader { geometry in
				Color.clear.preference(key: ArticleColumnWidthKey.self, value: geometry.size.width)
			}
		}
		.onPreferenceChange(ArticleColumnWidthKey.self) { columnWidth = $0 }
		.sheet(item: $imageSelection) { selection in
			ZoomableImageView(url: selection.url)
		}
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
		.confirmationDialog(
			"Linked image",
			isPresented: $isShowingLinkedImageDialog,
			presenting: linkedImage,
		) { linkedImage in
			Button("View image") {
				imageSelection = ArticleImageSelection(url: linkedImage.imageURL)
			}
			Button("Open link") {
				openLinkedImageDestination(linkedImage)
			}
			Button("Cancel", role: .cancel) {}
		} message: { linkedImage in
			Text(linkedImage.destinationURL.absoluteString)
		}
		.onChange(of: isShowingLinkedImageDialog) { _, isPresented in
			guard isPresented == false, let destination = deferredLinkDestination else {
				return
			}

			deferredLinkDestination = nil
			Task { @MainActor in
				// Let the linked-image confirmation finish its dismissal before
				// presenting the existing browser/Readwise choice.
				await Task.yield()
				handleLink(destination.url)
			}
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

	private var fallbackImageURL: URL? {
		ArticleImagePolicy.fallbackLeadImageURL(
			bodyImageURLs: bodyImageURLs,
			leadImageURL: leadImageURL,
			failedImageURLs: failedImageURLs,
		)
	}

	private func handleLink(_ url: URL) {
		guard let destination = linkChoiceState.accept(url) else {
			return
		}
		openedDestination(destination)
	}

	private func handleImage(_ imageURL: URL, _ linkURL: URL?) {
		if let linkURL, OutboundDestination(url: linkURL) != nil {
			linkedImage = LinkedArticleImage(imageURL: imageURL, destinationURL: linkURL)
			isShowingLinkedImageDialog = true
		} else {
			imageSelection = ArticleImageSelection(url: imageURL)
		}
	}

	private func handleImageFailure(_ urls: [URL]) {
		let reportedURLs = urls.isEmpty && bodyImageURLs.count == 1 ? bodyImageURLs : urls
		failedImageURLs.formUnion(reportedURLs.map(\.absoluteString))
	}

	private func choose(_ choice: OutboundLinkChoice, for destination: OutboundDestination) {
		guard linkChoiceState.pendingDestination == destination,
			let route = linkChoiceState.choose(choice) else {
			return
		}

		switch route {
		case .openInBrowser(let destination):
			openURL(destination.url)
		case .shareToReader(let destination):
			readwiseSaveRequest = ReadwiseSaveRequest(destination: destination)
		}
	}

	private func openLinkedImageDestination(_ linkedImage: LinkedArticleImage) {
		deferredLinkDestination = OutboundDestination(url: linkedImage.destinationURL)
		isShowingLinkedImageDialog = false
		self.linkedImage = nil
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

private struct ArticleColumnWidthKey: PreferenceKey {
	static let defaultValue: CGFloat = 0

	static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
		value = nextValue()
	}
}
