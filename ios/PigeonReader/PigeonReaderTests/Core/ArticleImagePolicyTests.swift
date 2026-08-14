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
}
