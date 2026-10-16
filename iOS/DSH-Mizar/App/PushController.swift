//
//  PushController.swift
//  DSH-Mizar
//
//  This phone's end of a notification.
//
//  Three things, and each is somewhere SwiftUI has no hook:
//
//    1. **The device token.** iOS hands it to the `UIApplicationDelegate` and
//       nowhere else, so an adaptor is the only way to get one at all.
//    2. **What a notification looks like while the app is open.** Without a
//       `UNUserNotificationCenterDelegate`, iOS shows nothing at all for a
//       notification that arrives in the foreground -- so an approval asked for
//       while the operator is reading a different session would be silently
//       swallowed.
//    3. **What a tap does.** A notification that opens the app and leaves the
//       operator on the session list is a notification that wasted a tap.
//

import Foundation
import UIKit
import UserNotifications

/// The application delegate, for the parts SwiftUI cannot reach.
final class PushAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    /// Posted when iOS issues a device token, with the token as the object.
    static let tokenReceived = Notification.Name("mizar.push.token")

    /// Posted when the operator taps a notification, with the session id.
    static let openSession = Notification.Name("mizar.push.open")

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil,
    ) -> Bool {
        // Before anything can arrive. iOS does not queue a foreground
        // notification for a delegate that is set later.
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data,
    ) {
        // Lowercase hex, which is what APNs and the relay both expect. `%02x`
        // over the bytes, not `description` over the `Data`: the latter gives
        // "<0a1b2c…>", which is not a token.
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        PushRegistration.storedToken = token
        NotificationCenter.default.post(name: Self.tokenReceived, object: token)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error,
    ) {
        // Deliberately quiet. The two ways this fails are a simulator without a
        // push-capable runtime and a device whose provisioning profile has no
        // `aps-environment` entitlement, and neither is something the operator
        // can act on from a phone -- but both are worth a line in the device
        // log, which is where a "why is it silent" question gets answered.
        NSLog("[mizar] remote notifications unavailable: %@", String(describing: error))
    }

    /// Show a notification that arrives while the app is open.
    ///
    /// Without this, iOS shows nothing for a foreground notification. The plugin
    /// declines to send while the app reports itself in the foreground, which
    /// covers most of it -- but the report is a round trip, and an approval
    /// asked for in the second between the app opening and the Mac hearing about
    /// it would otherwise vanish.
    ///
    /// `nonisolated` on both of these, and that is not decoration: the protocol
    /// declares them without isolation while this class is main-actor-isolated
    /// by `UIApplicationDelegate`, and Swift 6 will not send a non-`Sendable`
    /// `UNNotification` across that boundary. Nothing here touches this class's
    /// state, so there is nothing to isolate -- and only a `String` crosses back.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    /// Open the session the notification was about.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
    ) async {
        let sessionId = response.notification.request.content.userInfo["sessionId"] as? String
        guard let sessionId, !sessionId.isEmpty else { return }
        await MainActor.run {
            NotificationCenter.default.post(name: Self.openSession, object: sessionId)
        }
    }
}

/// What this phone has told the host about itself.
enum PushRegistration {
    /// Where the token is kept.
    ///
    /// `UserDefaults`, not the Keychain: a device token is not a secret -- it is
    /// an address Apple issued to this install, useless without the provider key
    /// that signs for it -- and the Keychain survives a reinstall, which would
    /// leave a token that no longer exists being re-registered forever.
    private static let tokenKey = "mizar.pushToken"

    static var storedToken: String? {
        get { UserDefaults.standard.string(forKey: tokenKey) }
        set {
            if let newValue { UserDefaults.standard.set(newValue, forKey: tokenKey) }
            else { UserDefaults.standard.removeObject(forKey: tokenKey) }
        }
    }

    /// Which APNs service issued this build's tokens.
    ///
    /// Debug builds are signed with a development profile and get sandbox
    /// tokens; a release build gets production ones. The two services do not
    /// accept each other's tokens, and the relay has to be told which one to
    /// talk to -- see `docs/relay-deployment.md` §10.2.
    static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    /// The language to write notifications in.
    ///
    /// The first preferred language, which is what the app's own interface is
    /// already following -- a notification in a different language from the
    /// screen it opens is worse than either.
    static var locale: String {
        Locale.preferredLanguages.first ?? "en"
    }
}
