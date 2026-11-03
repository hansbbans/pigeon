import SwiftUI

struct RootView: View {
	@Environment(ReaderAppModel.self) private var model

	var body: some View {
		Group {
			if model.session == nil {
				ConnectionView()
			} else {
				ReaderShellView()
			}
		}
		// Read in a view body so toggling the setting re-renders open lists.
		.environment(\.showsReadingTime, model.readerTypography.showsReadingTime)
	}
}
