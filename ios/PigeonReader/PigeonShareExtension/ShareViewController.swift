import UIKit
import UniformTypeIdentifiers

/// Share sheet entry. A shared page goes straight to Read It Later; a URL that
/// looks like a feed (or a YouTube channel) asks first, with Add as Feed on
/// top. The extension posts only the bare link: the app extracts the text
/// later, which keeps the extension far inside its memory limit.
final class ShareViewController: UIViewController {
	private let iconView = UIImageView()
	private let statusLabel = UILabel()
	private let detailLabel = UILabel()
	private let buttonStack = UIStackView()

	override func viewDidLoad() {
		super.viewDidLoad()
		view.backgroundColor = .systemBackground
		configureLayout()
		show(status: "Saving to Read It Later…", detail: nil, symbol: "bookmark")
		Task { await receiveSharedItem() }
	}

	private func configureLayout() {
		iconView.tintColor = .label
		iconView.contentMode = .scaleAspectFit
		iconView.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .title1)
		statusLabel.font = .preferredFont(forTextStyle: .headline)
		statusLabel.adjustsFontForContentSizeCategory = true
		statusLabel.textAlignment = .center
		statusLabel.numberOfLines = 0
		statusLabel.accessibilityIdentifier = "share-status"
		detailLabel.font = .preferredFont(forTextStyle: .subheadline)
		detailLabel.adjustsFontForContentSizeCategory = true
		detailLabel.textColor = .secondaryLabel
		detailLabel.textAlignment = .center
		detailLabel.numberOfLines = 2
		detailLabel.lineBreakMode = .byTruncatingMiddle
		buttonStack.axis = .vertical
		buttonStack.spacing = 10
		buttonStack.isHidden = true

		let stack = UIStackView(arrangedSubviews: [iconView, statusLabel, detailLabel, buttonStack])
		stack.axis = .vertical
		stack.alignment = .fill
		stack.spacing = 12
		stack.setCustomSpacing(20, after: detailLabel)
		stack.translatesAutoresizingMaskIntoConstraints = false
		view.addSubview(stack)
		NSLayoutConstraint.activate([
			stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
			stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
			stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
		])
	}

	private func show(status: String, detail: String?, symbol: String) {
		statusLabel.text = status
		detailLabel.text = detail
		detailLabel.isHidden = detail == nil
		iconView.image = UIImage(systemName: symbol)
		UIAccessibility.post(notification: .announcement, argument: status)
	}

	private func receiveSharedItem() async {
		guard let shared = await firstSharedLink() else {
			show(status: "Share a web page or link with Pigeon.", detail: nil, symbol: "link")
			showButtons([("Done", .prominent, { [weak self] in self?.finish() })])
			return
		}
		let detail = shared.url.host() ?? shared.url.absoluteString
		if SharedLinkClassifier.looksLikeFeed(shared.url) {
			show(status: "Add this to Pigeon", detail: detail, symbol: "dot.radiowaves.up.forward")
			showButtons([
				("Add as Feed", .prominent, { [weak self] in Task { await self?.addFeed(shared.url) } }),
				("Read It Later", .plain, { [weak self] in Task { await self?.saveForLater(shared) } }),
			])
		} else {
			await saveForLater(shared)
		}
	}

	private func saveForLater(_ shared: SharedLink) async {
		buttonStack.isHidden = true
		show(status: "Saving to Read It Later…", detail: shared.url.host(), symbol: "bookmark")
		switch await ShareSaver.save(url: shared.url, title: shared.title) {
		case .saved:
			show(status: "Saved to Read It Later", detail: shared.title ?? shared.url.host(), symbol: "bookmark.fill")
		case .queued:
			show(status: "Saved, will sync", detail: "It’ll show up in Read It Later when you open Pigeon.", symbol: "clock")
		case .rejected(let message):
			show(status: "Couldn’t save this link", detail: message, symbol: "exclamationmark.triangle")
			showButtons([("Done", .prominent, { [weak self] in self?.finish() })])
			return
		}
		try? await Task.sleep(for: .milliseconds(900))
		finish()
	}

	private func addFeed(_ url: URL) async {
		PendingFeedStore.save(url)
		var components = URLComponents()
		components.scheme = "pigeon"
		components.host = "add"
		components.queryItems = [URLQueryItem(name: "url", value: url.absoluteString)]
		if let deepLink = components.url {
			_ = await extensionContext?.open(deepLink)
		}
		finish()
	}

	private func finish() {
		extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
	}

	private enum ButtonStyle {
		case prominent
		case plain
	}

	private func showButtons(_ buttons: [(String, ButtonStyle, () -> Void)]) {
		buttonStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
		for (title, style, action) in buttons {
			var configuration: UIButton.Configuration = style == .prominent ? .borderedProminent() : .bordered()
			configuration.title = title
			configuration.buttonSize = .large
			let button = UIButton(configuration: configuration, primaryAction: UIAction { _ in action() })
			buttonStack.addArrangedSubview(button)
		}
		buttonStack.isHidden = false
	}

	private func firstSharedLink() async -> SharedLink? {
		for item in extensionContext?.inputItems.compactMap({ $0 as? NSExtensionItem }) ?? [] {
			let title = SharedShareItem.normalizedTitle(item.attributedTitle?.string)
			for provider in item.attachments ?? [] {
				if let url = await Self.webURL(from: provider) {
					return SharedLink(url: url, title: title)
				}
			}
			if let link = SharedShareItem.link(
				fromItemText: item.attributedTitle?.string,
				contentText: item.attributedContentText?.string,
			) {
				return SharedLink(url: link.url, title: title ?? link.title)
			}
			if let url = SharedShareItem.webURLFromJavaScriptShare(item.userInfo) {
				return SharedLink(url: url, title: title)
			}
		}
		return nil
	}

	/// `loadItem` returns whatever the host registered (often a string, not a
	/// `URL`). Coercion lives in `SharedShareItem.webURL(from:)`.
	private static func webURL(from provider: NSItemProvider) async -> URL? {
		for identifier in [UTType.url.identifier, UTType.plainText.identifier, "public.utf8-plain-text"]
			where provider.hasItemConformingToTypeIdentifier(identifier) {
			if let value = try? await provider.loadItem(forTypeIdentifier: identifier),
				let url = SharedShareItem.webURL(from: value) {
				return url
			}
		}
		return nil
	}
}

