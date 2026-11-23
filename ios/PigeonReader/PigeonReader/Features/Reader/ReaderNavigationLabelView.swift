import SwiftUI

/// One library row's label: a grey symbol for a view, the favicon for a feed,
/// nothing for a folder (its disclosure triangle stands there). The unread
/// count is quiet grey digits, hidden at zero.
struct ReaderNavigationLabelView: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	let item: ReaderNavigationItem
	let indentation: CGFloat
	/// The count is drawn in the primary label colour on the selection fill,
	/// where grey would fall under 4.5:1.
	var isSelected = false

	var body: some View {
		HStack(spacing: 10) {
			if item.kind != .folder {
				icon
			}
			Text(item.title)
				.lineLimit(1)
				.truncationMode(.tail)
				// Explicit: a selected row in a List with selection turns the
				// default foreground white, unreadable on the light grey fill.
				.foregroundStyle(Color.primary)
			Spacer(minLength: 8)
			if item.unreadCount > 0 {
				Text(item.unreadCount, format: .number)
					.font(.subheadline.monospacedDigit())
					.foregroundStyle(isSelected ? Color.primary : Color.pigeonSecondary)
					.fixedSize(horizontal: true, vertical: false)
					.contentTransition(reduceMotion ? .identity : .numericText())
					.animation(
						reduceMotion ? nil : ReaderMotion.animation(reduceMotion: false),
						value: item.unreadCount,
					)
			}
		}
		.padding(.leading, indentation)
		// The library's viewport coordinator assumes rows at least 44pt tall.
		.frame(minHeight: 44, alignment: .leading)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		.accessibilityValue("\(item.unreadCount) unread")
	}

	private var icon: some View {
		Group {
			if item.kind == .feed, let iconURL = item.iconURL {
				FeedIconImage(url: iconURL) { loadedImage in
					ZStack {
						fallbackIcon
							.opacity(loadedImage == nil ? 1 : 0)
						if let image = loadedImage {
							image
								.resizable()
								.scaledToFit()
								.clipShape(.rect(cornerRadius: 4))
								.transition(.opacity)
						}
					}
					.animation(
						reduceMotion ? nil : ReaderMotion.animation(reduceMotion: false),
						value: loadedImage != nil,
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
		Image(systemName: item.smartSection?.systemImage ?? "newspaper")
			.foregroundStyle(.pigeonSecondary)
	}
}

/// A small grey uppercase label over a group of the library (Views, Folders,
/// Feeds). A plain row, not a `Section` header, so it scrolls with the list.
struct ReaderLibraryGroupLabel: View {
	let title: String

	init(_ title: String) {
		self.title = title
	}

	var body: some View {
		Text(title)
			.font(ReaderTypography.sectionLabel)
			.textCase(.uppercase)
			.tracking(ReaderTypography.sectionLabelTracking)
			.foregroundStyle(.pigeonSecondary)
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.top, 14)
			.accessibilityAddTraits(.isHeader)
			.selectionDisabled()
			.readerLibraryRowChrome()
	}
}

/// The selected library row: a rounded neutral fill behind the row's own
/// content. (`listRowBackground` takes only a plain colour in this list: any
/// other view is laid over a white cell.)
struct ReaderLibrarySelection: ViewModifier {
	let isSelected: Bool

	func body(content: Content) -> some View {
		content.background {
			if isSelected {
				RoundedRectangle(cornerRadius: 8, style: .continuous)
					.fill(PigeonPalette.librarySelection)
					.padding(.horizontal, -8)
					.padding(.vertical, 1)
			}
		}
	}
}

extension View {
	func readerLibrarySelection(_ isSelected: Bool) -> some View {
		modifier(ReaderLibrarySelection(isSelected: isSelected))
	}

	/// The Reeder library's row chrome: no separator, no cell background (the
	/// grey column shows through), 44pt rows. Apply outermost on each row: the
	/// list reads these through `.id` and `.onGeometryChange` only from there.
	func readerLibraryRowChrome() -> some View {
		listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
			.listRowSeparator(.hidden)
			.listRowBackground(Color.clear)
	}
}
