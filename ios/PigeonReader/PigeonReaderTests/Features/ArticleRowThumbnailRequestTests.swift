import Foundation
import Testing
@testable import PigeonReader

struct ArticleRowThumbnailRequestTests {
	@Test
	func normalAndTextOnlyRowsLeaveDiscoveryToTheThumbnailPipeline() {
		let html = #"<img src="https://publisher.example/hero.jpg">"#
		let normal = request(html: html, policy: .normal)
		let textOnly = request(html: html, policy: .blocked, isImageRich: false)
		#expect(normal.needsURLSelection == false)
		#expect(normal.selectURL() == nil)
		#expect(textOnly.needsURLSelection == false)
		#expect(textOnly.selectURL() == nil)
	}

	@Test(arguments: [ReaderRemoteImagePolicy.blocked, .privacyProxied])
	func permissionAndProxyRowsSelectOnlySafeImages(policy: ReaderRemoteImagePolicy) throws {
		let request = request(
			html: #"<script><img src="https://unsafe.example/tracker.jpg"></script><img src="javascript:alert(1)"><img data-src="/hero.jpg">"#,
			policy: policy,
		)
		let expected = try #require(URL(string: "https://publisher.example/hero.jpg"))
		#expect(request.selectURL() == expected)
		#expect(ArticleImagePolicy.listThumbnail(policy: policy, thumbnailURL: expected, didRequestBlockedLoad: false)
			== (policy == .blocked ? .askToLoad : .placeholder))
	}

	@Test
	func policyCyclesRevokePermissionAndRejectOutstandingSelections() throws {
		let blocked = request(html: #"<img src="/hero.jpg">"#, policy: .blocked)
		let normal = request(html: blocked.html, policy: .normal)
		let url = try #require(blocked.selectURL())
		var state = ArticleRowThumbnailState()
		let activation1 = state.activate(blocked)
		#expect(activation1)
		state.completeSelection(url, for: blocked)
		state.requestBlockedLoad(for: blocked)
		#expect(state.requestedBlockedLoad(for: blocked))
		// Reappearing with identical input reuses local discovery and permission.
		let activation2 = state.activate(blocked)
		#expect(activation2 == false)
		#expect(state.url(for: blocked) == url)
		let activation3 = state.activate(normal)
		#expect(activation3 == false)
		#expect(state.url(for: blocked) == nil)
		state.completeSelection(url, for: blocked)
		#expect(state.url(for: normal) == nil)
		let activation4 = state.activate(blocked)
		#expect(activation4)
		#expect(state.url(for: blocked) == nil)
		#expect(state.requestedBlockedLoad(for: blocked) == false)
		state.completeSelection(url, for: blocked)
		#expect(state.requestedBlockedLoad(for: blocked) == false)
	}

	@Test
	func textDensityCyclesAndChangedStoriesCannotRetainPublisherPermission() throws {
		let blocked = request(html: #"<img src="/hero.jpg">"#, policy: .blocked)
		let text = request(html: blocked.html, policy: .blocked, isImageRich: false)
		let changed = request(html: #"<img src="/changed.jpg">"#, policy: .blocked)
		let url = try #require(blocked.selectURL())
		var state = ArticleRowThumbnailState()
		let activation5 = state.activate(blocked)
		#expect(activation5)
		state.completeSelection(url, for: blocked)
		state.requestBlockedLoad(for: blocked)
		let activation6 = state.activate(text)
		#expect(activation6 == false)
		let activation7 = state.activate(blocked)
		#expect(activation7)
		#expect(state.requestedBlockedLoad(for: blocked) == false)
		let activation8 = state.activate(changed)
		#expect(activation8)
		state.completeSelection(url, for: blocked)
		#expect(state.url(for: changed) == nil)
		#expect(state.requestedBlockedLoad(for: changed) == false)
	}

	@Test
	func sourceContentAccountAndPermissionChangesInvalidateSelection() {
		let original = request(html: #"<img src="/hero.jpg">"#, policy: .blocked)
		#expect(original != request(html: #"<img src="/new.jpg">"#, policy: .blocked))
		#expect(original != request(html: original.html, policy: .privacyProxied))
		var changed = original
		changed = ArticleRowThumbnailRequest(articleID: "new-story", html: original.html,
			baseURL: original.baseURL, scope: original.scope, policy: original.policy, isImageRich: true)
		#expect(original != changed)
		changed = ArticleRowThumbnailRequest(articleID: original.articleID, html: original.html,
			baseURL: URL(string: "https://another.example/issue"), scope: original.scope, policy: original.policy, isImageRich: true)
		#expect(original != changed)
		changed = ArticleRowThumbnailRequest(articleID: original.articleID, html: original.html,
			baseURL: original.baseURL, scope: "another-account", policy: original.policy, isImageRich: true)
		#expect(original != changed)
	}

	private func request(html: String, policy: ReaderRemoteImagePolicy, isImageRich: Bool = true) -> ArticleRowThumbnailRequest {
		ArticleRowThumbnailRequest(articleID: "story", html: html,
			baseURL: URL(string: "https://publisher.example/issue"), scope: "account", policy: policy, isImageRich: isImageRich)
	}
}
