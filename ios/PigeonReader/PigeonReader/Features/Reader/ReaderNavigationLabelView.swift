import SwiftUI

struct ReaderNavigationLabelView: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	let item: ReaderNavigationItem
	let indentation: CGFloat
	var isFolderExpanded = false

	var body: some View {
		HStack(spacing: 10) {
			icon
			Text(item.title)
				.lineLimit(1)
				.truncationMode(.tail)
			Spacer(minLength: 8)
			Text(item.unreadCount, format: .number)
				.font(.body.monospacedDigit())
				.foregroundStyle(item.unreadCount > 0 ? .primary : .secondary)
				.fixedSize(horizontal: true, vertical: false)
				.contentTransition(reduceMotion ? .identity : .numericText())
				.animation(
					reduceMotion ? nil : ReaderMotion.animation(reduceMotion: false),
					value: item.unreadCount,
				)
		}
		.padding(.leading, indentation)
		.frame(minHeight: 44, alignment: .leading)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		.accessibilityValue("\(item.unreadCount) unread")
	}

	private var icon: some View {
		Group {
			if item.kind == .feed, let iconURL = item.iconURL {
				AsyncImage(url: iconURL) { phase in
					ZStack {
						fallbackIcon
							.opacity(phase.image == nil ? 1 : 0)
						if let image = phase.image {
							image
								.resizable()
								.scaledToFit()
								.clipShape(.rect(cornerRadius: 4))
								.transition(.opacity)
						}
					}
					.animation(
						reduceMotion ? nil : ReaderMotion.animation(reduceMotion: false),
						value: phase.image != nil,
					)
				}
			} else {
				fallbackIcon
			}
		}
		.frame(width: 20, height: 20)
		.accessibilityHidden(true)
	}

	private var fallbackIcon: some View {
		Image(systemName: item.systemImage(isFolderExpanded: isFolderExpanded))
			.symbolRenderingMode(.hierarchical)
			.foregroundStyle(.tint)
			.contentTransition(
				item.kind == .folder && reduceMotion == false
					? .symbolEffect(.replace)
					: .identity,
			)
	}
}

private extension ReaderNavigationItem {
	func systemImage(isFolderExpanded: Bool) -> String {
		if let smartSection {
			return smartSection.systemImage
		}
		if kind == .folder {
			return isFolderExpanded ? "folder.fill" : "folder"
		}
		return "newspaper"
	}
}
