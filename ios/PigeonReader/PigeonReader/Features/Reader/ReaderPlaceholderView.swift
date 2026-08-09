import SwiftUI

struct ReaderPlaceholderView: View {
	let title: String

	var body: some View {
		ContentUnavailableView(
			"Choose a story",
			systemImage: "newspaper",
			description: Text("Select a story from \(title) to begin reading.")
		)
		.navigationTitle(title)
		.navigationBarTitleDisplayMode(.inline)
	}
}
