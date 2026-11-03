import Foundation

extension ReaderAppModel {
	/// A bounded refresh can replace the cached first page while its previous
	/// rows remain on screen. An explicit action on one of those rows must still
	/// have the full story available to the reader and mutation handlers.
	func retainPresentedArticles(_ presented: [Recommendation], in collection: ReaderNavigationItem) {
		guard selectedNavigationID == collection.id else { return }
		let cached = allArticles(for: collection)
		let known = Set(cached.map(\.id))
		// Rows kept after being read are display-only; writing them back would
		// persist read stories into lists like Unread past the next re-filter.
		let retained = presented.filter { known.contains($0.id) == false && isKeptAfterLeavingFilter($0) == false }
		guard retained.isEmpty == false else { return }
		setArticles(cached + retained, for: collection)
	}
}
