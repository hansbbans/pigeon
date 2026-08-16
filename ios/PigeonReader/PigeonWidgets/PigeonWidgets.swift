import SwiftUI
import WidgetKit

struct PigeonTimelineEntry: TimelineEntry {
	let date: Date
	let snapshot: PigeonWidgetSnapshot
}

struct PigeonTimelineProvider: TimelineProvider {
	func placeholder(in context: Context) -> PigeonTimelineEntry {
		PigeonTimelineEntry(date: .now, snapshot: .empty)
	}

	func getSnapshot(in context: Context, completion: @escaping (PigeonTimelineEntry) -> Void) {
		completion(PigeonTimelineEntry(date: .now, snapshot: PigeonWidgetSnapshot.load()))
	}

	func getTimeline(in context: Context, completion: @escaping (Timeline<PigeonTimelineEntry>) -> Void) {
		let entry = PigeonTimelineEntry(date: .now, snapshot: PigeonWidgetSnapshot.load())
		completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(30 * 60))))
	}
}

struct PigeonCountsWidget: Widget {
	let kind = "PigeonCountsWidget"
	var body: some WidgetConfiguration {
		StaticConfiguration(kind: kind, provider: PigeonTimelineProvider()) { entry in
			PigeonCountsView(entry: entry)
				.containerBackground(.fill.tertiary, for: .widget)
		}
		.configurationDisplayName("Pigeon Counts")
		.description("Unread and starred totals at a glance.")
		.supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular, .accessoryInline])
	}
}

struct PigeonCountsView: View {
	@Environment(\.widgetFamily) private var family
	let entry: PigeonTimelineEntry

	var body: some View {
		switch family {
		case .accessoryInline:
			Text("\(entry.snapshot.unreadCount) unread · \(entry.snapshot.starredCount) starred")
		case .accessoryCircular:
			Gauge(value: Double(entry.snapshot.unreadCount), in: 0...Double(max(entry.snapshot.unreadCount, 1))) {
				Image(systemName: "newspaper")
			} currentValueLabel: {
				Text(entry.snapshot.unreadCount.formatted())
			}
			.gaugeStyle(.accessoryCircularCapacity)
		default:
			VStack(alignment: .leading, spacing: 8) {
				Label("Pigeon", systemImage: "newspaper.fill").font(.headline)
				Text(entry.snapshot.unreadCount.formatted()).font(.system(.largeTitle, design: .rounded, weight: .bold))
				Text("Unread · \(entry.snapshot.starredCount) starred").font(.caption).foregroundStyle(.secondary)
			}
			.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
		}
	}
}

struct PigeonRecentWidget: Widget {
	var body: some WidgetConfiguration {
		StaticConfiguration(kind: "PigeonRecentWidget", provider: PigeonTimelineProvider()) { entry in
			PigeonArticleWidgetView(entry: entry, title: "Recent", usesForYou: false)
				.containerBackground(.fill.tertiary, for: .widget)
		}
		.configurationDisplayName("Recent")
		.description("Your newest saved articles.")
		.supportedFamilies([.systemMedium, .systemLarge, .accessoryRectangular])
	}
}

struct PigeonForYouWidget: Widget {
	var body: some WidgetConfiguration {
		StaticConfiguration(kind: "PigeonForYouWidget", provider: PigeonTimelineProvider()) { entry in
			PigeonArticleWidgetView(entry: entry, title: "For You", usesForYou: true)
				.containerBackground(.fill.tertiary, for: .widget)
		}
		.configurationDisplayName("For You")
		.description("Recommendations selected for you.")
		.supportedFamilies([.systemMedium, .systemLarge, .accessoryRectangular])
	}
}

struct PigeonArticleWidgetView: View {
	@Environment(\.widgetFamily) private var family
	let entry: PigeonTimelineEntry
	let title: String
	let usesForYou: Bool

	private var articles: [PigeonWidgetArticle] {
		usesForYou ? entry.snapshot.forYou : entry.snapshot.recent
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 7) {
			Label(title, systemImage: usesForYou ? "sparkles" : "clock")
				.font(.headline)
			ForEach(articles.prefix(family == .systemLarge ? 5 : family == .systemMedium ? 3 : 1)) { article in
				Link(destination: article.deepLink) {
					VStack(alignment: .leading, spacing: 1) {
						Text(article.title).font(.caption.weight(.semibold)).lineLimit(1)
						Text(article.source).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
					}
				}
			}
			if articles.isEmpty { Text("Open Pigeon to refresh").font(.caption).foregroundStyle(.secondary) }
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
	}
}

@main
struct PigeonWidgetBundle: WidgetBundle {
	var body: some Widget {
		PigeonCountsWidget()
		PigeonRecentWidget()
		PigeonForYouWidget()
	}
}
