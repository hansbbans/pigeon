import Foundation

struct ReaderSaveConfirmation: Identifiable {
	let id = UUID()
	let message: String
	let isSuccess: Bool
}
