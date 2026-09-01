import SwiftUI
import UniformTypeIdentifiers

struct OPMLImportView: View {
	private static let opmlType = UTType(filenameExtension: "opml") ?? .xml
	@Environment(ReaderAppModel.self) private var model
	@State private var isChoosingFile = false
	@State private var screen = OPMLImportScreenState()
	@State private var isImporting = false

	var body: some View {
		List {
			Section {
				Button("Choose OPML File", systemImage: "doc.badge.plus") { isChoosingFile = true }
				Text("Pigeon previews every feed, skips subscriptions you already have, preserves folder names, and rolls back this import if any new feed fails.")
					.font(.footnote)
					.foregroundStyle(.secondary)
			}
			if let preview = screen.preview {
				Section("Preview") {
					LabeledContent("New feeds", value: preview.newEntries.count.formatted())
					LabeledContent("Already subscribed", value: preview.duplicateCount.formatted())
					LabeledContent("Folder updates", value: preview.folderMerges.count.formatted())
					ForEach(preview.entries) { entry in
						VStack(alignment: .leading, spacing: 4) {
							HStack {
								Text(entry.title)
								Spacer()
								if preview.duplicateIDs.contains(entry.id) {
									Text("Already subscribed").font(.caption).foregroundStyle(.secondary)
								}
							}
							Text(entry.url.absoluteString).font(.caption).foregroundStyle(.secondary).lineLimit(1)
							if entry.folders.isEmpty == false {
								Text(entry.folders.joined(separator: " › ")).font(.caption).foregroundStyle(.secondary)
							}
						}
					}
					Button("Apply Import") {
						importFeeds(preview)
					}
					.disabled((preview.newEntries.isEmpty && preview.folderMerges.isEmpty) || isImporting)
				}
			}
			if let message = screen.message { Section { Text(message).foregroundStyle(.secondary) } }
		}
		.navigationTitle("Import OPML")
		.fileImporter(isPresented: $isChoosingFile, allowedContentTypes: [.xml, Self.opmlType]) { result in
			handleFile(result)
		}
	}

	private func handleFile(_ result: Result<URL, Error>) {
		let dataResult = result.flatMap { url in
			Result {
				let accessed = url.startAccessingSecurityScopedResource()
				defer { if accessed { url.stopAccessingSecurityScopedResource() } }
				return try Data(contentsOf: url)
			}
		}
		screen.apply(OPMLImportPlanner.outcome(of: dataResult, existing: model.subscriptions))
	}

	private func importFeeds(_ preview: OPMLImportPreview) {
		isImporting = true
		Task {
			defer { isImporting = false }
			do {
				let result = try await model.importOPML(preview)
				screen.message = "Imported \(result.importedCount) feed\(result.importedCount == 1 ? "" : "s"), updated folders on \(result.updatedCount), and found \(result.duplicateCount) existing subscription\(result.duplicateCount == 1 ? "" : "s")."
				screen.preview = nil
			} catch {
				screen.message = error.localizedDescription
			}
		}
	}
}
