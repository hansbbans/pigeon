import Combine
import SwiftUI
import UIKit

struct RemoteArticleImageView: View {
	let url: URL
	let remoteImagePolicy: ReaderRemoteImagePolicy
	let imageProxySession: PigeonSession?

	@StateObject private var loader: RemoteArticleImageLoader
	@State private var availableWidth: CGFloat = 1

	init(
		url: URL,
		remoteImagePolicy: ReaderRemoteImagePolicy = .normal,
		imageProxySession: PigeonSession? = nil,
	) {
		self.url = url
		self.remoteImagePolicy = remoteImagePolicy
		self.imageProxySession = imageProxySession
		_loader = StateObject(
			wrappedValue: RemoteArticleImageLoader(
				url: url,
				policy: remoteImagePolicy,
				session: imageProxySession,
			),
		)
	}

	var body: some View {
		GeometryReader { proxy in
			content(maxWidth: proxy.size.width)
				.onAppear {
					availableWidth = proxy.size.width
				}
				.onChange(of: proxy.size.width) { _, width in
					availableWidth = width
				}
		}
		.frame(maxWidth: .infinity)
		.frame(height: contentHeight)
		.task {
			loader.loadIfNeeded()
		}
	}

	@ViewBuilder
	private func content(maxWidth: CGFloat) -> some View {
		switch loader.state {
		case .loading:
			ProgressView("Loading lead image")
				.frame(maxWidth: .infinity, minHeight: 120)
		case .loaded(let image):
			let size = ArticleImageSizing.displayedSize(
				imageSize: image.size,
				columnWidth: max(maxWidth, 1),
			)
			Image(uiImage: image)
				.resizable()
				.aspectRatio(contentMode: .fit)
				.frame(width: size.width, height: size.height)
				.clipShape(.rect(cornerRadius: 10))
				.frame(maxWidth: .infinity)
		case .failed:
			Label("Lead image unavailable", systemImage: "photo.badge.exclamationmark")
				.frame(maxWidth: .infinity, minHeight: 88)
				.foregroundStyle(.secondary)
		}
	}

	private var contentHeight: CGFloat {
		switch loader.state {
		case .loading:
			return 120
		case .failed:
			return 88
		case .loaded(let image):
			let size = ArticleImageSizing.displayedSize(
				imageSize: image.size,
				columnWidth: max(availableWidth, 1),
			)
			return max(size.height, 1)
		}
	}
}

@MainActor
private final class RemoteArticleImageLoader: ObservableObject {
	enum State {
		case loading
		case loaded(UIImage)
		case failed
	}

	let url: URL
	private let policy: ReaderRemoteImagePolicy
	private let session: PigeonSession?
	@Published private(set) var state = State.loading
	private var loadTask: Task<Void, Never>?

	init(url: URL, policy: ReaderRemoteImagePolicy, session: PigeonSession?) {
		self.url = url
		self.policy = policy
		self.session = session
	}

	func loadIfNeeded() {
		guard loadTask == nil else {
			return
		}

		loadTask = Task { [weak self] in
			guard let self else { return }
			defer { loadTask = nil }

			do {
				guard let request = ArticleLeadImageRequest.loadRequest(
					for: url,
					policy: policy,
					session: session,
				) else {
					throw URLError(.badURL)
				}
				let (data, response) = try await URLSession.shared.data(for: request)
				try Task.checkCancellation()
				guard data.count <= ArticleLeadImageRequest.maximumResponseBytes,
					let response = response as? HTTPURLResponse,
					(200..<300).contains(response.statusCode),
					let image = UIImage(data: data) else {
					throw URLError(.cannotDecodeContentData)
				}
				state = .loaded(image)
			} catch is CancellationError {
				return
			} catch {
				state = .failed
			}
		}
	}

	deinit {
		loadTask?.cancel()
	}
}
