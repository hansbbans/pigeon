import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
	private let statusLabel = UILabel()

	override func viewDidLoad() {
		super.viewDidLoad()
		view.backgroundColor = .systemBackground
		statusLabel.text = "Sending to Pigeon Reader…"
		statusLabel.textAlignment = .center
		statusLabel.numberOfLines = 0
		statusLabel.translatesAutoresizingMaskIntoConstraints = false
		view.addSubview(statusLabel)
		NSLayoutConstraint.activate([
			statusLabel.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
			statusLabel.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
			statusLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
		])
		Task { await receiveSharedURL() }
	}

	private func receiveSharedURL() async {
		guard let url = await firstSharedURL() else {
			statusLabel.text = "Share a website or feed URL with Pigeon Reader."
			return
		}
		PendingFeedStore.save(url)
		var components = URLComponents()
		components.scheme = "pigeon"
		components.host = "add"
		components.queryItems = [URLQueryItem(name: "url", value: url.absoluteString)]
		if let deepLink = components.url {
			_ = await extensionContext?.open(deepLink)
		}
		extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
	}

	private func firstSharedURL() async -> URL? {
		for item in extensionContext?.inputItems.compactMap({ $0 as? NSExtensionItem }) ?? [] {
			for provider in item.attachments ?? [] {
				if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
					let value = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier),
					let url = value as? URL {
					return url
				}
				if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
					let value = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier),
					let string = value as? String, let url = URL(string: string) {
					return url
				}
			}
		}
		return nil
	}
}
