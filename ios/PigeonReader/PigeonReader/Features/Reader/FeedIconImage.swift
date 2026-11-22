import SwiftUI

/// A feed favicon from `FeedIconStore`. `content` receives nil until the icon
/// is ready, so each call site keeps its own placeholder and transition.
struct FeedIconImage<Content: View>: View {
	let url: URL
	var store: FeedIconStore = .shared
	@ViewBuilder let content: (Image?) -> Content

	@State private var loaded: LoadedIcon?

	var body: some View {
		// An icon already decoded shows in the first frame, with no flash of
		// the placeholder when a row scrolls back into view.
		let image = (loaded?.url == url ? loaded?.image : nil) ?? store.cachedImage(for: url)
		content(image.map { Image(uiImage: $0) })
			.task(id: url) {
				guard let image = await store.image(for: url), Task.isCancelled == false else { return }
				loaded = LoadedIcon(url: url, image: image)
			}
	}

	private struct LoadedIcon {
		let url: URL
		let image: UIImage
	}
}
