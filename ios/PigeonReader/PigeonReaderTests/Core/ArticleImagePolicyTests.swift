import Foundation
import Testing
@testable import PigeonReader

struct ArticleImagePolicyTests {
	@Test
	func usesLeadOnlyWhenBodyHasNoUsableImageAndNeverDuplicatesIt() throws {
		let lead = try #require(URL(string: "https://cdn.example.com/lead.jpg"))
		let body = try #require(URL(string: "https://cdn.example.com/body.jpg"))

		#expect(ArticleImagePolicy.fallbackLeadImageURL(bodyImageURLs: [], leadImageURL: lead, failedImageURLs: []) == lead)
		#expect(ArticleImagePolicy.fallbackLeadImageURL(bodyImageURLs: [body], leadImageURL: lead, failedImageURLs: []) == nil)
		#expect(ArticleImagePolicy.fallbackLeadImageURL(bodyImageURLs: [body], leadImageURL: lead, failedImageURLs: [body.absoluteString]) == lead)
		#expect(ArticleImagePolicy.fallbackLeadImageURL(bodyImageURLs: [lead], leadImageURL: lead, failedImageURLs: [lead.absoluteString]) == nil)
	}

	@Test
	func treatsAllSrcsetCandidatesAsOneBodyImageWhenTheWebViewReportsFailure() throws {
		let lead = try #require(URL(string: "https://cdn.example.com/lead.jpg"))
		let source = try #require(URL(string: "https://example.com/image-small.jpg"))
		let candidate = try #require(URL(string: "https://cdn.example.com/image-large.jpg"))

		#expect(ArticleImagePolicy.fallbackLeadImageURL(
			bodyImageURLs: [source, candidate],
			leadImageURL: lead,
			failedImageURLs: [source.absoluteString],
		) == nil)
		#expect(ArticleImagePolicy.fallbackLeadImageURL(
			bodyImageURLs: [source, candidate],
			leadImageURL: lead,
			failedImageURLs: [source.absoluteString, candidate.absoluteString],
		) == lead)
	}

	@Test
	func imageRichAskBeforeLoadingDoesNotFetchUntilThatRowIsRequested() throws {
		let publisher = try #require(URL(string: "https://cdn.example.com/hero.jpg"))

		#expect(
			ArticleImagePolicy.listThumbnail(
				policy: .blocked,
				thumbnailURL: publisher,
				didRequestBlockedLoad: false,
			) == .askToLoad
		)
		#expect(
			ArticleImagePolicy.listThumbnail(
				policy: .blocked,
				thumbnailURL: publisher,
				didRequestBlockedLoad: true,
			) == .remote(publisher)
		)
		#expect(
			ArticleImagePolicy.listThumbnail(
				policy: .blocked,
				thumbnailURL: nil,
				didRequestBlockedLoad: true,
			) == .placeholder
		)
	}

	@Test
	func imageRichAskBeforeLoadingIsPerRowAndDoesNotBypassPrivacyProxy() throws {
		let first = try #require(URL(string: "https://cdn.example.com/one.jpg"))
		let second = try #require(URL(string: "https://cdn.example.com/two.jpg"))

		#expect(
			ArticleImagePolicy.listThumbnail(
				policy: .blocked,
				thumbnailURL: first,
				didRequestBlockedLoad: true,
			) == .remote(first)
		)
		#expect(
			ArticleImagePolicy.listThumbnail(
				policy: .blocked,
				thumbnailURL: second,
				didRequestBlockedLoad: false,
			) == .askToLoad
		)
		#expect(
			ArticleImagePolicy.listThumbnail(
				policy: .normal,
				thumbnailURL: first,
				didRequestBlockedLoad: false,
			) == .remote(first)
		)
		#expect(
			ArticleImagePolicy.listThumbnail(
				policy: .privacyProxied,
				thumbnailURL: first,
				didRequestBlockedLoad: false,
			) == .placeholder
		)
		#expect(
			ArticleImagePolicy.listThumbnail(
				policy: .privacyProxied,
				thumbnailURL: first,
				didRequestBlockedLoad: true,
			) == .placeholder
		)
	}

	@Test
	func imageRichAskBeforeLoadingUsesTheFirstSafeBodyImage() throws {
		let html = """
		<p>Hello</p>
		<img src="javascript:alert(1)">
		<img src="/images/hero.jpg" alt="Hero">
		<img src="https://cdn.example.com/second.jpg">
		"""
		let baseURL = try #require(URL(string: "https://newsletter.example/issue"))
		let expected = try #require(URL(string: "https://newsletter.example/images/hero.jpg"))

		#expect(
			ArticleImagePolicy.listThumbnail(
				policy: .blocked,
				html: html,
				baseURL: baseURL,
				didRequestBlockedLoad: false,
			) == .askToLoad
		)
		#expect(
			ArticleImagePolicy.listThumbnail(
				policy: .blocked,
				html: html,
				baseURL: baseURL,
				didRequestBlockedLoad: true,
			) == .remote(expected)
		)
	}
}
