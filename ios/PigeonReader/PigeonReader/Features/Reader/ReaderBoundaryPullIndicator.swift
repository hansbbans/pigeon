import SwiftUI

struct ReaderBoundaryPullIndicator: View {
	let state: ReaderBoundaryPullState
	let preview: ReaderBoundaryPullPreview

	var body: some View {
		VStack(spacing: 6) {
			Image(systemName: symbolName)
				.font(.headline.weight(.semibold))
				.foregroundStyle(state.isArmed ? Color.accentColor : .secondary)

			Text(preview.actionTitle)
				.font(.caption.weight(.semibold))

			if let title = preview.title {
				Text(title)
					.font(.caption)
					.lineLimit(2)
					.multilineTextAlignment(.center)
			}

			Text(statusText)
				.font(.caption2)
				.foregroundStyle(.secondary)

			ProgressView(value: state.progress)
				.progressViewStyle(.linear)
				.frame(width: 96)
				.accessibilityHidden(true)
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 10)
		.background(.regularMaterial, in: .rect(cornerRadius: 14))
		.shadow(color: .black.opacity(0.12), radius: 8, y: 3)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(accessibilityLabel)
		.accessibilityValue(accessibilityValue)
		.accessibilityHint(preview.isReady ? "Pull farther to arm, then release to open" : "No more stories in this direction")
	}

	private var symbolName: String {
		let base = state.direction == .previous ? "chevron.up" : "chevron.down"
		return state.isArmed ? "checkmark.circle.fill" : base
	}

	private var accessibilityLabel: String {
		if let title = preview.title {
			return "\(preview.actionTitle): \(title)"
		}
		return preview.actionTitle
	}

	private var accessibilityValue: String {
		if state.isArmed {
			return "Ready. \(statusText)"
		}
		return "\(Int((state.progress * 100).rounded())) percent. \(statusText)"
	}

	private var statusText: String {
		if state.isArmed, preview.isReady {
			return "Release to open"
		}
		return preview.statusText
	}
}

/// Hosts the stable reader content and the inexpensive live pull overlay.
/// `content` is built once for this view identity, while the controller's
/// observation only invalidates this container as the user's finger moves.
struct ReaderBoundaryPullContainer<Content: View>: View {
	let content: Content
	let controller: ReaderBoundaryPullController
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	init(
		controller: ReaderBoundaryPullController,
		@ViewBuilder content: () -> Content,
	) {
		self.controller = controller
		self.content = content()
	}

	var body: some View {
		ZStack {
			content
				.offset(y: reduceMotion ? 0 : CGFloat(controller.state?.visualDisplacement ?? 0))

			if let state = controller.state, let preview = controller.preview {
				ReaderBoundaryPullIndicator(state: state, preview: preview)
					.frame(
						maxWidth: .infinity,
						maxHeight: .infinity,
						alignment: state.direction == .previous ? .top : .bottom,
					)
					.padding(.horizontal, 12)
					.padding(state.direction == .previous ? .top : .bottom, 10)
					.opacity(state.distance > 0 ? 1 : 0)
					.transition(.opacity)
					.animation(
						ReaderMotion.animation(reduceMotion: reduceMotion),
						value: state.distance > 0,
					)
					.allowsHitTesting(false)
			}
		}
		.animation(
			ReaderMotion.animation(reduceMotion: reduceMotion),
			value: controller.state != nil,
		)
	}
}
