import Foundation
import Testing
@testable import PigeonReader

/// Fakes the Pigeon server's `/api/v1/readwise/token` endpoint.
private actor ReadwiseTokenServer: HTTPClient {
	struct Recorded: Sendable {
		let method: String
		let path: String
		let body: Data?
	}

	private(set) var token: String?
	private(set) var recorded: [Recorded] = []
	var isOffline = false

	init(token: String? = nil) {
		self.token = token
	}

	func setOffline(_ offline: Bool) {
		isOffline = offline
	}

	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		let url = request.url ?? URL(string: "https://pigeon.test")!
		let method = request.httpMethod ?? "GET"
		recorded.append(Recorded(method: method, path: url.path, body: request.httpBody))
		if isOffline {
			throw URLError(.notConnectedToInternet)
		}
		guard url.path == "/api/v1/readwise/token" else {
			return (Data("Not found".utf8), Self.response(url: url, status: 404))
		}
		guard request.value(forHTTPHeaderField: "Authorization") == "GoogleLogin auth=pigeon/server-token" else {
			return (Data("Unauthorized".utf8), Self.response(url: url, status: 401))
		}
		switch method {
		case "PUT":
			let payload = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
			token = (payload?["token"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
		case "DELETE":
			token = nil
		default:
			break
		}
		let body = try JSONSerialization.data(withJSONObject: ["token": token as Any? ?? NSNull()])
		return (body, Self.response(url: url, status: 200))
	}

	func requests(method: String) -> [Recorded] {
		recorded.filter { $0.method == method && $0.path == "/api/v1/readwise/token" }
	}

	private static func response(url: URL, status: Int) -> HTTPURLResponse {
		HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
	}
}

@MainActor
struct ReadwiseTokenServerSyncTests {
	@Test
	func restoresTheServerTokenWhenKeychainIsEmpty() async throws {
		let server = ReadwiseTokenServer(token: "rw-from-server")
		let store = TestReadwiseTokenStore()
		let model = try makeModel(server: server, store: store)
		#expect(model.hasReadwiseToken == false)

		await model.syncReadwiseTokenWithServer()

		#expect(store.token == "rw-from-server")
		#expect(model.hasReadwiseToken)
		#expect(await server.requests(method: "PUT").isEmpty)
	}

	@Test
	func uploadsTheLocalTokenWhenTheServerHasNone() async throws {
		let server = ReadwiseTokenServer()
		let store = TestReadwiseTokenStore(token: "rw-local")
		let model = try makeModel(server: server, store: store)

		await model.syncReadwiseTokenWithServer()

		#expect(await server.token == "rw-local")
		#expect(store.token == "rw-local")
		#expect(model.hasReadwiseToken)
	}

	@Test
	func leavesBothCopiesAloneWhenTheyAlreadyExist() async throws {
		let server = ReadwiseTokenServer(token: "rw-server")
		let store = TestReadwiseTokenStore(token: "rw-local")
		let model = try makeModel(server: server, store: store)

		await model.syncReadwiseTokenWithServer()

		#expect(await server.token == "rw-server")
		#expect(store.token == "rw-local")
		#expect(await server.requests(method: "PUT").isEmpty)
	}

	@Test
	func reconciliationRunsOncePerSession() async throws {
		let server = ReadwiseTokenServer(token: "rw-server")
		let model = try makeModel(server: server, store: TestReadwiseTokenStore())

		await model.syncReadwiseTokenWithServer()
		await model.syncReadwiseTokenWithServer()

		#expect(await server.requests(method: "GET").count == 1)
	}

	@Test
	func failedReconciliationRetriesLater() async throws {
		let server = ReadwiseTokenServer(token: "rw-server")
		await server.setOffline(true)
		let store = TestReadwiseTokenStore()
		let model = try makeModel(server: server, store: store)

		await model.syncReadwiseTokenWithServer()
		#expect(store.token == nil)

		await server.setOffline(false)
		await model.syncReadwiseTokenWithServer()
		#expect(store.token == "rw-server")
		#expect(model.hasReadwiseToken)
	}

	@Test
	func savingATokenPushesItToTheServer() async throws {
		let server = ReadwiseTokenServer()
		let store = TestReadwiseTokenStore()
		let model = try makeModel(server: server, store: store)

		let backedUp = try await model.saveReadwiseToken("  rw-new  ")

		#expect(backedUp)
		#expect(model.hasReadwiseToken)
		#expect(store.token != nil)
		#expect(await server.token == "rw-new")
		let put = try #require(await server.requests(method: "PUT").last)
		let payload = try #require(try JSONSerialization.jsonObject(with: put.body ?? Data()) as? [String: String])
		#expect(payload == ["token": "rw-new"])
	}

	@Test
	func savingOfflineKeepsTheLocalTokenAndUploadsItLater() async throws {
		let server = ReadwiseTokenServer(token: "rw-stale")
		await server.setOffline(true)
		let store = TestReadwiseTokenStore()
		let model = try makeModel(server: server, store: store)

		let backedUp = try await model.saveReadwiseToken("rw-new")

		#expect(backedUp == false)
		#expect(model.hasReadwiseToken)
		#expect(store.token == "rw-new")

		await server.setOffline(false)
		await model.syncReadwiseTokenWithServer()
		// A pending local change wins over the older server copy.
		#expect(await server.token == "rw-new")
		#expect(store.token == "rw-new")
	}

	@Test
	func removingATokenDeletesItOnTheServer() async throws {
		let server = ReadwiseTokenServer(token: "rw-local")
		let store = TestReadwiseTokenStore(token: "rw-local")
		let model = try makeModel(server: server, store: store)

		let removedRemotely = try await model.removeReadwiseToken()

		#expect(removedRemotely)
		#expect(model.hasReadwiseToken == false)
		#expect(store.token == nil)
		#expect(await server.token == nil)
		#expect(await server.requests(method: "DELETE").count == 1)
	}

	@Test
	func removingOfflineDoesNotLetTheServerCopyComeBack() async throws {
		let server = ReadwiseTokenServer(token: "rw-local")
		await server.setOffline(true)
		let store = TestReadwiseTokenStore(token: "rw-local")
		let model = try makeModel(server: server, store: store)

		let removedRemotely = try await model.removeReadwiseToken()
		#expect(removedRemotely == false)
		#expect(store.token == nil)

		await server.setOffline(false)
		await model.syncReadwiseTokenWithServer()

		#expect(store.token == nil)
		#expect(model.hasReadwiseToken == false)
		#expect(await server.token == nil)
	}

	@Test
	func signingOutKeepsTheServerCopy() async throws {
		let server = ReadwiseTokenServer(token: "rw-local")
		let store = TestReadwiseTokenStore(token: "rw-local")
		let model = try makeModel(server: server, store: store)

		model.disconnect()

		#expect(await server.requests(method: "DELETE").isEmpty)
		#expect(await server.token == "rw-local")
	}

	private func makeModel(server: ReadwiseTokenServer, store: TestReadwiseTokenStore) throws -> ReaderAppModel {
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let session = PigeonSession(baseURL: baseURL, token: "server-token")
		let isolatedDefaults = try #require(UserDefaults(suiteName: "pigeon-readwise-sync-\(UUID().uuidString)"))
		return ReaderAppModel(
			sessionStore: TestSessionStore(session: session),
			httpClient: server,
			readwiseTokenStore: store,
			readerModeStore: ReaderModeStore(defaults: isolatedDefaults),
			articleFilterStore: ReaderArticleFilterStore(defaults: isolatedDefaults),
			smartViewStore: ReaderSmartViewStore(defaults: isolatedDefaults),
			offlineStore: OfflineLibraryStore.inMemory(),
			offlineSynchronizationEnabled: false,
			readerTypography: ReaderTypographySettings(defaults: isolatedDefaults),
			keyboardShortcuts: ReaderKeyboardShortcutSettings(defaults: isolatedDefaults),
			readwiseSyncDefaults: isolatedDefaults,
		)
	}
}
