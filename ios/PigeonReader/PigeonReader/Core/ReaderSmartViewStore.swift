import Foundation

struct ReaderSmartViewStore {
	static let key = "pigeon.reader.smart-views.v1"
	static let configurableSections: [ReaderSection] = [.forYou, .starred, .today]
	static let defaultEnabledSections = Set(configurableSections)

	private let defaults: UserDefaults

	init(defaults: UserDefaults = .standard) {
		self.defaults = defaults
	}

	var enabledSections: Set<ReaderSection> {
		guard let rawValues = defaults.array(forKey: Self.key) as? [String] else {
			return Self.defaultEnabledSections
		}

		let sections = Set(rawValues.compactMap(ReaderSection.init(rawValue:)))
			.intersection(Self.defaultEnabledSections)
		return sections.isEmpty ? Self.defaultEnabledSections : sections
	}

	func setEnabled(_ enabled: Bool, for section: ReaderSection) {
		guard Self.configurableSections.contains(section) else {
			return
		}

		var sections = enabledSections
		if enabled {
			sections.insert(section)
		} else {
			guard sections.count > 1 else {
				return
			}
			sections.remove(section)
		}
		setEnabledSections(sections)
	}

	func setEnabledSections(_ sections: Set<ReaderSection>) {
		let normalized = sections.intersection(Self.defaultEnabledSections)
		let value = normalized.isEmpty ? Self.defaultEnabledSections : normalized
		defaults.set(value.map(\.rawValue).sorted(), forKey: Self.key)
	}
}
