import SwiftUI

struct ScoreBadge: View {
	let score: Int

	var body: some View {
		Text(score, format: .number)
			.font(.caption.monospacedDigit().weight(.semibold))
			.foregroundStyle(scoreColor)
			.padding(.horizontal, 6)
			.padding(.vertical, 2)
			.background(.quaternary, in: .capsule)
			.accessibilityLabel("Predicted interest \(score) out of 100")
	}

	private var scoreColor: Color {
		switch score {
		case 75...: .green
		case 50..<75: .orange
		default: .secondary
		}
	}
}
