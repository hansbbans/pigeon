#if DEBUG
import Foundation

/// Stands in for YouTube in previews and UI tests: a short fixed transcript
/// with chapters, after a brief delay so the progress state is visible.
/// `-reader-transcript-fail-once` makes the first fetch fail, to exercise
/// the failure state and Try Again.
@MainActor
final class PreviewTranscriptFetcher: YouTubeTranscriptFetching {
	private var remainingFailures: Int

	init(failures: Int = ProcessInfo.processInfo.arguments.contains("-reader-transcript-fail-once") ? 1 : 0) {
		remainingFailures = failures
	}

	func fetchTranscript(videoID: String) async throws -> YouTubeTranscript {
		try await Task.sleep(for: .milliseconds(400))
		if remainingFailures > 0 {
			remainingFailures -= 1
			throw YouTubeTranscriptError.timedOut
		}
		return Self.transcript
	}

	static let transcript = YouTubeTranscript(
		language: "en",
		segments: [
			.init(start: 0, duration: 12, text: "Every video starts with a single frame, and a decision about what belongs in it."),
			.init(start: 12, duration: 15, text: "Light from one side gives a face shape; light from everywhere flattens it."),
			.init(start: 27, duration: 18, text: "Sound matters more than the picture. Viewers forgive a soft image, never muddy audio."),
			.init(start: 45, duration: 20, text: "Cut on movement, so the eye follows the action across the edit."),
			.init(start: 65, text: "And finally, leave room at the end: a held shot lets the story land."),
		],
		chapters: [
			.init(start: 0, title: "Framing"),
			.init(start: 27, title: "Sound and editing"),
		],
	)
}
#endif
