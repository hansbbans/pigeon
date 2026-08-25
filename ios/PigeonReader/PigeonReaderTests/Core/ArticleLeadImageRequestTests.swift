import Foundation
import Testing
@testable import PigeonReader

struct ArticleLeadImageRequestTests {
	@Test
	func privacyProxyShowsAReaderViewLeadThatIsNotInTheBody() {
		let session = PigeonSession(
			baseURL: URL(string: "https://pigeon.test")!,
			token: "server-token",
		)

		#expect(ArticleLeadImageRequest.shouldShowFallback(policy: .normal, session: nil))
		#expect(ArticleLeadImageRequest.shouldShowFallback(policy: .privacyProxied, session: session))
		#expect(ArticleLeadImageRequest.shouldShowFallback(policy: .privacyProxied, session: nil) == false)
		#expect(ArticleLeadImageRequest.shouldShowFallback(policy: .blocked, session: session) == false)
	}

	@Test
	func privacyProxyLoadsTheLeadThroughTheAuthenticatedImageProxy() throws {
		let publisher = try #require(URL(string: "https://cdn.publisher.example/hero.jpg"))
		let session = PigeonSession(
			baseURL: try #require(URL(string: "https://pigeon.test")),
			token: "server-token",
		)

		let proxied = try #require(
			ArticleLeadImageRequest.loadRequest(
				for: publisher,
				policy: .privacyProxied,
				session: session,
			),
		)
		let proxiedURL = try #require(proxied.url)
		let components = try #require(URLComponents(url: proxiedURL, resolvingAgainstBaseURL: false))
		#expect(components.host == "pigeon.test")
		#expect(components.path == "/api/v1/image-proxy")
		#expect(components.queryItems?.first(where: { $0.name == "url" })?.value == publisher.absoluteString)
		#expect(proxied.value(forHTTPHeaderField: "Authorization") == "GoogleLogin auth=pigeon/server-token")
		#expect(components.host != publisher.host)

		let direct = try #require(
			ArticleLeadImageRequest.loadRequest(
				for: publisher,
				policy: .normal,
				session: nil,
			),
		)
		#expect(direct.url == publisher)
		#expect(direct.value(forHTTPHeaderField: "Authorization") == nil)

		#expect(
			ArticleLeadImageRequest.loadRequest(
				for: publisher,
				policy: .privacyProxied,
				session: nil,
			) == nil
		)
		#expect(
			ArticleLeadImageRequest.loadRequest(
				for: publisher,
				policy: .blocked,
				session: session,
			) == nil
		)
	}

	@Test
	func rejectsNonWebLeadURLsInsteadOfFetchingThem() throws {
		let session = PigeonSession(
			baseURL: try #require(URL(string: "https://pigeon.test")),
			token: "server-token",
		)
		let javascript = try #require(URL(string: "javascript:alert(1)"))
		let file = try #require(URL(string: "file:///tmp/hero.jpg"))

		#expect(
			ArticleLeadImageRequest.loadRequest(
				for: javascript,
				policy: .privacyProxied,
				session: session,
			) == nil
		)
		#expect(
			ArticleLeadImageRequest.loadRequest(
				for: file,
				policy: .normal,
				session: nil,
			) == nil
		)
	}

	@Test
	func stillUsesTheExistingLeadOnlyWhenTheBodyHasNoUsableImage() throws {
		let lead = try #require(URL(string: "https://cdn.example.com/lead.jpg"))
		let body = try #require(URL(string: "https://cdn.example.com/body.jpg"))

		#expect(
			ArticleImagePolicy.fallbackLeadImageURL(
				bodyImageURLs: [],
				leadImageURL: lead,
				failedImageURLs: [],
			) == lead
		)
		#expect(
			ArticleImagePolicy.fallbackLeadImageURL(
				bodyImageURLs: [body],
				leadImageURL: lead,
				failedImageURLs: [],
			) == nil
		)
	}
}
