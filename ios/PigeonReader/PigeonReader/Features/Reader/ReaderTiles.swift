import SwiftUI

// The tile vocabulary shared by Home, the folder cards and All Feeds: one
// ground, one shape, a kicker-colour bar, favicons and the press response.

enum ReaderHomeTileStyle {
	static let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
	static let background = Color(.secondarySystemGroupedBackground)
	static let barHeight = 3.0
}

extension View {
	/// The tile ground, with a bar in `barColor` along the top edge, clipped
	/// to the tile shape.
	func readerTileBackground(barColor: Color?) -> some View {
		background(ReaderHomeTileStyle.background)
			.overlay(alignment: .top) {
				if let barColor {
					Rectangle()
						.fill(barColor)
						.frame(height: ReaderHomeTileStyle.barHeight)
						.accessibilityHidden(true)
				}
			}
			.clipShape(ReaderHomeTileStyle.shape)
	}
}

/// A feed favicon that fades in once loaded, so tiles never pop.
struct ReaderHomeFeedIcon: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	let url: URL

	var body: some View {
		AsyncImage(url: url) { phase in
			ZStack {
				RoundedRectangle(cornerRadius: 4, style: .continuous)
					.fill(.quaternary)
					.opacity(phase.image == nil ? 1 : 0)
				if let image = phase.image {
					image
						.resizable()
						.scaledToFit()
						.clipShape(.rect(cornerRadius: 4, style: .continuous))
						.transition(.opacity)
				}
			}
			.animation(ReaderMotion.contentArrival(reduceMotion: reduceMotion), value: phase.image != nil)
		}
		.frame(width: 18, height: 18)
	}
}

/// Tiles acknowledge touch-down with a slight press before navigation begins.
struct ReaderHomeTileButtonStyle: ButtonStyle {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.contentShape(ReaderHomeTileStyle.shape)
			.opacity(configuration.isPressed ? 0.7 : 1)
			.scaleEffect(configuration.isPressed && reduceMotion == false ? 0.97 : 1)
			.animation(.easeOut(duration: 0.12), value: configuration.isPressed)
	}
}
