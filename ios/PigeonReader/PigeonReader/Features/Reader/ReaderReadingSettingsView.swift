import SwiftUI

struct ReaderReadingSettingsView: View {
	@Bindable private var settings: ReaderTypographySettings
	@Environment(\.dismiss) private var dismiss

	init(settings: ReaderTypographySettings) {
		_settings = Bindable(settings)
	}

	var body: some View {
		NavigationStack {
			Form {
				Section("Type size") {
					ReaderReadingSettingStepper(
						title: "Text size",
						value: settings.textScale.formatted(.percent.precision(.fractionLength(0))),
						decreaseLabel: "Decrease text size",
						increaseLabel: "Increase text size",
						canDecrease: settings.textScale > ReaderTypographySettings.textScaleRange.lowerBound,
						canIncrease: settings.textScale < ReaderTypographySettings.textScaleRange.upperBound,
						onDecrease: settings.decreaseTextScale,
						onIncrease: settings.increaseTextScale,
					)
					.accessibilityIdentifier("reader-reading-type-size")

					Slider(
						value: $settings.textScale,
						in: ReaderTypographySettings.textScaleRange,
						step: 0.05,
					) {
						Text("Text size")
					} minimumValueLabel: {
						Image(systemName: "textformat.size.smaller")
							.accessibilityHidden(true)
					} maximumValueLabel: {
						Image(systemName: "textformat.size.larger")
							.accessibilityHidden(true)
					}
					.accessibilityIdentifier("reader-reading-type-size-slider")
				}

				Section("Line spacing") {
					ReaderReadingSettingStepper(
						title: "Line spacing",
						value: settings.lineHeight.formatted(.number.precision(.fractionLength(2))),
						decreaseLabel: "Decrease line spacing",
						increaseLabel: "Increase line spacing",
						canDecrease: settings.lineHeight > ReaderTypographySettings.lineHeightRange.lowerBound,
						canIncrease: settings.lineHeight < ReaderTypographySettings.lineHeightRange.upperBound,
						onDecrease: settings.decreaseLineHeight,
						onIncrease: settings.increaseLineHeight,
					)
					.accessibilityIdentifier("reader-reading-line-spacing")

					Slider(
						value: $settings.lineHeight,
						in: ReaderTypographySettings.lineHeightRange,
						step: 0.05,
					) {
						Text("Line spacing")
					} minimumValueLabel: {
						Image(systemName: "text.justify.leading")
							.accessibilityHidden(true)
					} maximumValueLabel: {
						Image(systemName: "text.justify")
							.accessibilityHidden(true)
					}
					.accessibilityIdentifier("reader-reading-line-spacing-slider")
				}

				Section("Theme") {
					Picker("Theme", selection: $settings.theme) {
						ForEach(ReaderTheme.allCases) { theme in
							Text(theme.title).tag(theme)
						}
					}
					.pickerStyle(.menu)
					.accessibilityIdentifier("reader-reading-theme")
				}

				Section {
					Button("Reset reading controls", systemImage: "arrow.counterclockwise", action: settings.reset)
						.accessibilityIdentifier("reader-reading-reset")
				}
			}
			.formStyle(.grouped)
			.navigationTitle("Reading controls")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .confirmationAction) {
					Button("Done", action: dismiss.callAsFunction)
				}
			}
		}
		.presentationDetents([.medium, .large])
		.presentationDragIndicator(.visible)
	}
}

private struct ReaderReadingSettingStepper: View {
	let title: String
	let value: String
	let decreaseLabel: String
	let increaseLabel: String
	let canDecrease: Bool
	let canIncrease: Bool
	let onDecrease: () -> Void
	let onIncrease: () -> Void

	var body: some View {
		HStack {
			Text(title)
			Spacer(minLength: 12)
			Button(decreaseLabel, systemImage: "minus", action: onDecrease)
				.labelStyle(.iconOnly)
				.buttonStyle(.borderless)
				.frame(minWidth: 44, minHeight: 44)
				.disabled(canDecrease == false)
			Text(value)
				.monospacedDigit()
				.frame(minWidth: 56, alignment: .center)
				.accessibilityLabel(title)
				.accessibilityValue(value)
			Button(increaseLabel, systemImage: "plus", action: onIncrease)
				.labelStyle(.iconOnly)
				.buttonStyle(.borderless)
				.frame(minWidth: 44, minHeight: 44)
				.disabled(canIncrease == false)
		}
	}
}
