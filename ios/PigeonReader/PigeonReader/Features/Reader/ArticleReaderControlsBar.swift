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

struct ArticleReaderControlsBar: View {
	let article: Recommendation

	@Environment(ReaderAppModel.self) private var model
	@State private var isSavingToReadwise = false
	@State private var saveMessage: String?
	@State private var isShowingSaveMessage = false

	var body: some View {
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
		.background(.bar)
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("article-reader-controls")
		.alert("Readwise Reader", isPresented: $isShowingSaveMessage) {
			Button("OK") {}
		} message: {
			Text(saveMessage ?? "")
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
				Button("Looser lines", systemImage: "arrow.down.to.line") {
					model.readerTypography.increaseLineHeight()
				}
				.disabled(model.readerTypography.lineHeight >= ReaderTypographySettings.lineHeightRange.upperBound)
				Button("Tighter lines", systemImage: "arrow.up.to.line") {
					model.readerTypography.decreaseLineHeight()
				}
				.disabled(model.readerTypography.lineHeight <= ReaderTypographySettings.lineHeightRange.lowerBound)
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
			.disabled(article.safeOriginalURL == nil || isSavingToReadwise)
			.accessibilityHint("Saves this article to Readwise Reader")
			.accessibilityIdentifier("article-share-to-readwise")
		}
	}

	private func controlSlot<Content: View>(@ViewBuilder content: () -> Content) -> some View {
		content()
			.frame(maxWidth: .infinity, minHeight: 44)
	}

	private func shareToReadwise() {
		guard let url = article.safeOriginalURL, let destination = OutboundDestination(url: url) else {
			presentSaveMessage("This article does not have an original web address.")
			return
		}

		Task {
			isSavingToReadwise = true
			defer { isSavingToReadwise = false }
			do {
				switch try await model.saveToReader(destination) {
				case .saved:
					presentSaveMessage("Saved to Reader.")
				case .alreadyInFlight:
					presentSaveMessage("This article is already being saved.")
				}
			} catch is CancellationError {
				// Leaving the article is a normal cancellation.
			} catch {
				presentSaveMessage(error.localizedDescription)
			}
		}
	}

	private func presentSaveMessage(_ message: String) {
		saveMessage = message
		isShowingSaveMessage = true
	}
}
