import SwiftUI
import UIKit

/// Colours from the Pigeon design system (see `DESIGN.md`). Each text colour
/// reads at 4.5:1 or better on the system background in light and dark mode,
/// which the translucent system `.secondary`, `.orange` and `.red` do not.
nonisolated enum PigeonPalette {
	/// `label-secondary`: metadata, footnotes, status lines.
	static let labelSecondary = dynamic(light: 0x6C6C70, dark: 0x98989F)
	/// `keep`: kept / starred state and the paywall label.
	static let keep = dynamic(light: 0xA05A00, dark: 0xFFB340)
	/// `danger`: errors and destructive actions, always with a word.
	static let danger = dynamic(light: 0xD70015, dark: 0xFF6961)
	/// `kicker-6`: healthy / positive status text.
	static let positive = dynamic(light: 0x2E7D32, dark: 0x8BD48F)

	/// Swipe-action fills. Fixed (not dynamic) so the white glyph stays at
	/// 5:1 or better in dark mode too.
	enum SwipeFill {
		static let tint = rgb(0x0063D1)
		static let keep = rgb(0xA05A00)
		/// `kicker-2` teal, for Read It Later.
		static let readLater = rgb(0x1F6F6A)
	}

	/// Reader theme grounds that differ from `systemBackground`.
	static let sepiaBackground = rgb(0xF6ECD1)
	static let darkGrayBackground = rgb(0x1C1C1E)

	/// UIKit may resolve dynamic colours off the main thread.
	private static func dynamic(light: UInt32, dark: UInt32) -> Color {
		Color(uiColor: UIColor { traits in
			uiColor(traits.userInterfaceStyle == .dark ? dark : light)
		})
	}

	private static func rgb(_ hex: UInt32) -> Color {
		Color(uiColor: uiColor(hex))
	}

	private static func uiColor(_ hex: UInt32) -> UIColor {
		UIColor(
			red: CGFloat((hex >> 16) & 0xFF) / 255,
			green: CGFloat((hex >> 8) & 0xFF) / 255,
			blue: CGFloat(hex & 0xFF) / 255,
			alpha: 1,
		)
	}
}

extension ShapeStyle where Self == Color {
	static var pigeonSecondary: Color { PigeonPalette.labelSecondary }
	static var pigeonKeep: Color { PigeonPalette.keep }
	static var pigeonDanger: Color { PigeonPalette.danger }
}
