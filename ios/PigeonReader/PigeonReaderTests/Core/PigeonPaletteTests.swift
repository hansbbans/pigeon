import SwiftUI
import Testing
import UIKit
@testable import PigeonReader

/// The design system promises 4.5:1 for every text colour on the system
/// background in light and dark mode, and 4.5:1 for white glyphs on swipe fills.
struct PigeonPaletteTests {
	@Test(arguments: [
		("labelSecondary", PigeonPalette.labelSecondary),
		("keep", PigeonPalette.keep),
		("danger", PigeonPalette.danger),
		("positive", PigeonPalette.positive),
	])
	func textColoursReadOnSystemBackground(name: String, color: Color) {
		for style in [UIUserInterfaceStyle.light, .dark] {
			let traits = UITraitCollection(userInterfaceStyle: style)
			let foreground = UIColor(color).resolvedColor(with: traits)
			let background = UIColor.systemBackground.resolvedColor(with: traits)
			let ratio = Self.contrast(foreground, background)
			#expect(ratio >= 4.5, "\(name) is \(ratio):1 in \(style == .dark ? "dark" : "light")")
		}
	}

	@Test(arguments: [PigeonPalette.SwipeFill.tint, PigeonPalette.SwipeFill.keep, PigeonPalette.SwipeFill.readLater])
	func swipeFillsCarryWhiteGlyphs(fill: Color) {
		#expect(Self.contrast(.white, UIColor(fill)) >= 4.5)
	}

	@Test
	func readerGroundsMatchTheArticleCSS() {
		#expect(Self.hex(UIColor(PigeonPalette.sepiaBackground)) == 0xF6ECD1)
		#expect(Self.hex(UIColor(PigeonPalette.darkGrayBackground)) == 0x1C1C1E)
	}

	@Test
	func defaultColumnWidthIsTheReaderMeasure() {
		#expect(ReaderTypographySettings.defaultColumnWidth == 640)
	}

	private static func contrast(_ a: UIColor, _ b: UIColor) -> Double {
		let la = luminance(a), lb = luminance(b)
		return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
	}

	private static func luminance(_ color: UIColor) -> Double {
		var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
		color.getRed(&r, green: &g, blue: &b, alpha: &a)
		func channel(_ v: CGFloat) -> Double {
			let v = Double(v)
			return v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
		}
		return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
	}

	private static func hex(_ color: UIColor) -> Int {
		var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
		color.getRed(&r, green: &g, blue: &b, alpha: &a)
		return (Int((r * 255).rounded()) << 16) | (Int((g * 255).rounded()) << 8) | Int((b * 255).rounded())
	}
}
