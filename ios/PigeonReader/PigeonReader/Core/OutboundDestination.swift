import Foundation

struct OutboundDestination: Equatable, Identifiable, Sendable {
	let url: URL
	let host: String

	var id: String {
		url.absoluteString
	}

	init?(url: URL) {
		guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
			return nil
		}
		guard let rawHost = url.host?.lowercased() else {
			return nil
		}
		let host = rawHost.hasSuffix(".") ? String(rawHost.dropLast()) : rawHost
		guard !host.isEmpty, host.utf8.count <= 253 else {
			return nil
		}
		let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789.-")
		guard host.unicodeScalars.allSatisfy(allowed.contains) else {
			return nil
		}
		guard host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy({ label in
			!label.isEmpty && label.utf8.count <= 63 && !label.hasPrefix("-") && !label.hasSuffix("-")
		}) else {
			return nil
		}

		self.url = url
		self.host = host
	}
}
