import Foundation
import Testing
import UIKit
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
	func zoomableImageCacheIdentitySeparatesAccountsAndPolicies() throws {
		let publisher = try #require(URL(string: "https://cdn.example.com/hero.jpg"))
		let image = try #require(UIImage(systemName: "photo"))
		let firstAccount = PigeonSession(
			baseURL: try #require(URL(string: "https://pigeon.test")),
			token: "first-account-token",
		)
		let secondAccount = PigeonSession(
			baseURL: try #require(URL(string: "https://pigeon.test")),
			token: "second-account-token",
		)

		let normal = ZoomableImageCacheKey(url: publisher, policy: .normal, session: firstAccount)
		let sameScope = ZoomableImageCacheKey(url: publisher, policy: .normal, session: firstAccount)
		let otherAccount = ZoomableImageCacheKey(url: publisher, policy: .normal, session: secondAccount)
		let proxied = ZoomableImageCacheKey(url: publisher, policy: .privacyProxied, session: firstAccount)

		#expect(normal == sameScope)
		#expect(normal != otherAccount)
		#expect(normal != proxied)

		let cache = ZoomableImageMemoryCache(countLimit: 4)
		cache.insert(image, for: normal)
		#expect(cache.image(for: sameScope) === image)
		#expect(cache.image(for: otherAccount) == nil)
		#expect(cache.image(for: proxied) == nil)
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
