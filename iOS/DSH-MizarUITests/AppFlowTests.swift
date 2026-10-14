//
//  AppFlowTests.swift
//  DSH-MizarUITests
//
//  Regression cover for the screens that were, until now, verified by taking a
//  screenshot and looking at it.
//
//  That is not a rhetorical complaint. Adding localisation produced three
//  screenshots showing English strings while the bundle on disk already had the
//  Chinese ones, because `simctl install` had left the previous binary running.
//  Manual verification reported a failure that did not exist. These tests exist
//  so the next one of those is caught by a machine.
//
//  They run against `scripts/mock-host.mjs`, which serves the real protocol with
//  record shapes taken from a live host. A pending approval only exists while an
//  agent is blocked on a tool call, so the real host cannot be asked to produce
//  one on demand -- and on this machine it cannot produce one at all, because
//  every turn ends in MISSING_CREDENTIAL before reaching a tool.
//
//  Elements are found by accessibility identifier, never by label: a query for
//  "Allow once" passes only in English, and the title not being a stable name is
//  the entire point of the localisation work.
//

import XCTest

final class AppFlowTests: XCTestCase {
    /// The mock host, which must be running before this suite is.
    private static let mockPairingURI =
        "mizar://pair?h=127.0.0.1%3A19395&c=MOCK-CODE&n=Mock%20Mac&v=1"

    /// How long to wait for the host to answer.
    private static let patience: TimeInterval = 20

    override func setUp() {
        continueAfterFailure = false
    }

    /// Launch the app, optionally pairing and opening a session on the way in.
    /// - Parameters:
    ///   - pairing: whether to pass a pairing URI.
    ///   - session: a session to open, or `nil` to stay on the list.
    ///   - language: a language to force, or `nil` to follow the system.
    /// - Returns: the running application.
    private func launch(
        pairing: Bool = true,
        session: String? = "first",
        language: String? = "en",
    ) -> XCUIApplication {
        let app = XCUIApplication()
        var arguments: [String] = []
        if pairing { arguments += ["-mizarPairURI", Self.mockPairingURI] }
        if let session { arguments += ["-mizarSelectSession", session] }
        if let language { arguments += ["-AppleLanguages", "(\(language))"] }
        app.launchArguments = arguments
        app.launch()
        return app
    }

    /// Wait for an element to exist.
    /// - Parameters:
    ///   - element: the element.
    ///   - message: what to say when it never appears.
    private func expect(_ element: XCUIElement, _ message: String) {
        XCTAssertTrue(
            element.waitForExistence(timeout: Self.patience),
            "\(message) (waited \(Self.patience)s)",
        )
    }

    // MARK: - Sessions

    func testSessionListNamesTheHostAndOffersANewSession() {
        let app = launch(session: nil)
        expect(app.staticTexts["Mock Mac (fixture)"], "the host's name is not shown")
        expect(app.buttons["sessions.new"], "there is no way to start a session")
        expect(app.buttons["sessions.refresh"], "there is no way to refresh")
        // The row is titled by its directory, which is what tells two sessions
        // apart when neither has a title yet.
        expect(app.staticTexts["demo"], "the session row is missing")
    }

    func testAnUnpairedLaunchOffersPairing() {
        let app = launch(pairing: false, session: nil)
        // A launch without a pairing URI either finds one stored from an earlier
        // launch and connects, or has none and shows the pairing screen. Both are
        // correct; what must not happen is neither.
        let pairing = app.staticTexts["Connect to DSH"]
        let sessions = app.buttons["sessions.new"]
        let appeared = pairing.waitForExistence(timeout: Self.patience)
            || sessions.waitForExistence(timeout: Self.patience)
        XCTAssertTrue(appeared, "the app reached neither the pairing screen nor the session list")
    }

    // MARK: - Session detail

    func testOpeningASessionShowsTheComposer() {
        let app = launch()
        expect(app.textFields["composer.field"], "the composer is missing")
        expect(app.buttons["composer.stop"], "there is no way to stop a turn")
        expect(app.buttons["composer.send"], "there is no way to send")
        // Sending is refused until there is something to send.
        XCTAssertFalse(app.buttons["composer.send"].isEnabled, "send is enabled while empty")
    }

    func testTheConversationRendersMessagesAndAFailedTurn() {
        let app = launch()
        expect(app.staticTexts["Refactor the parser and run the tests."], "the user's message is missing")
        // Streamed deltas have to be joined into one bubble, not shown per chunk.
        expect(
            app.staticTexts["I split the tokenizer out of the parser so it can be tested alone."],
            "the assistant's streamed text was not joined",
        )
        // A turn that produced nothing is the one state where the agent looks
        // busy and is doing nothing, so it has to be visible.
        expect(app.staticTexts["The turn ended without a response"], "a failed turn was not surfaced")
    }

    func testTheUsageTabShowsTheCounters() {
        let app = launch()
        let usage = app.buttons["Usage"]
        expect(usage, "the usage tab is missing")
        usage.tap()
        expect(app.staticTexts["Tokens"], "the token card is missing")
        expect(app.staticTexts["12,480"], "the host's input count is not shown")
        // The rows below the fold are not in the accessibility tree until they
        // are scrolled into it, so asserting on them without this reads exactly
        // like the value being wrong.
        app.swipeUp()
        expect(app.staticTexts["Cache hit"], "the cache hit rate is missing")
        expect(app.staticTexts["92%"], "the cache hit rate is not the host's value")
        expect(app.staticTexts["Context"], "the context card is missing")
    }

    // MARK: - Interactions

    func testAPendingApprovalOffersExactlyTwoOutcomes() {
        let app = launch()
        expect(app.buttons["approval.allowOnce"], "there is no way to allow")
        expect(app.buttons["approval.reject"], "there is no way to reject")
        // There is deliberately no "always allow": a grant that outlives the
        // request it was given for is a permission change, and those belong in
        // the permission picker where they are visible and reversible.
        XCTAssertEqual(
            app.buttons.matching(identifier: "approval.allowAlways").count,
            0,
            "an unconditional grant appeared",
        )
    }

    func testAQuestionBatchIsRefusedUntilItIsComplete() {
        let app = launch()
        let submit = app.buttons["question.submit"]
        expect(submit, "the submit button is missing")
        // The batch has a single-option question, which is pre-selected, and a
        // multi-option one, which is not. Submitting half a batch would leave
        // the agent waiting on the rest.
        XCTAssertFalse(submit.isEnabled, "an incomplete batch could be submitted")
        // The option's button label includes its description, so the visible
        // text is the stable handle.
        app.staticTexts["Migrate in place"].tap()
        XCTAssertTrue(submit.isEnabled, "the batch could not be completed")
    }

    // MARK: - Localisation

    func testInterfaceFollowsTheLanguageAndContentDoesNot() {
        let chinese = launch(language: "zh-Hans")
        expect(chinese.staticTexts["本轮没有产生回复"], "the failure card did not translate")
        expect(chinese.buttons["对话"], "the interface did not follow Chinese")
        // Message content is data from the session, not interface copy.
        expect(
            chinese.staticTexts["Refactor the parser and run the tests."],
            "message content was translated",
        )
        chinese.terminate()

        let english = launch(language: "en")
        expect(english.staticTexts["The turn ended without a response"], "the failure card did not translate")
        expect(english.buttons["Conversation"], "the interface did not follow English")
    }
}
