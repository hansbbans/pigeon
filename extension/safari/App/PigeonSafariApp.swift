import AppKit
import SafariServices
import SwiftUI

/// The container app Safari needs to load the extension. It only shows
/// whether the extension is on and opens Safari's Extensions settings.
@main
struct PigeonSafariApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Window("Save to Pigeon", id: "main") {
            ContentView()
        }
        .windowResizability(.contentSize)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

/// The embedded .appex (project.yml: the app's id plus `.extension`).
let extensionIdentifier = (Bundle.main.bundleIdentifier ?? "com.hans.pigeon.safari") + ".extension"

enum ExtensionState: Equatable {
    case unknown
    case enabled
    case disabled
    case failed(String)
}

struct ContentView: View {
    @State private var state: ExtensionState = .unknown
    @State private var openError: String?

    var body: some View {
        VStack(spacing: 14) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 64, height: 64)
            Text("Save to Pigeon")
                .font(.title2.weight(.semibold))
            Text(message)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button("Quit and Open Safari Extensions Settings…", action: openSafariSettings)
                .keyboardShortcut(.defaultAction)
            if let openError {
                Text(openError)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        .padding(28)
        .frame(width: 380)
        .task { await refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await refresh() }
        }
    }

    private var message: String {
        switch state {
        case .unknown:
            "Checking whether the extension is on…"
        case .enabled:
            "The extension is on. Save pages with the toolbar button, Option-Shift-S, or the right-click menu."
        case .disabled:
            "The extension is off. Turn on Save to Pigeon in Safari > Settings > Extensions, then sign in on its settings page."
        case let .failed(reason):
            "Safari did not report the extension's state (\(reason)). Unsigned builds need Develop > Allow Unsigned Extensions in Safari."
        }
    }

    private func refresh() async {
        state = await safariExtensionState()
    }

    private func openSafariSettings() {
        openError = nil
        Task {
            if let error = await showSafariExtensionSettings() {
                openError = "Could not open Safari's settings: \(error)"
            } else {
                NSApp.terminate(nil)
            }
        }
    }
}

// The SDK marks getStateOfSafariExtension's completion handler as main-actor,
// but Safari calls it on an XPC queue, so a handler closure traps under Swift 6
// isolation checks. The async forms resume a continuation instead, on any queue.

func safariExtensionState() async -> ExtensionState {
    do {
        return try await SFSafariExtensionManager.stateOfSafariExtension(withIdentifier: extensionIdentifier).isEnabled ? .enabled : .disabled
    } catch {
        return .failed(error.localizedDescription)
    }
}

/// Opens Safari's Extensions settings with Save to Pigeon selected; returns an error message, or nil.
func showSafariExtensionSettings() async -> String? {
    do {
        try await SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionIdentifier)
        return nil
    } catch {
        return error.localizedDescription
    }
}
