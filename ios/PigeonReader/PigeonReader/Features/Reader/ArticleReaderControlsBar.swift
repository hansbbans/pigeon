import Observation
import SwiftUI

nonisolated enum ArticleReaderControl: Int, CaseIterable, Identifiable, Sendable {
	case markRead
	case recEngine
	case share
	case readingControls
	case readItLater

	var id: Int { rawValue }

	var title: String {
		switch self {
		case .share: "Share"
		case .markRead: "Mark read"
		case .recEngine: "More like this"
		case .readingControls: "Reading controls"
		// Distinct from the link menu's "Read It Later", which saves the link.
		case .readItLater: "Save to Read It Later"
		}
	}

	var systemImage: String {
		switch self {
		case .share: "square.and.arrow.up"
		case .markRead: "largecircle.fill.circle"
		case .recEngine: "sparkles"
		case .readingControls: "textformat.size"
		case .readItLater: "bookmark"
		}
	}

	/// Saved items archive instead of marking read.
	func title(isRead: Bool, isSaved: Bool = false) -> String {
		switch self {
		case .markRead where isSaved: isRead ? "Unarchive" : "Archive"
		case .markRead: isRead ? "Mark unread" : "Mark read"
		default: title
		}
	}

	func systemImage(isRead: Bool, isSaved: Bool = false) -> String {
		switch self {
		case .markRead where isSaved: isRead ? "tray.and.arrow.up" : "archivebox"
		case .markRead: isRead ? "circle" : "largecircle.fill.circle"
		default: systemImage
		}
	}
}

