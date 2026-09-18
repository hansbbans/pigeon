import SwiftUI

nonisolated struct ArticleBodyLayoutIdentity: Hashable, Sendable {
	let articleID: String
	let content: String
}

struct ArticleBodyView: View {
	let content: String
	let fallbackText: String
	let baseURL: URL?
	let leadImageURL: URL?
	let textScale: Double
	let lineHeight: Double
	let theme: ReaderTheme
	let remoteImagePolicy: ReaderRemoteImagePolicy
	let findQuery: String
	let imageProxySession: PigeonSession?
	let preparedBody: PreparedReaderBody?
	let openedDestination: (OutboundDestination) -> Void
	let saveToReader: (OutboundDestination) async throws -> ReadwiseSaveOutcome
	let onHTMLLayout: (ReaderHTMLLayout) -> Void
	let onBodyFrameChange: (CGFloat) -> Void

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
	@State private var asynchronouslyPreparedBody: PreparedReaderBody?
	@State private var asynchronouslyPreparedBodyID: ArticleBodyPreparationID?
	@Environment(\.dynamicTypeSize) private var dynamicTypeSize

	init(
		content: String,
		fallbackText: String,
		baseURL: URL?,
		leadImageURL: URL?,
		textScale: Double,
		lineHeight: Double,
		theme: ReaderTheme = .system,
		remoteImagePolicy: ReaderRemoteImagePolicy = .normal,
		findQuery: String = "",
		imageProxySession: PigeonSession? = nil,
		preparedBody: PreparedReaderBody? = nil,
		openedDestination: @escaping (OutboundDestination) -> Void,
		saveToReader: @escaping (OutboundDestination) async throws -> ReadwiseSaveOutcome,
		onHTMLLayout: @escaping (ReaderHTMLLayout) -> Void = { _ in },
		onBodyFrameChange: @escaping (CGFloat) -> Void = { _ in },
	) {
		self.content = content
		self.fallbackText = fallbackText
		self.baseURL = baseURL
		self.leadImageURL = leadImageURL
		self.textScale = textScale
		self.lineHeight = lineHeight
		self.theme = theme
		self.remoteImagePolicy = remoteImagePolicy
		self.findQuery = findQuery
		self.imageProxySession = imageProxySession
		self.preparedBody = preparedBody
		self.openedDestination = openedDestination
		self.saveToReader = saveToReader
		self.onHTMLLayout = onHTMLLayout
		self.onBodyFrameChange = onBodyFrameChange
	}

	var body: some View {
		let renderedTextScale = ReaderDynamicTypeScale.effectiveTextScale(
			manualTextScale: textScale,
			dynamicTypeSize: dynamicTypeSize,
		)

		renderedContent(textScale: renderedTextScale)
		.sheet(item: $imageSelection) { selection in
			ZoomableImageView(
				url: selection.url,
				remoteImagePolicy: remoteImagePolicy,
				imageProxySession: imageProxySession,
			)
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
		.alert("Couldn’t Save to Reader", isPresented: $isShowingSaveMessage) {
			Button("OK") {}
		} message: {
			Text(saveMessage ?? "")
		}
		.task(id: preparationID) {
			await prepareContentIfNeeded()
		}
	}

	private var effectivePreparedBody: PreparedReaderBody? {
		if let preparedBody {
			return preparedBody
		}
		guard asynchronouslyPreparedBodyID == preparationID else { return nil }
		return asynchronouslyPreparedBody
	}

	private var sanitizedContent: String {
		effectivePreparedBody?.sanitizedHTML ?? ""
	}

	private var bodyImageURLs: [URL] {
		effectivePreparedBody?.imageURLs ?? []
	}

	private var preparationID: ArticleBodyPreparationID {
		ArticleBodyPreparationID(content: content, baseURL: baseURL)
	}

	private func prepareContentIfNeeded() async {
		guard preparedBody == nil,
			asynchronouslyPreparedBodyID != preparationID,
			content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
			return
		}
		let requestID = preparationID
		let source = content
		let sourceURL = baseURL
		let body = await Task.detached(priority: .utility) {
			PreparedReaderBody.make(sanitizedHTML: source, baseURL: sourceURL)
		}.value
		guard Task.isCancelled == false, requestID == preparationID else { return }
		asynchronouslyPreparedBody = body
		asynchronouslyPreparedBodyID = requestID
	}

