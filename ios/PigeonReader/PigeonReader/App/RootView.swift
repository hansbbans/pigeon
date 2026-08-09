import SwiftUI

struct RootView: View {
	@Environment(ReaderAppModel.self) private var model

	var body: some View {
		if model.session == nil {
			ConnectionView()
		} else {
			ReaderShellView()
		}
	}
}
