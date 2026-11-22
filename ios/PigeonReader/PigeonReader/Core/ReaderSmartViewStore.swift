import Foundation

struct ReaderSmartViewStore {
	static let key = "pigeon.reader.smart-views.v1"
	private static let unreadMigrationKey = "pigeon.reader.smart-views.unread-migrated.v1"
	private static let lastSevenDaysMigrationKey = "pigeon.reader.smart-views.last-7-days-migrated.v1"
	static let configurableSections: [ReaderSection] = [.forYou, .unread, .starred, .today, .lastSevenDays]
	static let defaultEnabledSections = Set(configurableSections)

	private let defaults: UserDefaults

	init(defaults: UserDefaults = .standard) {
		self.defaults = defaults
		migrateLegacyPreferencesIfNeeded()
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
		defaults.set(true, forKey: Self.unreadMigrationKey)
		defaults.set(true, forKey: Self.lastSevenDaysMigrationKey)
	}

	private func migrateLegacyPreferencesIfNeeded() {
		addSectionOnce(.unread, migrationKey: Self.unreadMigrationKey)
		addSectionOnce(.lastSevenDays, migrationKey: Self.lastSevenDaysMigrationKey)
	}

	/// Settings saved before `section` existed gain it once. A later choice to
	/// turn it off marks the migration done, so it is not added back.
	private func addSectionOnce(_ section: ReaderSection, migrationKey: String) {
		guard defaults.object(forKey: Self.key) != nil,
			defaults.bool(forKey: migrationKey) == false else {
			return
		}

		let storedSections = Set((defaults.array(forKey: Self.key) as? [String] ?? []).compactMap(ReaderSection.init(rawValue:)))
		let migratedSections = storedSections.isEmpty
			? Self.defaultEnabledSections
			: storedSections.union([section]).intersection(Self.defaultEnabledSections)
		defaults.set(migratedSections.map(\.rawValue).sorted(), forKey: Self.key)
		defaults.set(true, forKey: migrationKey)
	}
}
