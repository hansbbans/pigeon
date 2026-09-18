import Foundation

extension ReaderAppModel {
	/// A bounded refresh can replace the cached first page while its previous
	/// rows remain on screen. An explicit action on one of those rows must still
	/// have the full story available to the reader and mutation handlers.
	func retainPresentedArticles(_ presented: [Recommendation], in collection: ReaderNavigationItem) {
		guard selectedNavigationID == collection.id else { return }
		let cached = allArticles(for: collection)
		let known = Set(cached.map(\.id))
		let retained = presented.filter { known.contains($0.id) == false }
		guard retained.isEmpty == false else { return }
		setArticles(cached + retained, for: collection)
	}
}
