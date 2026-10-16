//
//  Permissions.swift
//  DSH-Mizar
//
//  The two things iOS will not let this app do without being asked first.
//
//  Deliberately asked at launch and not at the moment of use. Both of them are
//  needed for the app to do anything at all -- a phone that cannot be notified
//  is a phone the operator has to keep opening, and one that cannot reach the
//  local network cannot pair over Wi-Fi -- and a system alert that arrives while
//  somebody is halfway through scanning a code reads as the app failing.
//
//  The camera is *not* here, and that is the point of the file. It is needed
//  only to scan a pairing code, and iOS asks for it at that moment. Asking at
//  launch for a permission most sessions never use is how an app teaches people
//  to tap "Don't Allow" without reading.
//

import Foundation
import Network
import UIKit
import UserNotifications

/// The system prompts this app asks for.
enum Permissions {
    /// Ask to be allowed to post notifications, and wait for the answer.
    ///
    /// Awaited rather than fired: two system alerts requesting attention at once
    /// is one alert the operator dismisses by reflex, and the answer to a
    /// notification prompt is not knowable from this side until it comes back.
    static func requestNotifications() async {
        do {
            _ = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .badge, .sound])
        } catch {
            // The refusal is indistinguishable from a failure here, and neither
            // is actionable at launch: the app works without notifications, and
            // the operator can change their mind in iOS Settings.
        }
    }

    /// Make iOS ask about the local network, and keep the ask alive to be answered.
    ///
    /// There is no API to request this one. iOS raises the prompt the first time
    /// an app tries to use the local network, and for a browse that means the
    /// browse has to be *running* while the operator reads the alert -- cancel
    /// it immediately and the alert goes with it, unanswered, and the permission
    /// is then denied by default.
    ///
    /// So this browses for the service type the plugin would advertise, waits
    /// long enough for somebody to tap, and cancels. Nothing is connected to and
    /// nothing is discovered: the browse exists to raise the question.
    ///
    /// A refusal is survivable and deliberately not fatal -- the relay route
    /// does not need the local network at all, which is exactly why the app has
    /// two routes.
    static func requestLocalNetwork() async {
        let browser = NWBrowser(for: .bonjour(type: bonjourType, domain: nil), using: .tcp)
        browser.start(queue: .main)

        // Waits for the *answer*, not for a clock. Four seconds was the first
        // version and it was wrong in the way this file's own reasoning predicts:
        // cancelling the browse takes the alert with it, unanswered, and an
        // unanswered local-network prompt is a denial by default. An operator who
        // reads the alert -- the frightening one, the one worth reading -- takes
        // longer than that.
        //
        // The two states that mean the question has been settled are `ready`
        // (allowed: the browse is running) and `failed` (refused). `waiting` is
        // not one of them: it is what a browse does while it has nothing to
        // report, and it is also what it does before the operator has tapped
        // anything at all.
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            switch browser.state {
            case .ready, .failed, .cancelled: browser.cancel(); return
            default: break
            }
            do {
                try await Task.sleep(for: .milliseconds(400))
            } catch {
                // Cancelled: the app is going away and there is nothing left to
                // ask. The alert, if it is still up, is the system's to settle.
                browser.cancel()
                return
            }
        }
        browser.cancel()
    }

    /// Ask Apple for a device token.
    ///
    /// Separate from the permission prompt and after it: this is what actually
    /// subscribes the app to APNs, and it is refused -- silently, on a device
    /// -- when the app has no notification permission or no `aps-environment`
    /// entitlement. The token arrives at the application delegate, not here.
    ///
    /// `@MainActor` because `UIApplication.shared` is: the whole call is one
    /// jump to the main queue and one call back out.
    @MainActor
    static func registerForRemoteNotifications() {
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// The Bonjour service type the browse is for.
    ///
    /// The same string the Info.plist declares under `NSBonjourServices`: a
    /// browse for an undeclared type is a browse iOS answers with silence.
    static let bonjourType = "_mizar._tcp"
}
