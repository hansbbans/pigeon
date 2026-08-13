import SwiftUI

struct ReaderFolderNavigationRowView: View {
	let folder: ReaderNavigationItem
	let isExpanded: Bool
	let isSelected: Bool
	let onToggle: () -> Void
	let onSelect: () -> Void

	var body: some View {
		HStack(spacing: 0) {
			Button(action: onToggle) {
				Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
					.font(.body.weight(.semibold))
					.frame(width: 44, height: 44)
			}
			.buttonStyle(.plain)
			.accessibilityLabel(isExpanded ? "Collapse \(folder.title)" : "Expand \(folder.title)")

			Button(action: onSelect) {
				ReaderNavigationLabelView(item: folder, indentation: 0)
			}
			.buttonStyle(.plain)
		}
		.listRowBackground(isSelected ? Color.accentColor.opacity(0.16) : .clear)
		.accessibilityElement(children: .contain)
	}
}
