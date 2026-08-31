import Foundation

/// Identity for the in-app Safari controller.
///
/// `SFSafariViewController` cannot change its URL after creation. SwiftUI will
/// otherwise reuse the same controller when the iPad detail column swaps stories,
/// leaving Website mode on the previous page.
struct ArticleWebsiteIdentity: Hashable, Sendable {
	let articleID: String
	let url: URL
}
