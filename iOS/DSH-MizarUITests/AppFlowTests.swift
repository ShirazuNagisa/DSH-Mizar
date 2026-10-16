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
        dismissNamingIfPresented(app)
        return app
    }

    /// Skip the naming prompt.
    ///
    /// Pairing offers a name once, which is a product feature and not what these
    /// tests are about; a test that leaves it up is a test that measures the
    /// sheet.
    ///
    /// - Parameter app: the launched app.
    private func dismissNamingIfPresented(_ app: XCUIApplication) {
        let skip = app.buttons["rename.skip"]
        if skip.waitForExistence(timeout: 5) { skip.tap() }
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
        // A never-paired phone now says what to do rather than showing an empty
        // list, and offers the scanner directly.
        let unpaired = app.buttons["unpaired.scan"]
        let sessions = app.buttons["sessions.new"]
        let appeared = unpaired.waitForExistence(timeout: Self.patience)
            || sessions.waitForExistence(timeout: Self.patience)
        XCTAssertTrue(appeared, "the app reached neither the pairing screen nor the session list")
    }

    // MARK: - Session detail

    func testOpeningASessionShowsTheComposer() {
        let app = launch()
        let field = app.textFields["composer.field"]
        expect(field, "the composer is missing")

        // One button, two jobs. The running session starts with an empty field,
        // which is the stop case -- the rule DSH uses, and the rule this follows.
        expect(app.buttons["composer.stop"], "a running turn with an empty field does not offer stop")

        // Typing turns it into send, and it is refused while empty -- so the one
        // button cannot be tapped into a no-op.
        field.tap()
        field.typeText("hello")
        let send = app.buttons["composer.send"]
        expect(send, "typing did not turn the button into send")
        XCTAssertTrue(send.isEnabled, "send is disabled with text in the field")
    }

    /// The three figures above the field, each of which is a control.
    func testTheComposerBarShowsTheModelContextAndCommands() {
        let app = launch()
        expect(app.buttons["composer.model"], "the model is not shown above the composer")
        expect(app.buttons["composer.context"], "the context figure is not shown above the composer")
        expect(app.buttons["composer.commands"], "the command button is not shown above the composer")

        // The figure is the host's number, not a placeholder. Asserted on the
        // button's label: setting one makes the button a single accessibility
        // element, so its inner Text is not a queryable child.
        XCTAssertTrue(
            app.buttons["composer.context"].label.contains("35"),
            "the context percentage is not the host's: \(app.buttons["composer.context"].label)",
        )
    }

    /// Open every folded turn, so the steps inside can be asserted on.
    ///
    /// A turn's steps are folded behind a summary by default -- one prompt that
    /// took eleven steps read as the model talking to itself -- so a test that
    /// looks for a step has to open the turn it is in first.
    ///
    /// - Parameter app: the running app.
    private func expandTurns(_ app: XCUIApplication) {
        var guardCount = 0
        while guardCount < 20 {
            let summary = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'turn.summary.'"))
                .firstMatch
            guard summary.exists, summary.isHittable else { break }
            summary.tap()
            guardCount += 1
        }
    }

    func testTheConversationRendersMessagesAndAFailedTurn() {
        let app = launch()
        expect(app.staticTexts["Refactor the parser and run the tests."], "the user's message is missing")
        // The prompt is never folded: it is what the operator typed. The steps
        // are, so they have to be opened.
        expandTurns(app)
        // Streamed deltas have to be joined into one bubble, not shown per chunk.
        expect(
            app.staticTexts["I split the tokenizer out of the parser so it can be tested alone."],
            "the assistant's streamed text was not joined",
        )
        // A turn that produced nothing is the one state where the agent looks
        // busy and is doing nothing, so it has to be visible.
        expect(app.staticTexts["The turn ended without a response"], "a failed turn was not surfaced")
    }

    /// The context figure opens the breakdown it is computed from.
    ///
    /// This replaces a test for a Usage *tab*. The tab is gone: the figure lives
    /// above the field now, so the detail is one tap from the conversation
    /// instead of a screen swap away from it.
    func testTheContextFigureOpensItsBreakdown() {
        let app = launch()
        let context = app.buttons["composer.context"]
        expect(context, "the context figure is missing")
        XCTAssertTrue(
            context.label.contains("35"),
            "the context percentage is not the host's: \(context.label)",
        )
        context.tap()

        // The window and the composition come from the host's frame, so their
        // being on screen is what proves the popover is wired to it.
        expect(app.staticTexts["Window"], "the window size is not in the breakdown")
        expect(app.staticTexts["Pressure"], "the pressure figure is not in the breakdown")
        expect(app.staticTexts["Messages"], "the token breakdown is not in the popover")
    }

    /// The command button puts a command in the field rather than sending it.
    func testTheCommandButtonDraftsACommand() {
        let app = launch()
        let commands = app.buttons["composer.commands"]
        expect(commands, "the command button is missing")
        commands.tap()

        let goal = app.buttons["command.goal"]
        expect(goal, "the command list did not open")
        goal.tap()

        // Did the action run at all? The list closes only from inside the
        // button, so a list still on screen means the tap never reached it --
        // which is a different fault from a command that ran and was lost.
        let closed = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in !goal.exists },
            object: nil,
        )
        let outcome = XCTWaiter().wait(for: [closed], timeout: 5)
        XCTAssertEqual(outcome, .completed, "the tap did not reach the command row")

        // Drafted, not sent: a goal needs text after the slash, and firing it
        // blank would send the agent an empty instruction.
        let field = app.textFields["composer.field"]
        expect(field, "the composer is missing")
        // Polled rather than read once: the sheet leaves with an animation and
        // the field is not updated until it has gone, so a single read races it
        // and reports the placeholder as if nothing had been drafted.
        let drafted = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in (field.value as? String) == "/goal " },
            object: nil,
        )
        _ = XCTWaiter().wait(for: [drafted], timeout: 10)
        XCTAssertEqual(field.value as? String, "/goal ", "the command was not drafted into the field")
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

    func testASentMessageAppearsInTheConversation() {
        // The half of the loop nothing checked: sending is not the same as the
        // message showing up. Before this, it did not -- the app never reloaded
        // the conversation after a send, so the operator's own words were absent
        // until a pull-to-refresh.
        let app = launch()
        let field = app.textFields["composer.field"]
        expect(field, "the composer is missing")
        field.tap()
        field.typeText("does this reach the agent")

        let send = app.buttons["composer.send"]
        expect(send, "there is no way to send")
        XCTAssertTrue(send.isEnabled, "send stayed disabled with text in the field")
        send.tap()

        // The composer must have emptied, or the text being found proves nothing:
        // a query for static text also matches a field still holding the words,
        // which is exactly how an earlier version of this test passed with the
        // reload removed.
        // Found is not enough, and a plain subscript is not even usable: SwiftUI
        // leaves the typed text in the accessibility tree after the field clears,
        // so several elements carry this label. The first two versions of this
        // test passed with the reload removed for exactly that reason -- the
        // words were real, they were just still sitting where they had been
        // typed. A conversation bubble is the one above the composer.
        // First: did the send succeed? The composer clears only on success and is
        // refilled on failure, so its value says which branch ran -- and the two
        // produce the same visible symptom ("the text is still here").
        let composerField = app.textFields["composer.field"]
        expect(composerField, "the composer vanished")
        XCTAssertEqual(
            composerField.value as? String,
            "Ask your agent…",
            "the composer still holds the text, so the send did not succeed",
        )

        // Scroll until it is actually on screen. The conversation is longer than
        // the display and a new message lands at the bottom of it, so its frame
        // sits below the composer until scrolled into view -- which reads
        // identically to the message being absent. A fixed number of swipes is a
        // guess about how long the conversation is.
        let composer = app.textFields["composer.field"]
        // By label, not by identifier. `matching(identifier:)` reads the
        // accessibility *identifier*, and a message bubble sets its text as the
        // accessibility *label* -- so this query matched nothing, ever, and the
        // failure said "0 elements carry the text" while the text was on screen.
        let candidates = app.staticTexts.matching(
            NSPredicate(format: "label == %@", "does this reach the agent"),
        )
        var inConversation: XCUIElement?
        for _ in 0..<8 {
            inConversation = (0..<candidates.count)
                .map { candidates.element(boundBy: $0) }
                .first { $0.frame.maxY < composer.frame.minY }
            if inConversation != nil { break }
            app.swipeUp()
        }
        XCTAssertNotNil(
            inConversation,
            "the message never reached the conversation (\(candidates.count) elements carry the text, none above the composer)",
        )
        XCTAssertEqual(composer.value as? String, "Ask your agent…", "the composer never emptied")
    }

    // MARK: - Model and permission switching

    func testTheModelPickerListsTheHostsProviders() {
        let app = launch()
        let opener = app.buttons["composer.model"]
        expect(opener, "there is no way to change the model")
        opener.tap()

        // Rows are buttons, not static text: the row carries an identifier, and
        // an identifier makes the row one accessibility element with its label
        // and description merged, so the inner Text is not separately visible.
        expect(app.buttons["model.row.deepseek-flash"], "the first model is missing")
        expect(app.buttons["model.row.deepseek-v4-pro"], "the second model is missing")
        // The provider heading is a standalone element, so it is still text.
        expect(app.staticTexts["DeepSeek"], "the provider is missing from the picker")

        // A provider that could not be listed is shown rather than hidden: its
        // models being absent is information. It sits below the models.
        app.swipeUp()
        expect(app.staticTexts["OpenRouter"], "an unavailable provider was hidden")
    }

    func testChoosingAModelRevealsItsReasoningLevels() {
        let app = launch()
        app.buttons["composer.model"].tap()
        let model = app.buttons["model.row.deepseek-flash"]
        expect(model, "the model row is missing")
        model.tap()
        // The four levels the host actually offers. The picker must not invent
        // its own, and must not offer a level the model rejects.
        expect(app.buttons["Off"], "the reasoning levels were not revealed")
        expect(app.buttons["Max"], "the highest reasoning level is missing")
    }

    func testThePermissionPickerWarnsBeforeFullAccess() {
        let app = launch()
        let opener = app.buttons["session.permissions"]
        expect(opener, "there is no way to change the permission preset")
        opener.tap()
        expect(app.buttons["permission.row.workspace-write"], "the presets are missing")

        // Only full access asks twice. A preset that grants unrestricted access
        // to the machine should not be one tap away.
        app.buttons["permission.row.danger-full-access"].tap()
        expect(app.staticTexts["Allow full access?"], "full access was granted without confirmation")
    }

    // MARK: - Localisation

    func testInterfaceFollowsTheLanguageAndContentDoesNot() {
        let chinese = launch(language: "zh-Hans")
        expect(chinese.staticTexts["本轮没有产生回复"], "the failure card did not translate")
        // The composer's placeholder, which is interface copy. This used to
        // assert on the "对话" segmented control; that control is gone, and the
        // placeholder is the localised string nearest the same place on screen.
        XCTAssertEqual(
            chinese.textFields["composer.field"].value as? String,
            "给 agent 发消息…",
            "the interface did not follow Chinese",
        )
        // Message content is data from the session, not interface copy.
        expect(
            chinese.staticTexts["Refactor the parser and run the tests."],
            "message content was translated",
        )
        chinese.terminate()

        let english = launch(language: "en")
        expandTurns(english)
        expect(english.staticTexts["The turn ended without a response"], "the failure card did not translate")
        XCTAssertEqual(
            english.textFields["composer.field"].value as? String,
            "Ask your agent…",
            "the interface did not follow English",
        )
    }
}
