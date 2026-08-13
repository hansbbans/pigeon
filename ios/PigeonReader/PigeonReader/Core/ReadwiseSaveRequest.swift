import Foundation

struct ReadwiseSaveRequest: Equatable, Identifiable, Sendable {
	let id: UUID
	let destination: OutboundDestination

	init(destination: OutboundDestination) {
		id = UUID()
		self.destination = destination
	}
}
