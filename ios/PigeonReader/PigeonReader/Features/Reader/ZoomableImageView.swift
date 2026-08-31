import Combine
import SwiftUI
import UIKit

struct ZoomableImageView: View {
	let url: URL
	let remoteImagePolicy: ReaderRemoteImagePolicy
	let imageProxySession: PigeonSession?

	@StateObject private var loader: ZoomableImageLoader
	@State private var scale = 1.0
	@State private var magnificationStart = 1.0

	init(
		url: URL,
		remoteImagePolicy: ReaderRemoteImagePolicy = .normal,
		imageProxySession: PigeonSession? = nil,
	) {
		self.url = url
		self.remoteImagePolicy = remoteImagePolicy
		self.imageProxySession = imageProxySession
		_loader = StateObject(
			wrappedValue: ZoomableImageLoader(
				url: url,
				policy: remoteImagePolicy,
				session: imageProxySession,
			),
		)
	}

	var body: some View {
		NavigationStack {
			ScrollView([.horizontal, .vertical]) {
				imageContent
					.frame(maxWidth: .infinity, maxHeight: .infinity)
					.contentShape(Rectangle())
					.gesture(
						MagnificationGesture()
							.onChanged { value in
								scale = min(max(magnificationStart * value, 1), 5)
							}
							.onEnded { _ in
								magnificationStart = scale
							},
					)
			}
			.scrollIndicators(.hidden)
			.background(.black)
			.navigationTitle("Image")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .topBarTrailing) {
					Button("Reset zoom", systemImage: "arrow.counterclockwise") {
						scale = 1
						magnificationStart = 1
					}
					.disabled(scale == 1)
				}
			}
			.task {
				loader.loadIfNeeded()
			}
		}
	}

	@ViewBuilder
	private var imageContent: some View {
		switch loader.state {
		case .loading:
			ProgressView("Loading image")
				.frame(minWidth: 240, minHeight: 240)
		case .loaded(let image):
			Image(uiImage: image)
				.resizable()
				.scaledToFit()
				.scaleEffect(scale)
				.frame(minWidth: 240, minHeight: 240)
		case .failed:
			ContentUnavailableView(
				"Image unavailable",
				systemImage: "photo.badge.exclamationmark",
				description: Text("This image could not be loaded."),
			)
			.frame(minWidth: 240, minHeight: 240)
		}
	}
}

@MainActor
private final class ZoomableImageLoader: ObservableObject {
	enum State {
		case loading
		case loaded(UIImage)
		case failed
	}

	private let url: URL
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

			guard let request = PrivacyProxiedImageRequest.loadRequest(
				for: url,
				policy: policy,
				session: session,
			) else {
				state = .failed
				return
			}

			do {
				let (data, response) = try await URLSession.shared.data(for: request)
				try Task.checkCancellation()
				guard data.count <= PrivacyProxiedImageRequest.maximumResponseBytes,
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
