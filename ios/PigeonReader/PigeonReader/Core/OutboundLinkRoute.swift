enum OutboundLinkRoute: Equatable, Sendable {
	case openInBrowser(OutboundDestination)
	case readItLater(OutboundDestination)
}
