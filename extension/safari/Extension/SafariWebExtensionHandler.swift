import Foundation

/// Safari requires a principal class for a web extension's .appex. Save to
/// Pigeon uses no native messaging (the manifest has no `nativeMessaging`
/// permission), so any request is answered empty instead of left hanging.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        context.completeRequest(returningItems: [], completionHandler: nil)
    }
}
