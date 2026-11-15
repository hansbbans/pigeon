import Foundation
import Testing
@testable import PigeonReader

struct ImpressionTrackerTests {
	// Offsets below are multiples of 1/8 s so date arithmetic stays exact.
	private let start = Date(timeIntervalSince1970: 1_794_733_200)

	private func item(_ id: String, _ position: Int) -> ImpressionTracker.VisibleItem {
		ImpressionTracker.VisibleItem(itemId: id, position: position)
	}

	private func at(_ seconds: TimeInterval) -> Date {
		start.addingTimeInterval(seconds)
	}

	@Test func anArticleQualifiesAfterOneContinuousSecond() {
		var tracker = ImpressionTracker()
		tracker.beginSession(id: "session-1")
		let rows = [item("a", 0), item("b", 1)]

		#expect(tracker.update(visible: rows, at: at(0)).isEmpty)
		#expect(tracker.update(visible: rows, at: at(0.5)).isEmpty)
		#expect(tracker.nextQualificationDate == at(1))
		let shown = tracker.update(visible: rows, at: at(1))

		#expect(shown == [
			ImpressionTracker.Impression(itemId: "a", position: 0, sessionId: "session-1", occurredAt: at(1)),
			ImpressionTracker.Impression(itemId: "b", position: 1, sessionId: "session-1", occurredAt: at(1)),
		])
		#expect(tracker.nextQualificationDate == nil)
	}

	@Test func leavingBeforeOneSecondRestartsTheTimerOnReentry() {
		var tracker = ImpressionTracker()
		tracker.beginSession(id: "session-1")

		#expect(tracker.update(visible: [item("a", 0)], at: at(0)).isEmpty)
		#expect(tracker.update(visible: [], at: at(0.75)).isEmpty)
		#expect(tracker.update(visible: [item("a", 0)], at: at(0.875)).isEmpty)
		// 1.5 s after it was first seen, but well under a second since it came back.
		#expect(tracker.update(visible: [item("a", 0)], at: at(1.5)).isEmpty)
		let shown = tracker.update(visible: [item("a", 0)], at: at(1.875))

		#expect(shown.map(\.itemId) == ["a"])
		#expect(shown.first?.occurredAt == at(1.875))
	}

	@Test func anArticleIsLoggedOncePerSession() {
		var tracker = ImpressionTracker()
		tracker.beginSession(id: "session-1")
		_ = tracker.update(visible: [item("a", 0)], at: at(0))
		#expect(tracker.update(visible: [item("a", 0)], at: at(1)).count == 1)

		#expect(tracker.update(visible: [item("a", 0)], at: at(5)).isEmpty)
		#expect(tracker.update(visible: [], at: at(6)).isEmpty)
		#expect(tracker.update(visible: [item("a", 0)], at: at(7)).isEmpty)
		#expect(tracker.update(visible: [item("a", 0)], at: at(9)).isEmpty)
		#expect(tracker.nextQualificationDate == nil)
	}

	@Test func aNewSessionLogsTheSameArticleAgain() {
		var tracker = ImpressionTracker()
		tracker.beginSession(id: "session-1")
		_ = tracker.update(visible: [item("a", 0)], at: at(0))
		#expect(tracker.update(visible: [item("a", 0)], at: at(1)).first?.sessionId == "session-1")

		tracker.beginSession(id: "session-2")
		// The new session starts its own timer even though the row never left.
		#expect(tracker.update(visible: [item("a", 2)], at: at(1.25)).isEmpty)
		let shown = tracker.update(visible: [item("a", 2)], at: at(2.25))

		#expect(shown == [
			ImpressionTracker.Impression(itemId: "a", position: 2, sessionId: "session-2", occurredAt: at(2.25)),
		])
	}

	@Test func pausedTimeDoesNotCount() {
		var tracker = ImpressionTracker()
		tracker.beginSession(id: "session-1")
		_ = tracker.update(visible: [item("a", 0)], at: at(0))

		#expect(tracker.pause(at: at(0.5)).isEmpty)
		#expect(tracker.nextQualificationDate == nil)
		#expect(tracker.collect(at: at(30)).isEmpty)
		tracker.resume(at: at(60))

		// 0.5 s before the pause plus 0.25 s after it is still under a second.
		#expect(tracker.update(visible: [item("a", 0)], at: at(60.25)).isEmpty)
		#expect(tracker.nextQualificationDate == at(60.5))
		let shown = tracker.update(visible: [item("a", 0)], at: at(60.5))
		#expect(shown.map(\.itemId) == ["a"])
		#expect(shown.first?.occurredAt == at(60.5))
	}

	@Test func pausingCollectsWhatAlreadyQualified() {
		var tracker = ImpressionTracker()
		tracker.beginSession(id: "session-1")
		_ = tracker.update(visible: [item("a", 0), item("b", 1)], at: at(0))
		_ = tracker.update(visible: [item("a", 0)], at: at(0.5))

		let shown = tracker.pause(at: at(1.25))

		#expect(shown == [
			ImpressionTracker.Impression(itemId: "a", position: 0, sessionId: "session-1", occurredAt: at(1)),
		])
		tracker.resume(at: at(10))
		#expect(tracker.update(visible: [item("a", 0)], at: at(20)).isEmpty)
	}

	@Test func rowsThatAppearWhilePausedStartCountingOnResume() {
		var tracker = ImpressionTracker()
		tracker.beginSession(id: "session-1")
		_ = tracker.update(visible: [item("a", 0)], at: at(0))
		_ = tracker.pause(at: at(0.5))

		// The list changed underneath the reader: "a" left, "b" took its place.
		#expect(tracker.update(visible: [item("b", 0)], at: at(5)).isEmpty)
		#expect(tracker.update(visible: [item("b", 0), item("c", 1)], at: at(6)).isEmpty)
		tracker.resume(at: at(10))

		#expect(tracker.collect(at: at(10.875)).isEmpty)
		#expect(tracker.collect(at: at(11)).map(\.itemId) == ["b", "c"])
		#expect(tracker.update(visible: [item("a", 2), item("b", 0), item("c", 1)], at: at(11.5)).isEmpty)
		#expect(tracker.collect(at: at(12.5)).map(\.itemId) == ["a"])
	}

	@Test func theLatestPositionIsTheOneLogged() {
		var tracker = ImpressionTracker()
		tracker.beginSession(id: "session-1")
		_ = tracker.update(visible: [item("a", 3)], at: at(0))

		let shown = tracker.update(visible: [item("a", 2)], at: at(1))

		#expect(shown.first?.position == 2)
	}

	@Test func endingASessionCollectsAndThenForgetsEverything() {
		var tracker = ImpressionTracker()
		#expect(tracker.update(visible: [item("a", 0)], at: at(0)).isEmpty)
		#expect(tracker.collect(at: at(5)).isEmpty)

		tracker.beginSession(id: "session-1")
		_ = tracker.update(visible: [item("a", 0), item("b", 1)], at: at(10))
		_ = tracker.update(visible: [item("a", 0), item("b", 1), item("c", 2)], at: at(10.5))
		let shown = tracker.endSession(at: at(11.25))

		#expect(shown.map(\.itemId) == ["a", "b"])
		#expect(tracker.sessionId == nil)
		#expect(tracker.update(visible: [item("c", 2)], at: at(20)).isEmpty)
		#expect(tracker.nextQualificationDate == nil)
	}
}
