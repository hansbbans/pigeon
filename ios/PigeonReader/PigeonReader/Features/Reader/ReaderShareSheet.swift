import SwiftUI
import UIKit

struct ReaderShareSheet: UIViewControllerRepresentable {
	let items: [URL]

	func makeUIViewController(context: Context) -> UIActivityViewController {
		UIActivityViewController(activityItems: items, applicationActivities: nil)
	}

	func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
