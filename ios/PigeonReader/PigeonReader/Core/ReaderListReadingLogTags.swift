import Foundation

/// The reading log's tags for a Reeder list: `section` for each story in a
/// sectioned list (the section that shows it first) and `row = compact` for a
/// read story drawn on one line, as the web app logs them.
nonisolated struct ReaderListReadingLogTags: Equatable, Sendable {
	let rows: [String: String]
	let sections: [String: String]

	init(sections folder: FolderSections?, articles: [Recommendation], isCompact: (Recommendation) -> Bool) {
		var rows: [String: String] = [:]
		for article in folder?.renderedArticles ?? articles where isCompact(article) {
			rows[article.id] = "compact"
		}
		self.rows = rows
		guard let folder else {
			self.sections = [:]
			return
		}
		let kinds = Dictionary(folder.sections.map { ($0.id, $0.kind) }, uniquingKeysWith: { first, _ in first })
		self.sections = folder.firstSectionIDs.compactMapValues { kinds[$0]?.readingLogSection }
	}
}
