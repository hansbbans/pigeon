import SwiftUI

extension EnvironmentValues {
	@Entry var readerCollectionIsTransitioning = false
	/// The window's horizontal size class. Split view columns report their own
	/// (the sidebar is compact even on iPad), so the shell passes this down for
	/// decisions about the whole window, such as offering a way back to Home.
	@Entry var readerWindowHorizontalSizeClass: UserInterfaceSizeClass? = nil
}
