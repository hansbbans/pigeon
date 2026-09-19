import SwiftUI

struct ZoomableImageView: View {
	let url: URL
	let remoteImagePolicy: ReaderRemoteImagePolicy
	let imageProxySession: PigeonSession?

	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.dismiss) private var dismiss
	@StateObject private var loader: ZoomableImageLoader
	@State private var zoomScale = ZoomableImageInteraction.minimumZoomScale

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
			ZStack {
				Color.black
					.ignoresSafeArea()

				imageContent
			}
			.navigationTitle("Article image")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .topBarLeading) {
					Button("Close", systemImage: "xmark", action: dismiss.callAsFunction)
						.accessibilityIdentifier("image-viewer-close")
				}

				ToolbarItemGroup(placement: .topBarTrailing) {
					Button("Zoom in", systemImage: "plus.magnifyingglass", action: zoomIn)
						.disabled(isImageLoaded == false || zoomScale >= ZoomableImageInteraction.maximumZoomScale)
						.accessibilityHint("Makes the image larger around its center.")
						.accessibilityIdentifier("image-viewer-zoom-in")

					Button("Reset zoom", systemImage: "arrow.counterclockwise", action: resetZoom)
						.disabled(isImageLoaded == false || ZoomableImageInteraction.isZoomed(zoomScale) == false)
						.accessibilityHint("Returns the image to its fitted size.")
						.accessibilityIdentifier("image-viewer-reset-zoom")
				}
			}
			.toolbarBackground(.black, for: .navigationBar)
			.toolbarColorScheme(.dark, for: .navigationBar)
			.tint(.white)
			.background(.black)
			.presentationBackground(.black)
			.presentationDragIndicator(.visible)
			.presentationContentInteraction(
				ZoomableImageInteraction.canPanImage(at: zoomScale) ? .scrolls : .resizes,
			)
			.interactiveDismissDisabled(ZoomableImageInteraction.canDismissSheet(at: zoomScale) == false)
			.accessibilityElement(children: .contain)
			.accessibilityIdentifier("image-viewer")
			.task(id: url) {
				await loader.loadIfNeeded()
			}
		}
	}

	@ViewBuilder
	private var imageContent: some View {
		switch loader.state {
		case .loading:
			ProgressView("Loading article image")
				.tint(.white)
				.foregroundStyle(.white)
				.accessibilityLabel("Loading article image")
				.accessibilityIdentifier("image-viewer-loading")
		case .loaded(let image):
			ZoomableImageScrollView(
				image: image,
				zoomScale: $zoomScale,
				reduceMotion: reduceMotion,
				onDismiss: dismiss.callAsFunction,
			)
			.frame(maxWidth: .infinity, maxHeight: .infinity)
			.accessibilityElement()
			.accessibilityIdentifier("image-viewer-image")
			.accessibilityLabel("Article image")
			.accessibilityHint("Double-tap to zoom. Use two fingers to pan. With VoiceOver, swipe up or down to adjust zoom.")
			.accessibilityAddTraits(.isImage)
			.accessibilityAdjustableAction { direction in
				switch direction {
				case .increment:
					zoomIn()
				case .decrement:
					zoomOut()
				@unknown default:
					break
				}
			}
			.accessibilityAction(named: "Reset zoom") {
				resetZoom()
			}
		case .failed:
			ContentUnavailableView(
				"Image unavailable",
				systemImage: "photo.badge.exclamationmark",
				description: Text("This image could not be loaded."),
			)
			.foregroundStyle(.white)
			.accessibilityLabel("Article image unavailable")
			.accessibilityHint("Close the viewer and try opening the image again later.")
			.accessibilityIdentifier("image-viewer-unavailable")
		}
	}

	private var isImageLoaded: Bool {
		if case .loaded = loader.state {
			true
		} else {
			false
		}
	}

	private func zoomIn() {
		zoomScale = ZoomableImageInteraction.accessibilityIncrement(from: zoomScale)
	}

	private func zoomOut() {
		zoomScale = ZoomableImageInteraction.accessibilityDecrement(from: zoomScale)
	}

	private func resetZoom() {
		zoomScale = ZoomableImageInteraction.minimumZoomScale
	}
}
