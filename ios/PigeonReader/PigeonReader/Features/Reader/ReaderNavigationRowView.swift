import SwiftUI

struct ReaderNavigationRowView: View {
	let item: ReaderNavigationItem
	let isSelected: Bool
	var indentation: CGFloat = 0
	let onSelect: () -> Void

	var body: some View {
		Button(action: onSelect) {
			ReaderNavigationLabelView(item: item, indentation: indentation)
		}
		.buttonStyle(.plain)
		.listRowBackground(isSelected ? Color.accentColor.opacity(0.16) : .clear)
		.accessibilityLabel(item.title)
		.accessibilityValue("\(item.unreadCount) unread")
	}
}