nonisolated enum ArticleShareItem: Equatable, Sendable {
	case url(URL)
	case text(String)

	static func make(from article: Recommendation) -> Self? {
		if let url = article.safeOriginalURL {
			return .url(url)
		}

		let text = shareText(for: article)
		return text.isEmpty ? nil : .text(text)
	}

	private static func shareText(for article: Recommendation) -> String {
		var lines: [String] = []
		let title = article.title.trimmingCharacters(in: .whitespacesAndNewlines)
		if title.isEmpty == false {
			lines.append(title)
		}

		let source = article.source.trimmingCharacters(in: .whitespacesAndNewlines)
		if source.isEmpty == false, source != title {
			lines.append(source)
		}

		let body: String
		if let text = article.text?.trimmingCharacters(in: .whitespacesAndNewlines), text.isEmpty == false {
			body = text
		} else {
			body = Self.plainText(fromHTML: article.html)
		}
		if body.isEmpty == false, body != title {
			if lines.isEmpty == false {
				lines.append("")
			}
			lines.append(body)
		}

		return lines.joined(separator: "\n")
	}

	private static func plainText(fromHTML html: String) -> String {
		var text = html.replacingOccurrences(
			of: #"</?(?:p|div|br|h[1-6]|li|tr|blockquote)[^>]*>"#,
			with: "\n",
			options: [.regularExpression, .caseInsensitive],
		)
		text = text.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
		let decoded = [
			"&nbsp;": " ",
			"&amp;": "&",
			"&lt;": "<",
			"&gt;": ">",
			"&quot;": "\"",
			"&#39;": "'",
			"&apos;": "'",
		].reduce(text) { result, pair in
			result.replacingOccurrences(of: pair.key, with: pair.value)
		}
		return decoded
			.components(separatedBy: .newlines)
			.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
			.filter { $0.isEmpty == false }
			.joined(separator: "\n\n")
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
	let saveRequest: SaveForLaterRequest

	var id: UUID {
		saveRequest.id
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
			saveRequest: SaveForLaterRequest(destination: destination),
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

	@discardableResult
	func completeQuietly(_ request: ArticleReaderControlsSaveRequest) -> Bool {
		guard self.request == request else {
			return false
		}

		self.request = nil
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
	let onShowReadingControls: () -> Void
	let onSaveConfirmation: (ReaderSaveConfirmation) -> Void

	@Environment(ReaderAppModel.self) private var model
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var saveState = ArticleReaderControlsSaveState()
	@State private var actionFeedbackCount = 0

	init(
		article: Recommendation,
		onShowReadingControls: @escaping () -> Void = {},
		onSaveConfirmation: @escaping (ReaderSaveConfirmation) -> Void = { _ in },
	) {
		self.article = article
		self.onShowReadingControls = onShowReadingControls
		self.onSaveConfirmation = onSaveConfirmation
	}

	var body: some View {
		VStack(spacing: 0) {
			Divider()
			HStack(spacing: 0) {
				markReadButton
				recEngineButton
				shareButton
				readingControlsButton
				readItLaterButton
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
			await performSave(for: taskID)
		}
		.onChange(of: article.id) { _, newArticleID in
			saveState.articleDidChange(to: newArticleID)
		}
		.sensoryFeedback(.selection, trigger: actionFeedbackCount)
		.alert("Read It Later", isPresented: $saveState.isShowingSaveMessage) {
			Button("OK") {}
		} message: {
			Text(saveState.saveMessage ?? "")
		}
	}

	private var shareButton: some View {
		controlSlot {
			switch ArticleShareItem.make(from: article) {
			case .url(let url):
				ShareLink(item: url, subject: Text(article.title)) {
					shareLabel
				}
				.keyboardShortcut("s", modifiers: [.command, .shift])
				.accessibilityHint("Opens the system share sheet")
				.accessibilityIdentifier("article-reader-share")
			case .text(let text):
				ShareLink(item: text, subject: Text(article.title)) {
					shareLabel
				}
				.keyboardShortcut("s", modifiers: [.command, .shift])
				.accessibilityHint("Opens the system share sheet")
				.accessibilityIdentifier("article-reader-share")
			case nil:
				Button(ArticleReaderControl.share.title, systemImage: ArticleReaderControl.share.systemImage) {}
					.disabled(true)
					.accessibilityIdentifier("article-reader-share")
			}
		}
	}

	private var shareLabel: some View {
		Label(ArticleReaderControl.share.title, systemImage: ArticleReaderControl.share.systemImage)
	}

	private var markReadButton: some View {
		controlSlot {
			Button(
				ArticleReaderControl.markRead.title(isRead: article.isRead, isSaved: article.isSaved),
				systemImage: ArticleReaderControl.markRead.systemImage(isRead: article.isRead, isSaved: article.isSaved),
			) {
				actionFeedbackCount &+= 1
				Task {
					await model.setRead(
						article,
						read: !article.isRead,
						animation: reduceMotion ? nil : ReaderMotion.animation(reduceMotion: false),
						offersUndo: true,
					)
				}
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
			Button(
				ArticleReaderControl.readingControls.title,
				systemImage: ArticleReaderControl.readingControls.systemImage,
				action: onShowReadingControls,
			)
			.accessibilityIdentifier("reader-reading-controls")
		}
	}

	private var readItLaterButton: some View {
		controlSlot {
			Button(ArticleReaderControl.readItLater.title, systemImage: article.isSaved ? "bookmark.fill" : ArticleReaderControl.readItLater.systemImage) {
				saveForLater()
			}
			// A saved item is already in Read It Later.
			.disabled(article.isSaved || article.safeOriginalURL == nil || saveState.isSaving)
			.accessibilityHint("Saves this article's web page to Read It Later")
			.accessibilityIdentifier("article-read-it-later")
		}
	}

	private func controlSlot<Content: View>(@ViewBuilder content: () -> Content) -> some View {
		content()
			.frame(maxWidth: .infinity, minHeight: 44)
	}

	private func saveForLater() {
		guard let url = article.safeOriginalURL, let destination = OutboundDestination(url: url) else {
			saveState.present("This article does not have an original web address.")
			return
		}

		saveState.begin(articleID: article.id, destination: destination)
	}

	private var saveTaskID: ArticleReaderControlsSaveTaskID {
		ArticleReaderControlsSaveTaskID(articleID: article.id, requestID: saveState.request?.id)
	}

	private func performSave(for taskID: ArticleReaderControlsSaveTaskID) async {
		guard let request = saveState.request,
			request.articleID == article.id,
			request.articleID == taskID.articleID,
			request.id == taskID.requestID else {
			return
		}
		defer { saveState.cancel(request) }

		do {
			try Task.checkCancellation()
			let outcome = try await model.saveForLater(request.saveRequest.destination.url, title: article.title)
			try Task.checkCancellation()
			guard saveState.completeQuietly(request) else { return }
			onSaveConfirmation(ReaderSaveConfirmation(message: outcome.confirmationMessage, isSuccess: outcome.isSuccess))
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
