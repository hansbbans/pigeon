import SwiftUI
import UIKit

struct ReaderTextShareSheet: UIViewControllerRepresentable {
	let text: String

	func makeUIViewController(context: Context) -> UIActivityViewController {
		UIActivityViewController(activityItems: [text], applicationActivities: nil)
	}

	func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
