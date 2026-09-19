import SwiftUI
import UIKit

struct ReaderFolderNavigationRowView: View {
	let folder: ReaderNavigationItem
	let isExpanded: Bool
	let isSelected: Bool
	let onToggle: () -> Void
	let onSelect: () -> Void
	var onFrameChange: ((CGRect) -> Void)?

	var body: some View {
		HStack(spacing: 0) {
			ReaderFolderDisclosureButton(
				isExpanded: isExpanded,
				folderTitle: folder.title,
				identifier: ReaderSidebarAccessibility.folderToggle(folder.id),
				onToggle: onToggle,
			)
			.frame(width: 44, height: 44)

			Button(action: onSelect) {
				ReaderNavigationLabelView(
					item: folder,
					indentation: 0,
					isFolderExpanded: isExpanded,
				)
			}
			.buttonStyle(ReaderRowButtonStyle())
			.frame(maxWidth: .infinity, alignment: .leading)
			.accessibilityLabel(folder.title)
			.accessibilityValue("\(folder.unreadCount) unread")
			.accessibilityIdentifier(ReaderSidebarAccessibility.item(folder.id))
		}
		.listRowBackground(isSelected ? Color.accentColor.opacity(0.16) : .clear)
		.accessibilityElement(children: .contain)
		// Folder selection is handled by the explicit title button; keep repeated
		// disclosure taps out of List(selection:)'s cell-wide selection gesture.
		.selectionDisabled()
		.id(folder.id)
		.onGeometryChange(for: CGRect.self) { proxy in
			proxy.frame(in: .named(ReaderSidebarCoordinateSpace.name))
		} action: { _, frame in
			onFrameChange?(frame)
		}
	}
}

/// A native control keeps every touch-up inside the disclosure target while
/// List inserts/removes sibling rows and resolves its own selection gestures.
private struct ReaderFolderDisclosureButton: UIViewRepresentable {
	let isExpanded: Bool
	let folderTitle: String
	let identifier: String
	let onToggle: () -> Void
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	func makeCoordinator() -> Coordinator { Coordinator(onToggle: onToggle) }

	func makeUIView(context: Context) -> UIButton {
		let button = UIButton(type: .system)
		button.tintColor = .label
		button.addAction(UIAction { [coordinator = context.coordinator] _ in
			coordinator.onToggle()
		}, for: .touchUpInside)
		return button
	}

	func updateUIView(_ button: UIButton, context: Context) {
		context.coordinator.onToggle = onToggle
		button.accessibilityIdentifier = identifier
		button.accessibilityLabel = "\(isExpanded ? "Collapse" : "Expand") \(folderTitle)"
		button.setImage(UIImage(systemName: "chevron.right", withConfiguration: UIImage.SymbolConfiguration(
			pointSize: UIFont.preferredFont(forTextStyle: .body).pointSize, weight: .semibold
		)), for: .normal)
		let transform = CGAffineTransform(rotationAngle: isExpanded ? .pi / 2 : 0)
		let changesExpansion = context.coordinator.isExpanded.map { $0 != isExpanded } ?? false
		context.coordinator.isExpanded = isExpanded
		if changesExpansion && reduceMotion == false {
			UIView.animate(withDuration: ReaderMotion.folderExpansionDuration,
				delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
				button.imageView?.transform = transform
			}
		} else {
			button.imageView?.transform = transform
		}
	}

	final class Coordinator {
		var onToggle: () -> Void
		var isExpanded: Bool?
		init(onToggle: @escaping () -> Void) { self.onToggle = onToggle }
	}
}
