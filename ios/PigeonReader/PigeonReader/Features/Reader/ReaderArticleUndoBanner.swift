import SwiftUI

struct ReaderArticleUndoBanner: View {
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	var body: some View {
		Group {
			if let undo = model.articleUndo {
				HStack(spacing: 12) {
					Text(undo.message)
						.font(.subheadline)
						.frame(maxWidth: .infinity, alignment: .leading)
					Button("Undo") {
						Task { await model.undoArticleAction(id: undo.id, animation: reduceMotion ? nil : ReaderMotion.animation(reduceMotion: false)) }
					}
					.font(.subheadline.bold())
					.frame(minHeight: 44)
					.accessibilityHint("Restores this story’s previous state")
					.accessibilityIdentifier("reader-undo-action")
					Button("Dismiss undo", systemImage: "xmark") {
						model.dismissArticleUndo(id: undo.id)
					}
					.labelStyle(.iconOnly)
					.frame(minWidth: 44, minHeight: 44)
				}
				.padding(.leading, 16)
				.padding(.trailing, 4)
				.padding(.vertical, 4)
				.background(.regularMaterial, in: .rect(cornerRadius: 16))
				.padding(.horizontal)
				.padding(.bottom, 8)
				.transition(.opacity)
				.accessibilityElement(children: .contain)
				.accessibilityIdentifier("reader-undo-banner")
			}
		}
		.animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: model.articleUndo?.id)
		.task(id: model.articleUndo?.id) {
			guard let undo = model.articleUndo else { return }
			AccessibilityNotification.Announcement("\(undo.message). Undo available.").post()
			guard voiceOverEnabled == false else { return }
			do {
				try await Task.sleep(for: .seconds(6))
				try Task.checkCancellation()
				guard voiceOverEnabled == false else { return }
				model.dismissArticleUndo(id: undo.id)
			} catch { }
		}
	}
}
