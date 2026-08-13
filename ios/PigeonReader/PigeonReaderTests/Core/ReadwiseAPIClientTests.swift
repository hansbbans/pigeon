import Foundation
import Testing
@testable import PigeonReader

@MainActor
struct ReadwiseAPIClientTests {
	@Test(arguments: [200, 201])
	func acceptsSuccessfulSaveStatuses(statusCode: Int) async throws {
		let mock = MockHTTPClient(statusCode: statusCode)
		let tokenStore = TestReadwiseTokenStore(token: "test-token")
		let client = ReadwiseAPIClient(tokenStore: tokenStore, httpClient: mock)
		let url = try #require(URL(string: "https://example.com/article?keep=exact"))

		try await client.save(url: url)

		let request = try #require(await mock.lastRequest())
		#expect(request.url.absoluteString == "https://readwise.io/api/v3/save/")
		#expect(request.method == "POST")
		#expect(request.authorization == "Token test-token")
		#expect(request.accept == "application/json")
		#expect(request.contentType == "application/json")
		let body = try #require(request.body)
		let payload = try JSONDecoder().decode([String: String].self, from: body)
		#expect(payload["url"] == url.absoluteString)
	}

	@Test
	func missingTokenDoesNotMakeARequest() async throws {
		let mock = MockHTTPClient()
		let client = ReadwiseAPIClient(tokenStore: TestReadwiseTokenStore(), httpClient: mock)
		let url = try #require(URL(string: "https://example.com/article"))

		do {
			try await client.save(url: url)
			Issue.record("Expected the missing token to fail")
		} catch let error as ReadwiseSaveError {
			#expect(error == .missingToken)
		}
		#expect(await mock.requests().isEmpty)
	}

	@Test
	func nonSuccessResponseIncludesTheHTTPStatus() async throws {
		let mock = MockHTTPClient(responseData: Data("server failure".utf8), statusCode: 500)
		let client = ReadwiseAPIClient(
			tokenStore: TestReadwiseTokenStore(token: "test-token"),
			httpClient: mock
		)
		let url = try #require(URL(string: "https://example.com/article"))

		do {
			try await client.save(url: url)
			Issue.record("Expected the server response to fail")
		} catch let error as ReadwiseSaveError {
			#expect(error == .server(statusCode: 500))
		}
	}

	@Test
	func unauthorizedResponseRequestsATokenUpdate() async throws {
		let mock = MockHTTPClient(statusCode: 401)
		let client = ReadwiseAPIClient(
			tokenStore: TestReadwiseTokenStore(token: "test-token"),
			httpClient: mock
		)
		let url = try #require(URL(string: "https://example.com/article"))

		do {
			try await client.save(url: url)
			Issue.record("Expected the unauthorized response to fail")
		} catch let error as ReadwiseSaveError {
			#expect(error == .authenticationFailed)
		}
	}

	@Test
	func transportErrorIsActionable() async throws {
		let client = ReadwiseAPIClient(
			tokenStore: TestReadwiseTokenStore(token: "test-token"),
			httpClient: MockHTTPClient(shouldFail: true)
		)
		let url = try #require(URL(string: "https://example.com/article"))

		do {
			try await client.save(url: url)
			Issue.record("Expected the transport error to fail")
		} catch let error as ReadwiseSaveError {
			#expect(error == .network)
		}
	}

}
