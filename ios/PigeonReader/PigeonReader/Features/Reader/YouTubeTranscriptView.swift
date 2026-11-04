import SwiftUI

/// The YouTube player with its transcript underneath. The transcript follows
/// the player: the playing line is highlighted and kept in view, and tapping
/// a line or chapter seeks the video.
struct YouTubeVideoSection: View {
	let article: Recommendation
	let video: YouTubeVideo
	let playbackAllowed: Bool
	let textScale: Double
	let onOpenYouTube: () -> Void
	let onOpenLink: (URL) -> Void

	@State private var playback = YouTubePlaybackLink()

	var body: some View {
		VStack(alignment: .leading, spacing: 18) {
			YouTubePlayerView(
				video: video,
				playbackAllowed: playbackAllowed,
				playback: playback,
				onOpenYouTube: onOpenYouTube,
				onOpenLink: onOpenLink,
			)
			YouTubeTranscriptSection(article: article, video: video, playback: playback, textScale: textScale)
		}
	}
}

/// The button, its progress, its failure, or the transcript itself.
struct YouTubeTranscriptSection: View {
	let article: Recommendation
	let video: YouTubeVideo
	let playback: YouTubePlaybackLink?
	let textScale: Double

	@Environment(ReaderAppModel.self) private var model

	private var key: String { YouTubeTranscriptStore.key(for: article) }

