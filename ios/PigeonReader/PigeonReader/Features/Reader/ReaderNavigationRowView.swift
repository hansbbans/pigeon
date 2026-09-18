import SwiftUI

struct ReaderNavigationRowView: View {
	let item: ReaderNavigationItem
	let isSelected: Bool
	var indentation: CGFloat = 0
	var onFrameChange: ((CGRect) -> Void)?

	var body: some View {
		NavigationLink(value: item.id) {
			ReaderNavigationLabelView(item: item, indentation: indentation)
		}
		.listRowBackground(isSelected ? Color.accentColor.opacity(0.16) : .clear)
		.accessibilityLabel(item.title)
		.accessibilityValue("\(item.unreadCount) unread")
		.accessibilityIdentifier(ReaderSidebarAccessibility.item(item.id))
		.tag(item.id)
		.id(item.id)
		.onGeometryChange(for: CGRect.self) { proxy in
			proxy.frame(in: .named(ReaderSidebarCoordinateSpace.name))
		} action: { _, frame in
			onFrameChange?(frame)
		}
	}
}
