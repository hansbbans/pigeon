import Combine
import SwiftUI
import UIKit

struct ArticleListThumbnailView: View {
	let remoteURL: URL
	let policy: ReaderRemoteImagePolicy
	let session: PigeonSession?

	@StateObject private var loader = ArticleListThumbnailLoader()

	var body: some View {
		Group {
			switch policy {
			case .normal:
				AsyncImage(url: remoteURL) { image in
					image.resizable().scaledToFill()
				} placeholder: {
					placeholder
				}
			case .privacyProxied:
				switch loader.state {
				case .idle, .loading:
					placeholder
				case .loaded(let image):
					Image(uiImage: image)
						.resizable()
						.scaledToFill()
				case .failed:
					placeholder
				}
			case .blocked:
				placeholder
			}
		}
		.frame(width: 72, height: 54)
		.clipShape(.rect(cornerRadius: 8))
		.accessibilityLabel("Article image")
		.task(id: loadIdentity) {
			guard policy == .privacyProxied else {
				return
			}
			await loader.load(
				ArticleListThumbnailRequest.loadRequest(
					for: remoteURL,
					policy: policy,
					session: session,
				),
			)
		}
	}

	private var loadIdentity: String {
		"\(remoteURL.absoluteString)|\(policy.rawValue)|\(session?.storageIdentity ?? "none")"
	}

	private var placeholder: some View {
		ZStack {
			Color.secondary.opacity(0.1)
			Image(systemName: policy == .blocked ? "photo.badge.shield.exclamationmark" : "photo")
				.foregroundStyle(.secondary)
		}
		.accessibilityHidden(true)
	}
}

@MainActor
private final class ArticleListThumbnailLoader: ObservableObject {
	enum State {
		case idle
		case loading
		case loaded(UIImage)
		case failed
	}

	@Published private(set) var state = State.idle

	func load(_ request: URLRequest?) async {
		guard let request else {
			state = .failed
			return
		}

		state = .loading
		do {
			let (data, response) = try await URLSession.shared.data(for: request)
			try Task.checkCancellation()
			guard let response = response as? HTTPURLResponse,
				(200..<300).contains(response.statusCode),
				data.count <= PrivacyProxiedImageRequest.maximumResponseBytes,
				let mimeType = response.mimeType,
				mimeType.lowercased().hasPrefix("image/"),
				let image = UIImage(data: data) else {
				state = .failed
				return
			}
			state = .loaded(image)
		} catch is CancellationError {
			return
		} catch {
			state = .failed
		}
	}
}
