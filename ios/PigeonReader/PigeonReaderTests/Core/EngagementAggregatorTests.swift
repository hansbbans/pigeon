import Foundation
import Testing
@testable import PigeonReader

struct EngagementAggregatorTests {
	@Test func readingSessionAggregatesDurationAndScrollDepth() throws {
		var aggregator = EngagementAggregator()
		let start = try #require(ISO8601DateFormatter().date(from: "2026-08-09T12:00:00Z"))
		let end = try #require(ISO8601DateFormatter().date(from: "2026-08-09T12:00:15Z"))

		let firstStart = aggregator.resume(itemId: "item-1", at: start)
		let secondStart = aggregator.resume(itemId: "item-1", at: start)
		let depthThreshold = aggregator.updateScrollDepth(itemId: "item-1", depth: 0.65)
		#expect(firstStart)
		#expect(secondStart == false)
		#expect(depthThreshold == 2)

		let activeEvent = aggregator.activeReadingDeltaEvent(itemId: "item-1", at: end)
		let event = try #require(activeEvent)
		#expect(event.type == .activeReading)
		#expect(event.durationSeconds == 15)
		#expect(event.scrollDepth == 0.65)
		#expect(aggregator.finish(itemId: "item-1")?.maximumScrollDepth == 0.65)
	}

	@Test func readingDurationUsesForegroundDeltasAndExcludesPausedTime() throws {
		var aggregator = EngagementAggregator()
		let start = try #require(ISO8601DateFormatter().date(from: "2026-08-09T12:00:00Z"))
		let firstTick = start.addingTimeInterval(15)
		let backgrounded = start.addingTimeInterval(20)
		let resumed = start.addingTimeInterval(120)
		let secondTick = resumed.addingTimeInterval(10)

		let firstResume = aggregator.resume(itemId: "item-1", at: start)
		let firstEvent = aggregator.activeReadingDeltaEvent(itemId: "item-1", at: firstTick)
		#expect(firstResume)
		#expect(firstEvent?.durationSeconds == 15)
		aggregator.pause(itemId: "item-1", at: backgrounded)
		let secondResume = aggregator.resume(itemId: "item-1", at: resumed)
		#expect(secondResume)

		let resumedEventValue = aggregator.activeReadingDeltaEvent(itemId: "item-1", at: secondTick)
		let resumedEvent = try #require(resumedEventValue)
		#expect(resumedEvent.durationSeconds == 15)
	}

	@Test func stoppingReportsTheExactRemainderOnce() throws {
		var aggregator = EngagementAggregator()
		let start = try #require(ISO8601DateFormatter().date(from: "2026-11-15T09:00:00Z"))
		_ = aggregator.resume(itemId: "item-1", at: start)
		_ = aggregator.updateScrollDepth(itemId: "item-1", depth: 0.4)
		#expect(aggregator.activeItemIDs == ["item-1"])
		#expect(aggregator.activeReadingDeltaEvent(itemId: "item-1", at: start.addingTimeInterval(15))?.durationSeconds == 15)

		let stopped = aggregator.stopReading(itemId: "item-1", at: start.addingTimeInterval(25))
		let remainder = try #require(stopped)

		#expect(remainder.type == .activeReading)
		#expect(remainder.durationSeconds == 10)
		#expect(remainder.scrollDepth == 0.4)
		#expect(remainder.occurredAt == start.addingTimeInterval(25))
		#expect(aggregator.activeItemIDs.isEmpty)
		// Stopping again, or polling a stopped session, reports nothing more.
		#expect(aggregator.stopReading(itemId: "item-1", at: start.addingTimeInterval(90)) == nil)
		#expect(aggregator.activeReadingDeltaEvent(itemId: "item-1", at: start.addingTimeInterval(120), minimumDuration: 0)?.durationSeconds == 0)
	}

	@Test func aStopUnderTheMinimumIsKeptForTheNextReport() throws {
		var aggregator = EngagementAggregator()
		let start = try #require(ISO8601DateFormatter().date(from: "2026-11-15T09:00:00Z"))
		_ = aggregator.resume(itemId: "item-1", at: start)

		#expect(aggregator.stopReading(itemId: "item-1", at: start.addingTimeInterval(0.5)) == nil)
		#expect(aggregator.stopReading(itemId: "unknown", at: start) == nil)
		// Resumed a minute later: the minute away is not reading time.
		let resumed = aggregator.resume(itemId: "item-1", at: start.addingTimeInterval(60))
		#expect(resumed)
		let stopped = aggregator.stopReading(itemId: "item-1", at: start.addingTimeInterval(63))

		#expect(stopped?.durationSeconds == 3.5)
	}
}