	private func renderedContent(textScale: Double) -> some View {
		VStack(alignment: .leading, spacing: 16) {
			if remoteImagePolicy == .blocked, bodyImageURLs.isEmpty == false {
				blockedRemoteImagesNotice
			}
			if let fallbackImageURL {
				Button {
					imageSelection = ArticleImageSelection(url: fallbackImageURL)
				} label: {
					RemoteArticleImageView(
						url: fallbackImageURL,
						remoteImagePolicy: remoteImagePolicy,
						imageProxySession: imageProxySession,
					)
					.id(
						ArticleLeadImageRequest.loaderIdentity(
							for: fallbackImageURL,
							policy: remoteImagePolicy,
							session: imageProxySession,
						),
					)
						.clipShape(.rect(cornerRadius: 10))
				}
				.buttonStyle(.plain)
				.accessibilityLabel("View lead image")
				.accessibilityHint("Opens a zoomable image viewer")
			}

			if effectivePreparedBody == nil,
				asynchronouslyPreparedBodyID != preparationID,
				content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
				ArticleBodyPreparationPlaceholder()
			} else if sanitizedContent.isEmpty {
				Text(fallbackText)
				.font(ReaderTypography.articleBody(textScale: self.textScale))
					.textSelection(.enabled)
			} else {
				structuredContent(textScale: textScale)
			}
		}
		.background {
			GeometryReader { geometry in
				Color.clear.preference(key: ArticleColumnWidthKey.self, value: geometry.size.width)
			}
		}
		.onPreferenceChange(ArticleColumnWidthKey.self) { columnWidth = $0 }
		.onPreferenceChange(ArticleBodyFrameKey.self, perform: onBodyFrameChange)
		.preference(key: ArticleBodyLayoutKey.self, value: bodyLayoutReady)
	}

	private var bodyLayoutReady: Bool {
		if effectivePreparedBody == nil {
			return content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
				&& fallbackText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
		}
		return sanitizedContent.isEmpty || webViewHeight > 1
	}

	private var blockedRemoteImagesNotice: some View {
		Label(
			"Remote images are blocked. Tap an image placeholder to load only that image.",
			systemImage: "hand.raised.fill",
		)
		.font(.footnote)
		.foregroundStyle(.secondary)
		.accessibilityIdentifier("remote-images-blocked-notice")
	}

	private func structuredContent(textScale: Double) -> some View {
		StructuredHTMLView(
			html: sanitizedContent,
			baseURL: baseURL,
			textScale: textScale,
			lineHeight: lineHeight,
			theme: theme,
			remoteImagePolicy: remoteImagePolicy,
			findQuery: findQuery,
			imageProxySession: imageProxySession,
			contentHeight: $webViewHeight,
			onLink: handleLink,
			onImage: handleImage,
			onImageFailure: handleImageFailure,
			onLayout: onHTMLLayout,
		)
		.background {
				GeometryReader { geometry in
					Color.clear.preference(
						key: ArticleBodyFrameKey.self,
						value: geometry.frame(in: .named(ReaderScrollCoordinateSpace.name)).minY,
					)
				}
		}
		.frame(width: columnWidth > 0 ? columnWidth : nil, alignment: .leading)
		.frame(maxWidth: .infinity, alignment: .leading)
		.frame(height: max(webViewHeight, 1))
			.clipped()
	}

	private var fallbackImageURL: URL? {
		guard ArticleLeadImageRequest.shouldShowFallback(
			policy: remoteImagePolicy,
			session: imageProxySession,
		) else { return nil }
		return ArticleImagePolicy.fallbackLeadImageURL(
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
			// The reader presents successful saves near its controls so the
			// confirmation stays visible even when this body is scrolled.
			_ = try await saveToReader(request.destination)
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

private struct ArticleBodyFrameKey: PreferenceKey {
	static let defaultValue: CGFloat = 0

	static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
		value = nextValue()
	}
}

struct ArticleBodyLayoutKey: PreferenceKey {
	static let defaultValue = false

	static func reduce(value: inout Bool, nextValue: () -> Bool) {
		value = nextValue()
	}
}

private struct ArticleBodyPreparationPlaceholder: View {
	var body: some View {
		Text("Preparing article")
			.font(.footnote)
			.foregroundStyle(.tertiary)
			.frame(maxWidth: .infinity, minHeight: 72)
	}
}

private struct ArticleBodyPreparationID: Equatable {
	let content: String
	let baseURL: URL?
}
