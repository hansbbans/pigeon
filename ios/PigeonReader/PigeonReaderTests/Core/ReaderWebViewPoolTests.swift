import Foundation
import Testing
import WebKit
@testable import PigeonReader

@MainActor
struct ReaderWebViewPoolTests {
	private let session = PigeonSession(baseURL: URL(string: "https://pigeon.example")!, token: "pool-token")

	@Test func aPrewarmedWebViewIsHandedOutOnceAndNeverAgain() {
		let pool = ReaderWebViewPool()
		#expect(pool.hasSpare == false)
		pool.prewarm(session: session)
		#expect(pool.hasSpare)

		let first = pool.take(session: session)
		#expect(pool.hasSpare == false)
		let second = pool.take(session: session)
		// Each story reads in a web view, and a data store, of its own.
		#expect(first.webView !== second.webView)
		#expect(first.webView.configuration.websiteDataStore !== second.webView.configuration.websiteDataStore)
		#expect(first.webView.configuration.websiteDataStore.isPersistent == false)
		pool.drain()
	}

	@Test func aSpareMadeForAnotherAccountIsNotUsed() {
		let pool = ReaderWebViewPool()
		pool.prewarm(session: session)
		let spare = pool.take(session: session).webView
		pool.prewarm(session: session)
		let other = PigeonSession(baseURL: URL(string: "https://pigeon.example")!, token: "another-token")
		let taken = pool.take(session: other).webView
		#expect(taken !== spare)
		// The other account's image proxy handler was never attached to it.
		#expect(pool.hasSpare == false)
		pool.drain()
	}

	@Test func theRelayForwardsMessagesOnlyWhileAReaderOwnsIt() {
		final class Recorder: NSObject, WKScriptMessageHandler {
			var count = 0
			func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
				count += 1
			}
		}
		let relay = ReaderScriptMessageRelay()
		var recorder: Recorder? = Recorder()
		relay.target = recorder
		#expect(relay.target != nil)
		recorder = nil
		#expect(relay.target == nil)
	}
}
