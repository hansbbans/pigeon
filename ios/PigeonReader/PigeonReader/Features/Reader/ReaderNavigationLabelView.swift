import SwiftUI

struct ReaderNavigationLabelView: View {
	let item: ReaderNavigationItem
	let indentation: CGFloat

	var body: some View {
		HStack(spacing: 10) {
			if item.kind == .feed, let iconURL = item.iconURL {
				AsyncImage(url: iconURL) { phase in
					if let image = phase.image {
						image
							.resizable()
							.scaledToFit()
							.frame(width: 20, height: 20)
							.clipShape(.rect(cornerRadius: 4))
					} else {
						Image(systemName: item.systemImage)
							.symbolRenderingMode(.hierarchical)
							.foregroundStyle(.tint)
					}
				}
				.frame(width: 20, height: 20)
				.accessibilityHidden(true)
			} else {
				Image(systemName: item.systemImage)
					.symbolRenderingMode(.hierarchical)
					.foregroundStyle(.tint)
					.frame(width: 20, height: 20)
					.accessibilityHidden(true)
			}
			Text(item.title)
				.lineLimit(1)
				.truncationMode(.tail)
			Spacer(minLength: 8)
			Text(item.unreadCount, format: .number)
				.font(.body.monospacedDigit())
				.foregroundStyle(item.unreadCount > 0 ? .primary : .secondary)
				.fixedSize(horizontal: true, vertical: false)
		}
		.padding(.leading, indentation)
		.frame(minHeight: 44, alignment: .leading)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		.accessibilityValue("\(item.unreadCount) unread")
	}
}

private extension ReaderNavigationItem {
	var systemImage: String {
		if let smartSection {
			return smartSection.systemImage
		}
		return kind == .folder ? "folder" : "newspaper"
	}
}
