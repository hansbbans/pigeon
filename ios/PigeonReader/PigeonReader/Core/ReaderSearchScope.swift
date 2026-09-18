nonisolated enum ReaderSearchScope: String, CaseIterable, Identifiable, Sendable {
	case collection
	case library

	var id: Self { self }
	var title: String {
		switch self {
		case .collection: "This View"
		case .library: "Full Library"
		}
	}
}
