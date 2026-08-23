import Foundation
import Testing
@testable import PigeonReader

struct ArticleListThumbnailRequestTests {
	@Test
	func imageRichPrivacyProxyUsesTheAuthenticatedProxyInsteadOfThePublisher() throws {
		let session = PigeonSession(
			baseURL: try #require(URL(string: "https://pigeon.test")),
			token: "server-token",
		)
		let publisher = try #require(URL(string: "https://cdn.newsletter.example/hero.jpg?subscriber=hans"))

		let request = try #require(
			ArticleListThumbnailRequest.loadRequest(
				for: publisher,
				policy: .privacyProxied,
				session: session,
			),
		)

		#expect(request.url?.host == "pigeon.test")
		#expect(request.url?.path == "/api/v1/image-proxy")
		#expect(request.url?.absoluteString.contains("cdn.newsletter.example") == true)
		#expect(request.value(forHTTPHeaderField: "Authorization") == "GoogleLogin auth=pigeon/server-token")
		#expect(request.url?.host != publisher.host)
	}

	@Test
	func imageRichPrivacyProxyWithoutASessionDoesNotHitThePublisher() throws {
		let publisher = try #require(URL(string: "https://cdn.newsletter.example/hero.jpg"))

		#expect(
			ArticleListThumbnailRequest.loadRequest(
				for: publisher,
				policy: .privacyProxied,
				session: nil,
			) == nil
		)
	}

	@Test
	func imageRichAskBeforeLoadingDoesNotFetchAThumbnail() throws {
		let session = PigeonSession(
			baseURL: try #require(URL(string: "https://pigeon.test")),
			token: "server-token",
		)
		let publisher = try #require(URL(string: "https://cdn.example.com/hero.jpg"))

		#expect(
			ArticleListThumbnailRequest.loadRequest(
				for: publisher,
				policy: .blocked,
				session: session,
			) == nil
		)
	}

	@Test
	func imageRichLoadNormallyStillUsesThePublisherURL() throws {
		let session = PigeonSession(
			baseURL: try #require(URL(string: "https://pigeon.test")),
			token: "server-token",
		)
		let publisher = try #require(URL(string: "https://cdn.example.com/hero.jpg"))
		let request = try #require(
			ArticleListThumbnailRequest.loadRequest(
				for: publisher,
				policy: .normal,
				session: session,
			),
		)

		#expect(request.url == publisher)
		#expect(request.value(forHTTPHeaderField: "Authorization") == nil)
	}

	@Test
	func imageRichThumbnailPicksTheFirstSafeBodyImage() throws {
		let html = """
		<p>Hello</p>
		<img src="javascript:alert(1)">
		<img src="/images/hero.jpg" alt="Hero">
		<img src="https://cdn.example.com/second.jpg">
		"""
		let baseURL = try #require(URL(string: "https://newsletter.example/issue"))

		#expect(
			ArticleListThumbnailRequest.thumbnailURL(in: html, baseURL: baseURL)
				== URL(string: "https://newsletter.example/images/hero.jpg")
		)
	}
}
