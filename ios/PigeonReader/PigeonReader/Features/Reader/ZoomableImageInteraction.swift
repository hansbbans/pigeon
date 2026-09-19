import CoreGraphics

nonisolated enum ZoomableImageInteraction {
	static let minimumZoomScale: CGFloat = 1
	static let maximumZoomScale: CGFloat = 5
	static let doubleTapZoomScale: CGFloat = 2.5
	static let accessibilityZoomStep: CGFloat = 1.5
	static let zoomedThreshold: CGFloat = 1.01

	static func clampedZoomScale(_ value: CGFloat) -> CGFloat {
		guard value.isFinite else { return minimumZoomScale }
		return min(max(value, minimumZoomScale), maximumZoomScale)
	}

	static func isZoomed(_ value: CGFloat) -> Bool {
		clampedZoomScale(value) > zoomedThreshold
	}

	static func canPanImage(at value: CGFloat) -> Bool {
		isZoomed(value)
	}

	static func canDismissSheet(at value: CGFloat) -> Bool {
		canPanImage(at: value) == false
	}

	static func shouldDismissAfterDrag(translation: CGPoint, velocity: CGPoint, zoomScale: CGFloat) -> Bool {
		guard canDismissSheet(at: zoomScale), translation.y > abs(translation.x), velocity.y >= 0 else {
			return false
		}
		return translation.y >= 100 || (translation.y >= 30 && velocity.y >= 800)
	}

	static func accessibilityIncrement(from value: CGFloat) -> CGFloat {
		clampedZoomScale(max(value, minimumZoomScale) * accessibilityZoomStep)
	}

	static func accessibilityDecrement(from value: CGFloat) -> CGFloat {
		clampedZoomScale(max(value, minimumZoomScale) / accessibilityZoomStep)
	}
}
