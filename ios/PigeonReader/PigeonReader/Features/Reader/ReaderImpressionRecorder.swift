import Foundation

/// Connects one article list to `ImpressionTracker` and hands qualified
/// impressions to the model. It holds no SwiftUI state, so nothing here can
/// invalidate a view, and it looks at the list at most every
/// `evaluationInterval`, never once per scroll frame.
///
/// Classic rows are measured by `ReaderListViewportController`. Lists that
/// report rows one at a time (Front Page, Read It Later) call `updateRows`
/// and `setRowVisible` instead.
@MainActor
final class ReaderImpressionRecorder {
	/// What the list is showing, as its view computes it on each body pass.
	struct ListState: Equatable {
		/// One continuous showing of one list context. A different key starts
		/// a new list session; nil means the list is off screen.
		let sessionKey: String?
		let list: ReadingLogList
		/// The scene is not active, or the reader covers the list.
		let isPaused: Bool
	}

	static let evaluationInterval: TimeInterval = 0.25

	private var tracker = ImpressionTracker()
	private var state: ListState?
	private weak var model: ReaderAppModel?
	private weak var viewport: ReaderListViewportController?
	private var measuresViewport = false
	/// Row order and half-visible rows of a list that reports single rows.
	private var rowPositions: [String: Int] = [:]
	private var visibleRowIDs: Set<String> = []
	/// Stories a list shows more than once (Cards) are visible while any copy is.
	private var visibleCopies = ReaderVisibleRowCopies()
	/// `ReadingLogMetadata.row` per story, for lists with more than one kind of row.
	private var readingLogRows: [String: String] = [:]
	private var lastEvaluation = Date.distantPast
	private var wakeDate: Date?
	private var wakeTask: Task<Void, Never>?
	private let now: () -> Date

	init(now: @escaping () -> Date = { Date() }) {
		self.now = now
	}

	var sessionId: String? { tracker.sessionId }

	/// Follows the list's state: starts a session when the key changes, stops
	/// the clock while paused, ends the session when the list goes off screen.
	func apply(_ newState: ListState, viewport: ReaderListViewportController? = nil, model: ReaderAppModel) {
		self.model = model
		let date = now()
		let keepsSession = state?.sessionKey == newState.sessionKey
			&& state?.list == newState.list
			&& self.viewport === viewport
		guard keepsSession else {
			finishSession(at: date)
			state = newState
			attach(viewport)
			guard newState.sessionKey != nil else { return }
			tracker.beginSession()
			if newState.isPaused {
				_ = tracker.pause(at: date)
			} else {
				evaluate()
			}
			return
		}
		let wasPaused = state?.isPaused
		state = newState
		guard newState.sessionKey != nil, wasPaused != newState.isPaused else { return }
		if newState.isPaused {
			deliver(tracker.pause(at: date))
			cancelWake()
		} else {
			tracker.resume(at: date)
			evaluate()
		}
	}

	/// The list left the screen. Its next appearance is a new session.
	func endSession() {
		finishSession(at: now())
		state = nil
		attach(nil)
		visibleRowIDs.removeAll(keepingCapacity: true)
		visibleCopies = ReaderVisibleRowCopies()
	}

	/// The displayed order of a list that reports single rows. A story shown
	/// twice is listed once, at its first appearance.
	func updateRows(_ itemIDs: [String], readingLogRows: [String: String] = [:]) {
		self.readingLogRows = readingLogRows
		rowPositions.removeAll(keepingCapacity: true)
		for (position, itemID) in itemIDs.enumerated() where rowPositions[itemID] == nil {
			rowPositions[itemID] = position
		}
		visibleRowIDs = visibleRowIDs.filter { rowPositions[$0] != nil }
		visibleCopies.removeAll { rowPositions[$0] == nil }
		viewportDidChange()
	}

	/// One copy of a story shown more than once crossed the half-visible
	/// threshold; the story counts as visible while any copy is.
	func setRowVisible(_ itemID: String, _ isVisible: Bool, copy: String) {
		guard let visible = visibleCopies.set(itemID, copy: copy, visible: isVisible) else { return }
		setRowVisible(itemID, visible)
	}

	/// A row crossed the half-visible threshold.
	func setRowVisible(_ itemID: String, _ isVisible: Bool) {
		if isVisible {
			guard visibleRowIDs.insert(itemID).inserted else { return }
		} else {
			guard visibleRowIDs.remove(itemID) != nil else { return }
		}
		viewportDidChange()
	}

