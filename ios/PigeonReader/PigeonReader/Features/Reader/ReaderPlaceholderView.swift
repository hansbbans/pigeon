import SwiftUI

struct ReaderPlaceholderView: View {
	let collection: ReaderNavigationItem

	var body: some View {
		ContentUnavailableView(
			"Choose a story",
			systemImage: "newspaper",
			description: Text("Select a story from \(collection.title) to begin reading.")
		)
		.navigationTitle(collection.title)
		.navigationBarTitleDisplayMode(.inline)
	}
}
