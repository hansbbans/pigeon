import Foundation
import Testing
@testable import PigeonReader

@MainActor
struct ReadwiseSaveCoordinatorTests {
	@Test
	func duplicateSavesForTheSameURLShareOneInFlightRequest() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled, token: "test-token")
		let destination = try makeDestination()

		let firstSave = Task { try await model.saveToReader(destination) }
		let request = await controlled.nextRequest()
		let duplicateSave = Task { try await model.saveToReader(destination) }

		#expect(try await duplicateSave.value == .alreadyInFlight)
		await controlled.resolve(request, statusCode: 201)
		#expect(try await firstSave.value == .saved)
		#expect(await controlled.requestCount() == 1)
	}

	@Test
	func cancellationDoesNotSurfaceAndReleasesTheInFlightURL() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled, token: "test-token")
		let destination = try makeDestination()

		let canceledSave = Task { try await model.saveToReader(destination) }
		let request = await controlled.nextRequest()
		canceledSave.cancel()
		await controlled.resolve(request, statusCode: 201)

		do {
			_ = try await canceledSave.value
			Issue.record("Expected cancellation to be propagated to the caller")
		} catch is CancellationError {
			// Cancellation is intentionally not turned into user-facing failure.
		}

		let retry = Task { try await model.saveToReader(destination) }
		let retryRequest = await controlled.nextRequest()
		await controlled.resolve(retryRequest, statusCode: 200)
		#expect(try await retry.value == .saved)
	}

	@Test
	func tokenCanBeSavedUpdatedAndRemovedThroughTheModel() throws {
		let tokenStore = TestReadwiseTokenStore()
		let model = try makeModel(httpClient: MockHTTPClient(), tokenStore: tokenStore)

		#expect(model.hasReadwiseToken == false)
		try model.saveReadwiseToken("first-token")
		#expect(model.hasReadwiseToken)
		#expect(tokenStore.token == "first-token")
		try model.saveReadwiseToken("second-token")
		#expect(tokenStore.token == "second-token")
		try model.removeReadwiseToken()
		#expect(model.hasReadwiseToken == false)
		#expect(tokenStore.token == nil)
	}

	private func makeModel(
		httpClient: any HTTPClient,
		token: String? = nil,
		tokenStore: TestReadwiseTokenStore? = nil
	) throws -> ReaderAppModel {
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let session = PigeonSession(baseURL: baseURL, token: "server-token")
		let isolatedDefaults = try #require(UserDefaults(suiteName: "pigeon-article-filter-\(UUID().uuidString)"))
		return ReaderAppModel(
			sessionStore: TestSessionStore(session: session),
			httpClient: httpClient,
			readwiseTokenStore: tokenStore ?? TestReadwiseTokenStore(token: token),
			articleFilterStore: ReaderArticleFilterStore(defaults: isolatedDefaults),
			offlineStore: OfflineLibraryStore.inMemory(),
		)
	}

	private func makeDestination() throws -> OutboundDestination {
		let url = try #require(URL(string: "https://example.com/article"))
		return try #require(OutboundDestination(url: url))
	}
}