	/// The reader picked a row. Call before the selection changes, while the
	/// list is still the one on screen.
	func rowChosen(_ itemID: String) {
		guard let position = measuresViewport ? viewport?.position(of: itemID) : rowPositions[itemID],
			let impression = tracker.markChosen(itemId: itemID, position: position, at: now()) else { return }
		deliver([impression])
	}

	/// Something the list shows may have moved. Called for every scroll frame
	/// of a classic list, so the common path is two comparisons.
	func viewportDidChange() {
		guard tracker.sessionId != nil, tracker.isPaused == false else { return }
		let date = now()
		let due = lastEvaluation.addingTimeInterval(Self.evaluationInterval)
		// A clock set backwards must not put the next look far in the future.
		if date >= due || date < lastEvaluation {
			evaluate()
		} else {
			scheduleWake(at: due)
		}
	}

	/// Reads what is at least half visible now, logs what qualified, and wakes
	/// again when the next row would qualify.
	func evaluate() {
		guard tracker.sessionId != nil, tracker.isPaused == false else { return }
		let date = now()
		lastEvaluation = date
		deliver(tracker.update(visible: visibleRows(), at: date))
		if let next = tracker.nextQualificationDate {
			scheduleWake(at: next)
		} else {
			cancelWake()
		}
	}

	private func visibleRows() -> [ImpressionTracker.VisibleItem] {
		if measuresViewport {
			// Unmeasurable (restoring a position, mid-transition): nothing counts.
			return viewport?.halfVisibleRows() ?? []
		}
		return visibleRowIDs.compactMap { itemID in
			rowPositions[itemID].map { ImpressionTracker.VisibleItem(itemId: itemID, position: $0) }
		}
	}

	private func attach(_ newViewport: ReaderListViewportController?) {
		if viewport !== newViewport {
			viewport?.onViewportChange = nil
		}
		viewport = newViewport
		measuresViewport = newViewport != nil
		if measuresViewport {
			// Single-row reports belong to the layout that just went away.
			rowPositions.removeAll(keepingCapacity: true)
			visibleRowIDs.removeAll(keepingCapacity: true)
			visibleCopies = ReaderVisibleRowCopies()
			readingLogRows.removeAll(keepingCapacity: true)
		}
		newViewport?.onViewportChange = { [weak self] in self?.viewportDidChange() }
	}

	private func finishSession(at date: Date) {
		cancelWake()
		guard tracker.sessionId != nil else { return }
		deliver(tracker.endSession(at: date))
		model?.flushReadingLog()
	}

	private func deliver(_ impressions: [ImpressionTracker.Impression]) {
		guard impressions.isEmpty == false, let list = state?.list else { return }
		model?.recordImpressions(impressions, in: list, rows: readingLogRows)
	}

	private func scheduleWake(at date: Date) {
		if let wakeDate, wakeDate <= date { return }
		wakeTask?.cancel()
		wakeDate = date
		// A little slack, so the wake never lands just short of its date.
		let delay = max(0, date.timeIntervalSince(now())) + 0.01
		wakeTask = Task { [weak self] in
			do { try await Task.sleep(for: .seconds(delay)) } catch { return }
			// Cancelled after the sleep ended: a newer wake may be in place.
			guard let self, Task.isCancelled == false else { return }
			self.wakeDate = nil
			self.wakeTask = nil
			self.evaluate()
		}
	}

	private func cancelWake() {
		wakeTask?.cancel()
		wakeTask = nil
		wakeDate = nil
	}
}

/// Which copies of each story are at least half visible, for lists that show
/// a story more than once.
nonisolated struct ReaderVisibleRowCopies: Sendable {
	private var copiesByItemID: [String: Set<String>] = [:]

	/// Records one copy's visibility. Returns the story's visibility when it
	/// changed (its first copy appeared or its last copy left), else nil.
	mutating func set(_ itemID: String, copy: String, visible: Bool) -> Bool? {
		let wasVisible = copiesByItemID[itemID] != nil
		if visible {
			copiesByItemID[itemID, default: []].insert(copy)
		} else if var copies = copiesByItemID[itemID] {
			copies.remove(copy)
			copiesByItemID[itemID] = copies.isEmpty ? nil : copies
		}
		let isVisible = copiesByItemID[itemID] != nil
		return wasVisible == isVisible ? nil : isVisible
	}

	/// Forgets stories the list no longer shows.
	mutating func removeAll(where shouldRemove: (String) -> Bool) {
		copiesByItemID = copiesByItemID.filter { shouldRemove($0.key) == false }
	}
}
