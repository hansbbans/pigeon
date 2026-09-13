import Foundation
import Testing
@testable import PigeonReader

struct YouTubeVideoTests {
	@Test
	func acceptsCanonicalWatchAndShortVideoURLs() throws {
		let watch = try #require(URL(string: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
		let short = try #require(URL(string: "https://youtu.be/dQw4w9WgXcQ?t=42"))

		#expect(YouTubeVideo(url: watch)?.videoID == "dQw4w9WgXcQ")
		#expect(YouTubeVideo(url: short)?.videoID == "dQw4w9WgXcQ")
	}

	@Test
	func acceptsMobileAndVideoPathVariants() throws {
		let mobile = try #require(URL(string: "https://m.youtube.com/watch?feature=share&v=9bZkp7q19f0"))
		let shorts = try #require(URL(string: "https://www.youtube.com/shorts/9bZkp7q19f0"))
		let live = try #require(URL(string: "https://youtube.com/live/9bZkp7q19f0"))

		#expect(YouTubeVideo(url: mobile)?.videoID == "9bZkp7q19f0")
		#expect(YouTubeVideo(url: shorts)?.videoID == "9bZkp7q19f0")
		#expect(YouTubeVideo(url: live)?.videoID == "9bZkp7q19f0")
	}

	@Test
	func rejectsChannelsPlaylistsAndNonVideoYouTubePages() throws {
		let urls = [
			"https://www.youtube.com/@creator",
			"https://www.youtube.com/channel/UC1234567890",
			"https://www.youtube.com/playlist?list=PL1234567890",
			"https://www.youtube.com/watch",
			"https://www.youtube.com/watch?v=too-short",
		]

		for rawURL in urls {
			let url = try #require(URL(string: rawURL))
			#expect(YouTubeVideo(url: url) == nil, "Expected no video ID for \(rawURL)")
		}
	}

	@Test
	func rejectsLookalikeHostsCredentialsAndPorts() throws {
		let urls = [
			"https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
			"https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
			"https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ",
			"https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ",
			"https://www.yоutube.com/watch?v=dQw4w9WgXcQ",
		]

		for rawURL in urls {
			let url = try #require(URL(string: rawURL))
			#expect(YouTubeVideo(url: url) == nil, "Expected unsafe URL to be rejected: \(rawURL)")
		}
	}

	@Test
	func producesHttpsOfficialPlayerURLs() throws {
		let url = try #require(URL(string: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
		let video = try #require(YouTubeVideo(url: url))

		#expect(video.watchURL.absoluteString == "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
		#expect(video.embedURL.absoluteString == "https://www.youtube.com/embed/dQw4w9WgXcQ")
	}
}
