import SwiftUI

struct ArticleThumbnailView: View {
	let article: Recommendation
	let remoteImagePolicy: ReaderRemoteImagePolicy
	let thumbnailStore: ReaderFeedThumbnailStore?
	let thumbnailScope: String?

	@Environment(\.redactionReasons) private var redactionReasons
	@State private var loadedImage: CGImage?
	@State private var loadedRequestID: RequestID?

	private let requestID: RequestID

	init(
		article: Recommendation,
		remoteImagePolicy: ReaderRemoteImagePolicy,
		thumbnailStore: ReaderFeedThumbnailStore?,
		thumbnailScope: String?,
	) {
		self.article = article
		self.remoteImagePolicy = remoteImagePolicy
		self.thumbnailStore = thumbnailStore
		self.thumbnailScope = thumbnailScope
		requestID = RequestID(
			articleID: article.id,
			html: article.html,
			originalURL: article.safeOriginalURL?.absoluteString,
			scope: thumbnailScope,
			policy: remoteImagePolicy,
			isRedacted: false,
		)
	}

	var body: some View {
		content
			.frame(width: 72, height: 54)
			.clipShape(.rect(cornerRadius: 8))
			.task(id: effectiveRequestID) {
				let taskRequestID = effectiveRequestID
				guard remoteImagePolicy == .normal,
					redactionReasons.contains(.placeholder) == false,
					let thumbnailStore,
					let thumbnailScope,
					thumbnailScope.isEmpty == false else {
					loadedImage = nil
					loadedRequestID = nil
					return
				}

				loadedImage = nil
				loadedRequestID = nil
				let image = await thumbnailStore.thumbnail(
					for: article,
					scope: thumbnailScope,
				)
				guard Task.isCancelled == false else { return }
				loadedImage = image
				loadedRequestID = taskRequestID
			}
	}

	private var effectiveRequestID: RequestID {
		var requestID = self.requestID
		requestID.isRedacted = redactionReasons.contains(.placeholder)
		return requestID
	}

	@ViewBuilder
	private var content: some View {
		if remoteImagePolicy == .normal,
			redactionReasons.contains(.placeholder) == false,
			loadedRequestID == effectiveRequestID,
			let loadedImage {
			Image(decorative: loadedImage, scale: 3, orientation: .up)
				.resizable()
				.scaledToFill()
			.accessibilityLabel("Article image")
		} else {
			imagePlaceholder
		}
	}

	private var imagePlaceholder: some View {
		ZStack {
			Color.secondary.opacity(0.1)
			Image(systemName: placeholderSymbol)
				.foregroundStyle(.secondary)
		}
		.accessibilityHidden(true)
	}

	private var placeholderSymbol: String {
		if redactionReasons.contains(.placeholder) {
			return "photo"
		}
		return remoteImagePolicy == .blocked ? "photo.badge.shield.exclamationmark" : "photo"
	}

	private struct RequestID: Hashable, Sendable {
		let articleID: String
		let html: String
		let originalURL: String?
		let scope: String?
		let policy: ReaderRemoteImagePolicy
		var isRedacted: Bool
	}
}
