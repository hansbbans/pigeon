import Observation
import SwiftUI

nonisolated enum ArticleReaderControl: Int, CaseIterable, Identifiable, Sendable {
	case markRead
	case recEngine
	case share
	case readingControls
	case shareToReadwise

	var id: Int { rawValue }

	var title: String {
		switch self {
		case .share: "Share"
		case .markRead: "Mark read"
		case .recEngine: "More like this"
		case .readingControls: "Reading controls"
		case .shareToReadwise: "Share to Readwise"
		}
	}

	var systemImage: String {
		switch self {
		case .share: "square.and.arrow.up"
		case .markRead: "largecircle.fill.circle"
		case .recEngine: "sparkles"
		case .readingControls: "textformat.size"
		case .shareToReadwise: "bookmark"
		}
	}

	func title(isRead: Bool) -> String {
		switch self {
		case .markRead: isRead ? "Mark unread" : "Mark read"
		default: title
		}
	}

	func systemImage(isRead: Bool) -> String {
		switch self {
		case .markRead: isRead ? "circle" : "largecircle.fill.circle"
		default: systemImage
		}
	}
}

nonisolated enum ArticleReaderReadingAdjustment: Int, CaseIterable, Identifiable, Sendable {
	case largerText
	case smallerText
	case looserLines
	case tighterLines

	var id: Int { rawValue }

	var title: String {
		switch self {
		case .largerText: "Larger text"
		case .smallerText: "Smaller text"
		case .looserLines: "Looser lines"
		case .tighterLines: "Tighter lines"
		}
	}

	var systemImage: String {
		switch self {
		case .largerText: "textformat.size.larger"
		case .smallerText: "textformat.size.smaller"
		case .looserLines: "arrow.down.to.line"
		case .tighterLines: "arrow.up.to.line"
		}
	}

	func isEnabled(textScale: Double, lineHeight: Double) -> Bool {
		switch self {
		case .largerText: textScale < ReaderTypographySettings.textScaleRange.upperBound
		case .smallerText: textScale > ReaderTypographySettings.textScaleRange.lowerBound
		case .looserLines: lineHeight < ReaderTypographySettings.lineHeightRange.upperBound
		case .tighterLines: lineHeight > ReaderTypographySettings.lineHeightRange.lowerBound
		}
	}
}

nonisolated struct ArticleReaderControlsSaveTaskID: Equatable, Sendable {
	let articleID: String
	let requestID: UUID?
}

struct ArticleReaderControlsSaveRequest: Equatable, Sendable {
	let articleID: String
	let readwiseRequest: ReadwiseSaveRequest

	var id: UUID {
		readwiseRequest.id
	}
}

@MainActor
@Observable
final class ArticleReaderControlsSaveState {
	private(set) var request: ArticleReaderControlsSaveRequest?
	private(set) var saveMessage: String?
	var isShowingSaveMessage = false

	var isSaving: Bool {
		request != nil
	}

	@discardableResult
	func begin(articleID: String, destination: OutboundDestination) -> ArticleReaderControlsSaveRequest {
		let request = ArticleReaderControlsSaveRequest(
			articleID: articleID,
			readwiseRequest: ReadwiseSaveRequest(destination: destination),
		)
		self.request = request
		saveMessage = nil
		isShowingSaveMessage = false
		return request
	}

	func articleDidChange(to articleID: String) {
		guard request?.articleID != articleID else {
			return
		}

		request = nil
		saveMessage = nil
		isShowingSaveMessage = false
	}

	func present(_ message: String) {
		saveMessage = message
		isShowingSaveMessage = true
	}

	@discardableResult
	func complete(_ request: ArticleReaderControlsSaveRequest, with message: String) -> Bool {
		guard self.request == request else {
			return false
		}

		self.request = nil
		present(message)
		return true
	}

	func cancel(_ request: ArticleReaderControlsSaveRequest) {
		guard self.request == request else {
			return
		}

		self.request = nil
	}
}

struct ArticleReaderControlsBar: View {
	let article: Recommendation

	@Environment(ReaderAppModel.self) private var model
	@State private var saveState = ArticleReaderControlsSaveState()

	var body: some View {
		VStack(spacing: 0) {
			Divider()
			HStack(spacing: 0) {
				markReadButton
				recEngineButton
				shareButton
				readingControlsButton
				shareToReadwiseButton
			}
			.labelStyle(.iconOnly)
			.buttonStyle(.borderless)
			.imageScale(.large)
			.frame(maxWidth: .infinity)
			.padding(.horizontal, 6)
			.padding(.vertical, 8)
		}
		.background(.bar)
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("article-reader-controls")
		.task(id: saveTaskID) {
			let taskID = saveTaskID
			await performReadwiseSave(for: taskID)
		}
		.onChange(of: article.id) { _, newArticleID in
			saveState.articleDidChange(to: newArticleID)
		}
		.alert("Readwise Reader", isPresented: $saveState.isShowingSaveMessage) {
			Button("OK") {}
		} message: {
			Text(saveState.saveMessage ?? "")
		}
	}

