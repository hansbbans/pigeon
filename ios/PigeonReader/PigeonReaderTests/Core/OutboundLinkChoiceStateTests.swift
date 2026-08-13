import Foundation
import Testing
@testable import PigeonReader

struct OutboundLinkChoiceStateTests {
	@Test func routesToBrowserAndClearsItsPendingDestination() throws {
		let url = try #require(URL(string: "https://example.com/story"))
		let destination = try #require(OutboundDestination(url: url))
		var state = OutboundLinkChoiceState()

		#expect(state.accept(url) == destination)
		#expect(state.pendingDestination == destination)
		#expect(state.isDialogPresented)
		#expect(state.choose(.openInBrowser) == .openInBrowser(destination))
		#expect(state.pendingDestination == nil)
		#expect(state.isDialogPresented == false)
		#expect(state.choose(.shareToReader) == nil)
	}

	@Test func routesToReaderShareWithoutASecondAcceptance() throws {
		let firstURL = try #require(URL(string: "https://example.com/first"))
		let secondURL = try #require(URL(string: "https://example.com/second"))
		let firstDestination = try #require(OutboundDestination(url: firstURL))
		var state = OutboundLinkChoiceState()

		#expect(state.accept(firstURL) == firstDestination)
		#expect(state.accept(secondURL) == nil)
		#expect(state.choose(.shareToReader) == .shareToReader(firstDestination))
		#expect(state.pendingDestination == nil)
	}

	@Test(arguments: ["javascript:alert(1)", "mailto:reader@example.com", "ftp://example.com/story"])
	func rejectsNonHTTPURLs(_ rawURL: String) throws {
		let url = try #require(URL(string: rawURL))
		var state = OutboundLinkChoiceState()

		#expect(state.accept(url) == nil)
		#expect(state.pendingDestination == nil)
		#expect(state.isDialogPresented == false)
	}

	@Test func acceptedURLCanBeRecordedExactlyOnceBeforeChoosingABrowserRoute() throws {
		let url = try #require(URL(string: "https://example.com/story?source=feed"))
		let destination = try #require(OutboundDestination(url: url))
		var state = OutboundLinkChoiceState()
		var recordingCount = 0

		if let accepted = state.accept(url) {
			recordingCount += 1
			#expect(accepted.url == destination.url)
		}
		#expect(state.accept(url) == nil)
		#expect(recordingCount == 1)
		#expect(state.choose(.openInBrowser) == .openInBrowser(destination))
	}
}
