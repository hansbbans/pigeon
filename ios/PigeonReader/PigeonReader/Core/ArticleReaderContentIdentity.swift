import Foundation

/// Identity for the Feed Content / Reader View scroll column.
///
/// The iPad detail pane reuses `ArticleReaderView`. Without a new identity,
/// `ScrollView` keeps the previous story's offset, so the next newsletter can
/// open already scrolled. Website mode is a separate `SFSafariViewController`
/// identity.
struct ArticleReaderContentIdentity: Hashable, Sendable {
	let articleID: String
	let mode: ReaderMode
}
