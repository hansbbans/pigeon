enum OutboundLinkRoute: Equatable, Sendable {
	case openInBrowser(OutboundDestination)
	case shareToReader(OutboundDestination)
}
