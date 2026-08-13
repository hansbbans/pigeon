import SwiftUI

struct ReaderNavigationLabelView: View {
	let item: ReaderNavigationItem
	let indentation: CGFloat

	var body: some View {
		HStack(spacing: 10) {
			Image(systemName: item.systemImage)
				.symbolRenderingMode(.hierarchical)
				.foregroundStyle(.tint)
				.frame(width: 20)
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