private struct SharedLink {
	let url: URL
	let title: String?
}

private enum ShareSaver {
	enum Outcome {
		case saved
		case queued
		case rejected(String)
	}

	/// Posts the link with the app's session. Anything short of a definite
	/// answer queues it in the app group, where the app sends it later — but
	/// only when that group exists. A write to the extension's private Library
	/// would look like success and never reach Read It Later.
	static func save(url: URL, title: String?) async -> Outcome {
		guard let data = try? SharedSessionKeychain().load(migratingLegacyItem: false),
			let session = try? JSONDecoder().decode(PigeonSession.self, from: data),
			let request = try? SharedLinkClassifier.saveRequest(baseURL: session.baseURL, token: session.token, url: url, title: title) else {
			return queue(url: url, title: title, noSession: true)
		}
		do {
			let (body, response) = try await URLSession.shared.data(for: request)
			let statusCode = (response as? HTTPURLResponse)?.statusCode
			if let statusCode, 200..<300 ~= statusCode {
				return .saved
			}
			switch SavedLinkFailure.classify(statusCode: statusCode) {
			case .rejected, .unauthorized:
				return .rejected(SavedLinkFailure.shareExtensionMessage(statusCode: statusCode, body: body))
			case .retryLater:
				return queue(url: url, title: title, noSession: false)
			}
		} catch {
			return queue(url: url, title: title, noSession: false)
		}
	}

	private static func queue(url: URL, title: String?, noSession: Bool) -> Outcome {
		let hasSharedContainer = PendingSavedLinkQueue.hasSharedContainer
		let enqueued = hasSharedContainer && PendingSavedLinkQueue.shared.enqueue(url: url, title: title) != nil
		switch SharedShareHandoff.queue(hasSharedContainer: hasSharedContainer, enqueued: enqueued, noSession: noSession) {
		case .queued: return .queued
		case .rejected(let message): return .rejected(message)
		}
	}
}
