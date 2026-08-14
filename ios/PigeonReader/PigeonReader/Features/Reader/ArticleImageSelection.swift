import Foundation

struct ArticleImageSelection: Identifiable, Equatable, Sendable {
	let url: URL

	var id: String { url.absoluteString }
}

struct LinkedArticleImage: Identifiable, Equatable, Sendable {
	let imageURL: URL
	let destinationURL: URL

	var id: String {
		"\(imageURL.absoluteString)|\(destinationURL.absoluteString)"
	}
}
