import CoreGraphics

nonisolated enum ZoomableImageGeometry {
	static func visibleCenterRatio(offset: CGPoint, viewport: CGSize, content: CGSize) -> CGPoint {
		CGPoint(
			x: content.width > 0 ? (offset.x + viewport.width / 2) / content.width : 0.5,
			y: content.height > 0 ? (offset.y + viewport.height / 2) / content.height : 0.5
		)
	}

	static func fittedSize(imageSize: CGSize, in viewportSize: CGSize) -> CGSize {
		guard imageSize.width.isFinite, imageSize.height.isFinite,
			viewportSize.width.isFinite, viewportSize.height.isFinite,
			imageSize.width > 0, imageSize.height > 0,
			viewportSize.width > 0, viewportSize.height > 0 else {
			return .zero
		}

		let scale = min(
			viewportSize.width / imageSize.width,
			viewportSize.height / imageSize.height,
		)
		guard scale.isFinite, scale > 0 else { return .zero }
		return CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
	}

	static func centeringInset(viewportSize: CGSize, contentSize: CGSize) -> CGSize {
		guard viewportSize.width.isFinite, viewportSize.height.isFinite,
			contentSize.width.isFinite, contentSize.height.isFinite else {
			return .zero
		}

		return CGSize(
			width: max((viewportSize.width - contentSize.width) / 2, 0),
			height: max((viewportSize.height - contentSize.height) / 2, 0),
		)
	}
}
