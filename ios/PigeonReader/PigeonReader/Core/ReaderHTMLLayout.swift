import Foundation

struct ReaderSemanticAnchor: Equatable, Sendable {
	let id: String
	let top: Double
	let height: Double
}

struct ReaderScrollAnchor: Equatable, Sendable {
	let id: String
	let distanceFromTop: Double
}

struct ReaderHTMLLayout: Equatable, Sendable {
	let contentHeight: Double
	let anchors: [ReaderSemanticAnchor]

	static let empty = ReaderHTMLLayout(contentHeight: 0, anchors: [])

	func anchor(at documentOffset: Double) -> ReaderScrollAnchor? {
		guard let first = anchors.first else { return nil }
		let visibleAnchor = anchors.last(where: { $0.top <= documentOffset }) ?? first
		return ReaderScrollAnchor(
			id: visibleAnchor.id,
			distanceFromTop: documentOffset - visibleAnchor.top,
		)
	}

	func documentOffset(for anchor: ReaderScrollAnchor) -> Double? {
		guard let current = anchors.first(where: { $0.id == anchor.id }) else { return nil }
		if anchor.distanceFromTop < 0 {
			return current.top + anchor.distanceFromTop
		}
		let distance = min(anchor.distanceFromTop, max(current.height - 1, 0))
		return current.top + distance
	}
}

enum ReaderScrollCoordinateSpace {
	static let name = "pigeon-article-reader-scroll"
}
