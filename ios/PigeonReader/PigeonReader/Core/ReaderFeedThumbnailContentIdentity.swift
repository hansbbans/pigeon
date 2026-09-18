import CryptoKit
import Foundation

nonisolated enum ReaderFeedThumbnailContentIdentity {
	static func digest(for html: String) -> String {
		SHA256.hash(data: Data(html.utf8)).map { byte in
			let value = String(byte, radix: 16)
			return value.count == 1 ? "0\(value)" : value
		}.joined()
	}
}
