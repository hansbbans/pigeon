import Foundation

struct OutboundLinkChoiceState: Equatable, Sendable {
	private(set) var pendingDestination: OutboundDestination?

	var isDialogPresented: Bool {
		get { pendingDestination != nil }
		set {
			if newValue == false {
				pendingDestination = nil
			}
		}
	}

	mutating func accept(_ url: URL) -> OutboundDestination? {
		guard pendingDestination == nil, let destination = OutboundDestination(url: url) else {
			return nil
		}
		pendingDestination = destination
		return destination
	}

	mutating func choose(_ choice: OutboundLinkChoice) -> OutboundLinkRoute? {
		guard let destination = pendingDestination else {
			return nil
		}
		pendingDestination = nil

		switch choice {
		case .openInBrowser:
			return .openInBrowser(destination)
		case .shareToReader:
			return .shareToReader(destination)
		}
	}
}
