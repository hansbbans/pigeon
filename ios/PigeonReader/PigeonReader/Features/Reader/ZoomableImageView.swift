import SwiftUI

struct ZoomableImageView: View {
	let url: URL
	@State private var scale = 1.0
	@State private var magnificationStart = 1.0

	var body: some View {
		NavigationStack {
			ScrollView([.horizontal, .vertical]) {
				AsyncImage(url: url) { phase in
					switch phase {
					case .empty:
						ProgressView("Loading image")
							.frame(minWidth: 240, minHeight: 240)
					case .success(let image):
						image
							.resizable()
							.scaledToFit()
							.scaleEffect(scale)
							.frame(minWidth: 240, minHeight: 240)
					case .failure:
						ContentUnavailableView(
							"Image unavailable",
							 systemImage: "photo.badge.exclamationmark",
							 description: Text("This image could not be loaded."),
						)
						.frame(minWidth: 240, minHeight: 240)
					@unknown default:
						EmptyView()
					}
				}
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
		}
	}
}
