import Foundation
import Testing
@testable import PigeonReader

struct PrivacyProxiedImageRequestTests {
	@Test
	func privacyProxyZoomUsesTheAuthenticatedProxyInsteadOfThePublisher() throws {
		let session = PigeonSession(
			baseURL: try #require(URL(string: "https://pigeon.test")),
			token: "server-token",
		)
		let publisher = try #require(URL(string: "https://cdn.newsletter.example/pixel.gif?subscriber=hans"))

		let request = try #require(
			PrivacyProxiedImageRequest.loadRequest(
				for: publisher,
				policy: .privacyProxied,
				session: session,
			),
		)

		#expect(request.url?.host == "pigeon.test")
		#expect(request.url?.path == "/api/v1/image-proxy")
		#expect(request.url?.query?.contains("url=") == true)
		#expect(request.url?.absoluteString.contains("cdn.newsletter.example") == true)
		#expect(request.value(forHTTPHeaderField: "Authorization") == "GoogleLogin auth=pigeon/server-token")
		#expect(request.url?.host != publisher.host)
	}

	@Test
	func privacyProxyWithoutASessionDoesNotFallBackToThePublisher() throws {
		let publisher = try #require(URL(string: "https://cdn.newsletter.example/hero.jpg"))

		#expect(
			PrivacyProxiedImageRequest.loadRequest(
				for: publisher,
				policy: .privacyProxied,
				session: nil,
			) == nil
		)
	}

	@Test
	func normalAndBlockedZoomStillLoadThePublisherDirectly() throws {
		let session = PigeonSession(
			baseURL: try #require(URL(string: "https://pigeon.test")),
			token: "server-token",
		)
		let publisher = try #require(URL(string: "https://cdn.example.com/hero.jpg"))

		let normal = try #require(
			PrivacyProxiedImageRequest.loadRequest(for: publisher, policy: .normal, session: session),
		)
		let blocked = try #require(
			PrivacyProxiedImageRequest.loadRequest(for: publisher, policy: .blocked, session: session),
		)

		#expect(normal.url == publisher)
		#expect(blocked.url == publisher)
		#expect(normal.value(forHTTPHeaderField: "Authorization") == nil)
	}

	@Test
	func rejectsJavascriptAndSchemeLessImageAddresses() throws {
		let session = PigeonSession(
			baseURL: try #require(URL(string: "https://pigeon.test")),
			token: "server-token",
		)
		let javascript = try #require(URL(string: "javascript:alert(1)"))
		let relative = try #require(URL(string: "/images/hero.jpg"))

		#expect(PrivacyProxiedImageRequest.authorizedRequest(for: javascript, session: session) == nil)
		#expect(PrivacyProxiedImageRequest.authorizedRequest(for: relative, session: session) == nil)
		#expect(
			PrivacyProxiedImageRequest.loadRequest(for: javascript, policy: .normal, session: session) == nil
		)
	}
}
