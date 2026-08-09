#if DEBUG
import Foundation

struct PreviewHTTPClient: HTTPClient {
	nonisolated func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		guard let fallbackURL = URL(string: "https://pigeon.preview") else {
			throw PigeonError.invalidServerURL
		}
		let url = request.url ?? fallbackURL
		let data: Data
		if url.path == "/api/v1/recommendations" {
			data = Data("{\"generatedAt\":\"2026-08-09T12:00:00Z\",\"view\":\"preview\",\"items\":[]}".utf8)
		} else {
			data = Data()
		}
		guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil) else {
			throw PigeonError.invalidResponse
		}
		return (data, response)
	}
}
#endif