	private var shareButton: some View {
		controlSlot {
			if let shareURL = article.safeOriginalURL {
				ShareLink(item: shareURL, subject: Text(article.title)) {
					Label(ArticleReaderControl.share.title, systemImage: ArticleReaderControl.share.systemImage)
				}
				.keyboardShortcut("s", modifiers: [.command, .shift])
				.accessibilityHint("Opens the system share sheet")
			} else {
				Button(ArticleReaderControl.share.title, systemImage: ArticleReaderControl.share.systemImage) {}
					.disabled(true)
			}
		}
	}

	private var markReadButton: some View {
		controlSlot {
			Button(
				ArticleReaderControl.markRead.title(isRead: article.isRead),
				systemImage: ArticleReaderControl.markRead.systemImage(isRead: article.isRead),
			) {
				Task { await model.setRead(article, read: !article.isRead) }
			}
			.keyboardShortcut("u", modifiers: .command)
		}
	}

	private var recEngineButton: some View {
		controlSlot {
			Menu(ArticleReaderControl.recEngine.title, systemImage: ArticleReaderControl.recEngine.systemImage) {
				Button("More like this", systemImage: "sparkles") {
					Task { await model.recordPreference(.moreLikeThis, for: article) }
				}
				.keyboardShortcut("s", modifiers: .command)

				Button("Not interested", systemImage: "hand.thumbsdown") {
					Task { await model.recordPreference(.notInterested, for: article) }
				}
			}
			.accessibilityHint("Trains the recommendation engine")
			.accessibilityIdentifier("article-rec-engine")
		}
	}

	private var readingControlsButton: some View {
		controlSlot {
			Menu(ArticleReaderControl.readingControls.title, systemImage: ArticleReaderControl.readingControls.systemImage) {
				ForEach(ArticleReaderReadingAdjustment.allCases) { adjustment in
					Button(adjustment.title, systemImage: adjustment.systemImage) {
						applyReadingAdjustment(adjustment)
					}
					.disabled(
						adjustment.isEnabled(
							textScale: model.readerTypography.textScale,
							lineHeight: model.readerTypography.lineHeight,
						) == false
					)
				}
				Picker("Theme", selection: Binding(
					get: { model.readerTypography.theme },
					set: { model.readerTypography.theme = $0 },
				)) {
					ForEach(ReaderTheme.allCases) { theme in
						Text(theme.title).tag(theme)
					}
				}
				Divider()
				Button("Reset reading controls", systemImage: "arrow.counterclockwise") {
					model.readerTypography.reset()
				}
			}
		}
	}

	private var shareToReadwiseButton: some View {
		controlSlot {
			Button(ArticleReaderControl.shareToReadwise.title, systemImage: ArticleReaderControl.shareToReadwise.systemImage) {
				shareToReadwise()
			}
			.disabled(article.safeOriginalURL == nil || saveState.isSaving)
			.accessibilityHint("Saves this article to Readwise Reader")
			.accessibilityIdentifier("article-share-to-readwise")
		}
	}

	private func controlSlot<Content: View>(@ViewBuilder content: () -> Content) -> some View {
		content()
			.frame(maxWidth: .infinity, minHeight: 44)
	}

	private func applyReadingAdjustment(_ adjustment: ArticleReaderReadingAdjustment) {
		switch adjustment {
		case .largerText: model.readerTypography.increaseTextScale()
		case .smallerText: model.readerTypography.decreaseTextScale()
		case .looserLines: model.readerTypography.increaseLineHeight()
		case .tighterLines: model.readerTypography.decreaseLineHeight()
		}
	}

	private func shareToReadwise() {
		guard let url = article.safeOriginalURL, let destination = OutboundDestination(url: url) else {
			saveState.present("This article does not have an original web address.")
			return
		}

		saveState.begin(articleID: article.id, destination: destination)
	}

	private var saveTaskID: ArticleReaderControlsSaveTaskID {
		ArticleReaderControlsSaveTaskID(articleID: article.id, requestID: saveState.request?.id)
	}

	private func performReadwiseSave(for taskID: ArticleReaderControlsSaveTaskID) async {
		guard let request = saveState.request,
			request.articleID == article.id,
			request.articleID == taskID.articleID,
			request.id == taskID.requestID else {
			return
		}
		defer { saveState.cancel(request) }

		do {
			try Task.checkCancellation()
			switch try await model.saveToReader(request.readwiseRequest.destination) {
			case .saved:
				try Task.checkCancellation()
				_ = saveState.complete(request, with: "Saved to Reader.")
			case .alreadyInFlight:
				try Task.checkCancellation()
				_ = saveState.complete(request, with: "This article is already being saved.")
			}
		} catch is CancellationError {
			// Leaving the article is a normal cancellation.
		} catch {
			guard Task.isCancelled == false else {
				return
			}
			_ = saveState.complete(request, with: error.localizedDescription)
		}
	}
}