	var body: some View {
		let transcripts = model.transcripts
		let phase = transcripts.phase(for: article)
		Group {
			switch phase {
			case .idle:
				Button("Get Transcript", systemImage: "text.quote") {
					transcripts.request(article, video: video)
				}
				.buttonStyle(.bordered)
				.accessibilityHint("Fetches the video's captions from YouTube")
				.accessibilityIdentifier("transcript-get")
			case .checking, .fetching:
				HStack(spacing: 10) {
					ProgressView()
					Text(phase == .fetching ? "Getting the transcript from YouTube…" : "Loading the transcript…")
						.foregroundStyle(.secondary)
				}
				.accessibilityElement(children: .combine)
				.accessibilityIdentifier("transcript-loading")
			case .failed(let message):
				VStack(alignment: .leading, spacing: 10) {
					VStack(alignment: .leading, spacing: 4) {
						Label("Couldn’t get the transcript", systemImage: "exclamationmark.triangle")
							.font(.headline)
						Text(message)
							.foregroundStyle(.secondary)
					}
					.accessibilityElement(children: .combine)
					.accessibilityIdentifier("transcript-failed")
					Button("Try Again", systemImage: "arrow.clockwise") {
						transcripts.request(article, video: video)
					}
					.buttonStyle(.bordered)
					.accessibilityIdentifier("transcript-try-again")
				}
			case .ready(let transcript):
				YouTubeTranscriptList(transcript: transcript, playback: playback, textScale: textScale)
					.id(key)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		// Re-runs if the store forgot this item, so a known transcript never
		// sits on "Loading" without a request behind it.
		.task(id: TranscriptOpenID(key: key, isUnknown: transcripts.phases[key] == nil)) {
			transcripts.open(article)
		}
	}
}

private struct TranscriptOpenID: Hashable {
	let key: String
	let isUnknown: Bool
}

/// The transcript in a box of its own, so the article keeps scrolling past it.
struct YouTubeTranscriptList: View {
	let transcript: YouTubeTranscript
	let playback: YouTubePlaybackLink?
	let textScale: Double

	@State private var follow: YouTubeTranscriptFollowState
	@ScaledMetric(relativeTo: .body) private var boxHeight = 340
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	private let rows: [Row]

	init(transcript: YouTubeTranscript, playback: YouTubePlaybackLink?, textScale: Double) {
		self.transcript = transcript
		self.playback = playback
		self.textScale = textScale
		_follow = State(initialValue: YouTubeTranscriptFollowState(transcript: transcript))
		rows = Row.rows(for: transcript)
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			Text("Transcript")
				.font(.custom("Bookerly-Bold", size: ReaderTypography.scaledPointSize(20, textScale: textScale), relativeTo: .title3))
				.accessibilityAddTraits(.isHeader)
			ScrollViewReader { proxy in
				ScrollView {
					LazyVStack(alignment: .leading, spacing: 2) {
						ForEach(rows) { row in
							rowView(row)
						}
					}
					.padding(.vertical, 6)
				}
				.frame(height: min(boxHeight, 560))
				.scrollIndicators(.visible)
				.accessibilityIdentifier("transcript-list")
				.onScrollPhaseChange { oldPhase, newPhase in
					// Any scroll that is not our own pauses auto-scroll; the pause
					// counts from when the reader lets go.
					if Self.isReaderScroll(newPhase) || (Self.isReaderScroll(oldPhase) && newPhase == .idle) {
						follow.userScrolled(now: .now)
					}
				}
				.background {
					PlaybackTimeObserver(playback: playback) { time in
						follow(time: time, proxy: proxy)
					}
				}
			}
			.overlay(alignment: .top) { Divider() }
			.overlay(alignment: .bottom) { Divider() }
		}
	}

	@ViewBuilder
	private func rowView(_ row: Row) -> some View {
		switch row.kind {
		case .chapter(let chapter):
			Button {
				seek(to: chapter.start)
			} label: {
				HStack(alignment: .firstTextBaseline, spacing: 12) {
					Text(YouTubeTranscriptTime.format(chapter.start))
						.font(.footnote.monospacedDigit())
						.foregroundStyle(.secondary)
						.frame(minWidth: 44, alignment: .leading)
					Text(chapter.title)
						.font(.custom("Bookerly-Bold", size: ReaderTypography.scaledPointSize(17, textScale: textScale), relativeTo: .headline))
						.frame(maxWidth: .infinity, alignment: .leading)
				}
				.padding(.horizontal, 10)
				.padding(.top, 14)
				.padding(.bottom, 4)
				.contentShape(.rect)
			}
			.buttonStyle(.plain)
			.accessibilityElement(children: .ignore)
			.accessibilityLabel("Chapter: \(chapter.title), \(YouTubeTranscriptTime.spoken(chapter.start))")
			.accessibilityHint("Plays the chapter")
			.accessibilityAddTraits([.isHeader, .isButton])
			.id(row.id)
		case .segment(let index, let segment):
			let isActive = follow.activeIndex == index
			Button {
				seek(to: segment.start)
			} label: {
				HStack(alignment: .firstTextBaseline, spacing: 12) {
					Text(YouTubeTranscriptTime.format(segment.start))
						.font(.footnote.monospacedDigit())
						.foregroundStyle(isActive ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
						.frame(minWidth: 44, alignment: .leading)
					Text(segment.text)
						.font(.custom("Bookerly-Regular", size: ReaderTypography.scaledPointSize(16, textScale: textScale), relativeTo: .body))
						.foregroundStyle(isActive ? .primary : .secondary)
						.multilineTextAlignment(.leading)
						.frame(maxWidth: .infinity, alignment: .leading)
				}
				.padding(.vertical, 7)
				.padding(.horizontal, 10)
				.background {
					if isActive {
						RoundedRectangle(cornerRadius: 8).fill(.tint.opacity(0.12))
					}
				}
				.contentShape(.rect)
			}
			.buttonStyle(.plain)
			.accessibilityElement(children: .ignore)
			.accessibilityLabel("\(YouTubeTranscriptTime.spoken(segment.start)), \(segment.text)")
			.accessibilityHint("Plays the video from here")
			.accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
			.accessibilityIdentifier("transcript-segment-\(index)")
			.id(row.id)
		}
	}

	private func seek(to time: Double) {
		guard let time = follow.seek(to: time, now: .now) else { return }
		playback?.seek(to: time)
	}

	private func follow(time: Double, proxy: ScrollViewProxy) {
		guard case .scroll(let index) = follow.update(time: time, now: .now) else { return }
		let anchor = UnitPoint(x: 0.5, y: 1.0 / 3.0)
		if reduceMotion {
			proxy.scrollTo(Row.segmentID(index), anchor: anchor)
		} else {
			withAnimation(.easeInOut(duration: 0.3)) {
				proxy.scrollTo(Row.segmentID(index), anchor: anchor)
			}
		}
	}

	private static func isReaderScroll(_ phase: ScrollPhase) -> Bool {
		phase == .tracking || phase == .interacting || phase == .decelerating
	}

	struct Row: Identifiable {
		enum Kind {
			case chapter(YouTubeTranscript.Chapter)
			case segment(Int, YouTubeTranscript.Segment)
		}

		let id: String
		let kind: Kind

		static func segmentID(_ index: Int) -> String { "s\(index)" }

		/// Segments in order, each chapter just before the first segment at or
		/// after its start (as the web view lays them out).
		static func rows(for transcript: YouTubeTranscript) -> [Row] {
			let chapters = transcript.sortedChapters
			var rows: [Row] = []
			rows.reserveCapacity(transcript.segments.count + chapters.count)
			var chapterIndex = 0
			for (index, segment) in transcript.segments.enumerated() {
				while chapterIndex < chapters.count, chapters[chapterIndex].start <= segment.start {
					rows.append(Row(id: "c\(chapterIndex)", kind: .chapter(chapters[chapterIndex])))
					chapterIndex += 1
				}
				rows.append(Row(id: segmentID(index), kind: .segment(index, segment)))
			}
			return rows
		}
	}
}

/// Reads the player's time in a view of its own, so only this view (not the
/// whole transcript) re-evaluates a few times a second during playback.
private struct PlaybackTimeObserver: View {
	let playback: YouTubePlaybackLink?
	let onChange: (Double) -> Void

	var body: some View {
		Color.clear
			.accessibilityHidden(true)
			.onChange(of: playback?.currentTime) { _, time in
				if let time { onChange(time) }
			}
	}
}
