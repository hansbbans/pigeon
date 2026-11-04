import Foundation

/// A YouTube transcript in the Worker's format version 1
/// (`docs/superpowers/plans/2026-11-03-read-it-later-05-transcripts.md`).
/// Times are seconds. The web client builds the same document in
/// `src/browser-transcript.ts`.
nonisolated struct YouTubeTranscript: Codable, Equatable, Hashable, Sendable {
	static let formatVersion = 1

	nonisolated struct Segment: Codable, Equatable, Hashable, Sendable {
		var start: Double
		var duration: Double?
		var text: String
	}

	nonisolated struct Chapter: Codable, Equatable, Hashable, Sendable {
		var start: Double
		var title: String
	}

	var version: Int
	var language: String?
	var segments: [Segment]
	var chapters: [Chapter]?

	init(version: Int = Self.formatVersion, language: String? = nil, segments: [Segment], chapters: [Chapter]? = nil) {
		self.version = version
		self.language = language
		self.segments = segments
		self.chapters = chapters
	}

	private enum CodingKeys: String, CodingKey {
		case version, language, segments, chapters
	}

	init(from decoder: Decoder) throws {
		let container = try decoder.container(keyedBy: CodingKeys.self)
		version = try container.decode(Int.self, forKey: .version)
		// A reader skips a version it does not know.
		guard version == Self.formatVersion else {
			throw YouTubeTranscriptFormatError.unsupportedVersion(version)
		}
		language = try container.decodeIfPresent(String.self, forKey: .language)
		segments = try container.decode([Segment].self, forKey: .segments)
		chapters = try container.decodeIfPresent([Chapter].self, forKey: .chapters)
	}

	/// Chapters in time order; empty when the video has none.
	var sortedChapters: [Chapter] {
		(chapters ?? []).sorted { $0.start < $1.start }
	}
}

nonisolated enum YouTubeTranscriptFormatError: Error, Equatable {
	case unsupportedVersion(Int)
}

// MARK: - Defuddle's transcript text

extension YouTubeTranscript {
	/// Defuddle's transcript text (`variables.transcript`) as a transcript
	/// document. That text is `### Chapter` headings and `**M:SS** · text`
	/// lines; a chapter starts at the segment that follows it. Nil when
	/// nothing parses. A port of `parseDefuddleTranscript` in
	/// `src/browser-transcript.ts`; both run `test/fixtures/transcript/defuddle-transcript-vectors.json`.
	nonisolated static func parseDefuddle(_ text: String?, language: String?) -> YouTubeTranscript? {
		guard let text, text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else { return nil }
		let heading = /^#{1,6}\s+(.+)$/
		// ASCII digits only, as in JavaScript (`\d` in Swift matches every Unicode digit).
		let timestamped = /^\*\*([0-9]{1,3}(?::[0-9]{1,2}){1,2})\*\*\s*·\s*(.*)$/
		var segments: [Segment] = []
		var chapters: [Chapter] = []
		var pendingChapters: [String] = []
		// Foundation splits on the UTF-16 "\n", so "\r\n" leaves a "\r" that trimming drops,
		// exactly like JavaScript's split('\n') + trim().
		for rawLine in text.components(separatedBy: "\n") {
			let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
			if line.isEmpty { continue }
			if let match = line.wholeMatch(of: heading) {
				pendingChapters.append(String(match.1).trimmingCharacters(in: .whitespacesAndNewlines))
				continue
			}
			guard let match = line.wholeMatch(of: timestamped) else { continue }
			let parts = match.1.split(separator: ":").compactMap { Double($0) }
			let start = parts.count == 3
				? parts[0] * 3600 + parts[1] * 60 + parts[2]
				: parts[0] * 60 + parts[1]
			let segmentText = String(match.2)
				.replacing(/\s+/, with: " ")
				.trimmingCharacters(in: .whitespacesAndNewlines)
			guard segmentText.isEmpty == false, start.isFinite else { continue }
			for title in pendingChapters {
				chapters.append(Chapter(start: start, title: title))
			}
			pendingChapters = []
			segments.append(Segment(start: start, text: segmentText))
		}
		guard segments.isEmpty == false else { return nil }
		// Stable, like Array.prototype.sort.
		segments = segments.enumerated()
			.sorted { $0.element.start != $1.element.start ? $0.element.start < $1.element.start : $0.offset < $1.offset }
			.map(\.element)
		for index in segments.indices.dropLast() {
			let duration = segments[index + 1].start - segments[index].start
			if duration > 0 {
				segments[index].duration = duration
			}
		}
		let trimmedLanguage = language?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		let code = trimmedLanguage.wholeMatch(of: /[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}/) != nil ? trimmedLanguage : nil
		return YouTubeTranscript(
			language: code,
			segments: segments,
			chapters: chapters.isEmpty ? nil : chapters,
		)
	}
}

// MARK: - Display helpers

nonisolated enum YouTubeTranscriptTime {
	/// M:SS, or H:MM:SS from an hour.
	static func format(_ seconds: Double) -> String {
		let total = seconds.isFinite ? max(0, Int(seconds.rounded(.down))) : 0
		let hours = total / 3600
		let minutes = (total % 3600) / 60
		let remainder = total % 60
		let pad = { (value: Int) in value < 10 ? "0\(value)" : "\(value)" }
		return hours > 0 ? "\(hours):\(pad(minutes)):\(pad(remainder))" : "\(minutes):\(pad(remainder))"
	}

	/// "1 minute 5 seconds" for VoiceOver.
	static func spoken(_ seconds: Double) -> String {
		let total = seconds.isFinite ? max(0, Int(seconds.rounded(.down))) : 0
		let formatter = DateComponentsFormatter()
		formatter.allowedUnits = total >= 3600 ? [.hour, .minute, .second] : [.minute, .second]
		formatter.unitsStyle = .full
		formatter.zeroFormattingBehavior = .dropAll
		return formatter.string(from: TimeInterval(total)) ?? format(seconds)
	}

	/// Index of the segment playing at `time` (the last one starting at or before it).
	static func activeIndex(starts: [Double], time: Double) -> Int? {
		guard time.isFinite else { return nil }
		var low = 0
		var high = starts.count - 1
		var found: Int?
		while low <= high {
			let middle = (low + high) / 2
			if starts[middle] <= time {
				found = middle
				low = middle + 1
			} else {
				high = middle - 1
			}
		}
		return found
	}
}

/// Keeps the transcript in step with the player: which segment is playing,
/// and whether the list may scroll to it. Auto-scroll pauses for
/// `cooldown` after the reader last scrolled the transcript or tapped a line
/// (the Web Clipper behaviour the web view also follows).
nonisolated struct YouTubeTranscriptFollowState: Equatable, Sendable {
	enum Change: Equatable, Sendable {
		case none
		/// A new segment is active; leave the list where the reader put it.
		case highlight(Int?)
		/// A new segment is active and the list should bring it into view.
		case scroll(Int)
	}

	static let defaultCooldown: TimeInterval = 4

	let starts: [Double]
	let cooldown: TimeInterval
	private(set) var activeIndex: Int?
	private(set) var lastUserScroll: Date?

	init(transcript: YouTubeTranscript, cooldown: TimeInterval = Self.defaultCooldown) {
		starts = transcript.segments.map(\.start)
		self.cooldown = cooldown
	}

	func allowsAutoScroll(now: Date) -> Bool {
		guard let lastUserScroll else { return true }
		return now.timeIntervalSince(lastUserScroll) >= cooldown
	}

	mutating func update(time: Double, now: Date) -> Change {
		let index = YouTubeTranscriptTime.activeIndex(starts: starts, time: time)
		guard index != activeIndex else { return .none }
		activeIndex = index
		guard let index else { return .highlight(nil) }
		return allowsAutoScroll(now: now) ? .scroll(index) : .highlight(index)
	}

	/// The reader scrolled the transcript (a drag, a fling, or its end).
	mutating func userScrolled(now: Date) {
		lastUserScroll = now
	}

	/// A tap on a line or chapter. Returns the time to seek to, or nil for a bad
	/// value. Following the tap is the reader's choice, so the row stays put.
	mutating func seek(to time: Double, now: Date) -> Double? {
		guard time.isFinite, time >= 0 else { return nil }
		lastUserScroll = now
		_ = update(time: time, now: now)
		return time
	}
}

// MARK: - API payloads

/// `GET /api/v1/items/:id/transcript`.
nonisolated struct StoredYouTubeTranscript: Decodable, Equatable, Sendable {
	let itemId: String
	let updatedAt: Date?
	let transcript: YouTubeTranscript
}

/// `PUT /api/v1/items/:id/transcript`. `updated` is false when the server
/// already held the identical document.
nonisolated struct YouTubeTranscriptUploadResponse: Decodable, Equatable, Sendable {
	let itemId: String
	let updated: Bool
	var language: String? = nil
	let segmentCount: Int
	let chapterCount: Int
	let bytes: Int
}
