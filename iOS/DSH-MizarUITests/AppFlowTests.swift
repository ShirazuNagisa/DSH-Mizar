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

    /// Put the mock host's conversation back to its fixture.
    ///
    /// The mock remembers what has been sent to it -- that is what makes the send
    /// path testable at all -- but it remembered it for the life of the process,
    /// which is the whole suite. Every test after the first send ran against a
    /// longer conversation than the one before it, so a test that scrolled to
    /// find a message found a different amount of content depending on which
    /// tests had run first. A suite whose failures depend on test order is a
    /// suite whose failures cannot be trusted, and two of them were exactly that.
    ///
    /// - Parameters:
    ///   - pending: whether the mock should offer a pending approval and
    ///     question. They fill most of a phone screen, which is correct
    ///     behaviour and useless to a test about what is underneath them.
    ///   - slow: how long the mock should stall every answer, in milliseconds.
    ///     For the two screens that exist to report how long something is
    ///     taking, which cannot be observed against a host that answers instantly.
    private static func resetMockHost(pending: Bool = true, slow: Int = 0) {
        var query = pending ? "" : "?pending=0"
        if slow > 0 { query += query.isEmpty ? "?slow=\(slow)" : "&slow=\(slow)" }
        guard let url = URL(string: "http://127.0.0.1:19395/reset\(query)") else { return }
        let done = DispatchSemaphore(value: 0)
        var request = URLRequest(url: url)
        request.timeoutInterval = 5
        URLSession.shared.dataTask(with: request) { _, _, _ in done.signal() }.resume()
        // Bounded, because a mock host that is not running is a suite that is
        // about to fail on its own terms -- not one to hang on here.
        _ = done.wait(timeout: .now() + 6)
    }

    /// Make the mock host refuse connections, or stop refusing them.
    ///
    /// - Parameter off: whether it should be unreachable.
    private static func setMockOffline(_ off: Bool) {
        guard let url = URL(string: "http://127.0.0.1:19395/offline?on=\(off ? 1 : 0)") else { return }
        let done = DispatchSemaphore(value: 0)
        var request = URLRequest(url: url)
        request.timeoutInterval = 5
        URLSession.shared.dataTask(with: request) { _, _, _ in done.signal() }.resume()
        _ = done.wait(timeout: .now() + 6)
    }

    /// Stall every answer the mock host gives, from now on.
    ///
    /// Called mid-test rather than at launch: the launch itself is a download,
    /// and making that slow too would leave the screen under test unreachable --
    /// the refresh button is disabled while the first download runs.
    ///
    /// - Parameter milliseconds: how long each answer should take.
    private static func stallMockHost(_ milliseconds: Int) {
        guard let url = URL(string: "http://127.0.0.1:19395/slow?ms=\(milliseconds)") else { return }
        let done = DispatchSemaphore(value: 0)
        var request = URLRequest(url: url)
        request.timeoutInterval = 5
        URLSession.shared.dataTask(with: request) { _, _, _ in done.signal() }.resume()
        _ = done.wait(timeout: .now() + 6)
    }

    /// Wait until an element's label says something.
    ///
    /// The figures in the composer bar come from a read that lands after the
    /// screen does, so a plain `label.contains` is an assertion about a snapshot
    /// taken at an arbitrary moment -- and it failed the once, on the run where
    /// the read happened to be slower. Polling is what the rest of this file
    /// does for the same reason.
    ///
    /// - Parameters:
    ///   - element: what to watch.
    ///   - text: what its label should contain.
    /// - Returns: whether it got there.
    private func labelLands(_ element: XCUIElement, containing text: String) -> Bool {
        let arrived = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label CONTAINS %@", text),
            object: element,
        )
        return XCTWaiter().wait(for: [arrived], timeout: Self.patience) == .completed
    }

    /// Scroll back through the conversation until an element is in the tree.
    ///
    /// A `LazyVStack` builds only what is near the screen, so an element that is
    /// in the data can be absent from the accessibility hierarchy entirely --
    /// and `waitForExistence` cannot see what the app has not built. The
    /// conversation opens anchored to its newest message, so anything older than
    /// that needs scrolling to before it can be asserted on.
    ///
    /// Both directions, and that is not tidiness. Expanding a turn inserts its
    /// steps where the turn is, so a row that was on screen can be pushed off the
    /// top while another is pulled up from below -- and a helper that only
    /// travels one way then reports the row as missing from a screen it is on.
    /// Measured: an English-language case found the failure card and the same
    /// case with one turn more expanded did not.
    ///
    /// - Parameters:
    ///   - element: what to look for.
    ///   - app: the running app.
    ///   - swipes: how many screenfuls to travel in each direction.
    /// - Returns: whether it turned up.
    @discardableResult
    private func reveal(_ element: XCUIElement, in app: XCUIApplication, swipes: Int = 6) -> Bool {
        // Give the screen a moment to draw before touching it. Swiping at a
        // conversation that is still loading scrolls nothing and reports the
        // row as absent from a screen it is about to be on -- which is how this
        // helper failed intermittently on a test that had passed a dozen times.
        if element.waitForExistence(timeout: 5) { return true }
        for direction in [0, 1] {
            for _ in 0..<swipes {
                if element.exists { return true }
                // Zero travels towards older messages, one towards newer.
                if direction == 0 { app.swipeDown() } else { app.swipeUp() }
            }
        }
        return element.exists
    }

    /// Launch the app, optionally pairing and opening a session on the way in.
    /// - Parameters:
    ///   - pairing: whether to pass a pairing URI.
    ///   - session: a session to open, or `nil` to stay on the list.
    ///   - language: a language to force, or `nil` to follow the system.
    ///   - pending: whether the mock should offer a pending approval and question.
    ///   - slow: how long the mock should stall every answer, in milliseconds.
    ///   - freshStart: whether to throw the stored data away first.
    ///   - naming: whether to wait for the naming prompt before returning.
    ///     It is offered *after* a first download, so a test about that download
    ///     would spend the whole of it here instead of looking at it.
    /// - Returns: the running application.
    private func launch(
        pairing: Bool = true,
        session: String? = "first",
        language: String? = "en",
        pending: Bool = true,
        slow: Int = 0,
        naming: Bool = true,
        freshStart: Bool = true,
    ) -> XCUIApplication {
        Self.resetMockHost(pending: pending, slow: slow)
        let app = XCUIApplication()
        var arguments: [String] = []
        if pairing { arguments += ["-mizarPairURI", Self.mockPairingURI] }
        if let session { arguments += ["-mizarSelectSession", session] }
        if let language { arguments += ["-AppleLanguages", "(\(language))"] }
        // The stored conversations outlive a relaunch, which is the point of
        // them -- and means a test that did not ask for a clean one would be
        // measuring an earlier run's fixture merged with this one's.
        if freshStart { arguments += ["-mizarFreshStart"] }
        // The system prompts are real and belong to the app, not to a test:
        // answered by an alert, every assertion after them measures the alert.
        arguments += ["-mizarSkipPermissionPrompts"]
        app.launchArguments = arguments
        app.launch()
        if naming { dismissNamingIfPresented(app) }
        return app
    }

    /// Skip the naming prompt.
    ///
    /// Pairing offers a name once, which is a product feature and not what these
    /// tests are about; a test that leaves it up is a test that measures the
    /// sheet.
    ///
    /// It is offered *after* the first download -- the download is the whole
    /// screen, and a prompt presented over it would be answered blind -- so the
    /// wait has to outlast a download rather than a screen transition. Five
    /// seconds was enough for a transition and not for a download, and the
    /// symptom was an intermittent failure in whichever test ran slowest: the
    /// sheet was still up, covering the screen every assertion was about.
    ///
    /// - Parameter app: the launched app.
    private func dismissNamingIfPresented(_ app: XCUIApplication) {
        let skip = app.buttons["rename.skip"]
        if skip.waitForExistence(timeout: Self.patience) { skip.tap() }
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

    /// The second tab, which is where the settings will go.
    ///
    /// It exists because the bar does: a bar with one tab is not a bar. Asked
    /// for as a bar with "对话" on the left and "设置" on the right.
    func testTheSecondTabOpensSettings() {
        let app = launch(session: nil)
        let settings = app.tabBars.buttons.element(boundBy: 1)
        let opener = settings.exists ? settings : app.buttons["Settings"]
        expect(opener, "there is no settings tab")
        opener.tap()
        expect(app.staticTexts["settings.empty"], "the settings tab is not a settings screen")
        // Both tabs, so a bar that switched to a screen it cannot leave would
        // not pass.
        let conversation = app.tabBars.buttons.element(boundBy: 0)
        conversation.tap()
        expect(app.buttons["sessions.new"], "the conversation tab does not come back")
    }

    /// A first pairing downloads everything, and says how far along it is.
    ///
    /// Without the stalled mock this screen is invisible: a local host answers
    /// in milliseconds, so the whole download lives inside one runloop turn. The
    /// delay is what makes the assertion possible at all, and what it asserts is
    /// the thing that was asked for -- that the operator is shown progress
    /// rather than an empty app.
    func testAFirstPairingShowsAFullScreenDownload() {
        let app = launch(session: nil, slow: 500, naming: false)
        XCTAssertTrue(
            app.staticTexts["firstload.title"].waitForExistence(timeout: Self.patience),
            "a first pairing downloaded the history with nothing on screen to say so",
        )
        // And it is a download, not a splash: it counts, and it says how much
        // longer. The estimate needs at least one session finished, which is
        // exactly the restraint being asserted -- a number invented before any
        // sample exists is a number that will change.
        XCTAssertTrue(
            app.staticTexts["firstload.counter"].waitForExistence(timeout: Self.patience),
            "the full-screen download showed no progress count",
        )
        XCTAssertTrue(
            app.staticTexts["firstload.eta"].waitForExistence(timeout: Self.patience),
            "the full-screen download showed no estimate",
        )
        // And it gets out of the way when it is done, handing over to the naming
        // prompt rather than sitting under it.
        dismissNamingIfPresented(app)
        XCTAssertTrue(
            app.buttons["sessions.new"].waitForExistence(timeout: Self.patience * 3),
            "the download never finished",
        )
    }

    /// A refresh reports itself in a window, with an estimate.
    ///
    /// The sheet existed and nothing presented it, so tapping refresh was a
    /// spinner in the toolbar and no idea how long the wait was.
    func testRefreshingShowsAProgressWindow() {
        let app = launch(session: nil)
        // The first download has to be finished first: the refresh button is
        // disabled while it runs, and a disabled button that does nothing would
        // fail this test for the wrong reason.
        expect(app.buttons["sessions.new"], "the session list never arrived")
        expect(app.staticTexts["demo"], "the session list is empty")

        // Slowed now, not at launch, and deliberately: the window exists to say
        // how long something is taking, so a host that answers instantly leaves
        // nothing to look at.
        Self.stallMockHost(1200)

        let refresh = app.buttons["sessions.refresh"]
        expect(refresh, "there is no way to refresh")
        refresh.tap()

        XCTAssertTrue(
            app.buttons["sync.done"].waitForExistence(timeout: Self.patience),
            "tapping refresh did not show the progress window",
        )
        // The window is the point: it says how far along, and how much longer.
        XCTAssertTrue(
            app.staticTexts["sync.counter"].waitForExistence(timeout: Self.patience),
            "the progress window showed no count",
        )
        XCTAssertTrue(
            app.staticTexts["sync.eta"].waitForExistence(timeout: Self.patience),
            "the progress window showed no estimate",
        )
        app.buttons["sync.done"].tap()
        Self.stallMockHost(0)
    }

    /// An unreachable Mac does not take away what this phone already has.
    ///
    /// The other half of the local storage: reading a conversation is entirely
    /// local once it has been synced, so a failure screen that replaces the list
    /// does not report a problem, it destroys an answer. And the phone is opened
    /// on trains, in lifts, and on the far side of a relay having a bad day.
    func testAnUnreachableMacKeepsTheStoredSessions() {
        // First: a normal launch, so there is something stored to keep.
        let first = launch(session: nil)
        expect(first.staticTexts["demo"], "the session list never synced")
        first.terminate()

        Self.setMockOffline(true)
        defer { Self.setMockOffline(false) }

        // Second: the same pairing, the same stored data, and a Mac that has
        // stopped answering.
        let app = launch(session: nil, naming: false, freshStart: false)
        XCTAssertTrue(
            app.staticTexts["demo"].waitForExistence(timeout: Self.patience),
            "an unreachable Mac hid the sessions this phone already had",
        )
        // And it says so rather than pretending everything is fine.
        XCTAssertTrue(
            app.staticTexts["sessions.error"].waitForExistence(timeout: Self.patience),
            "the app did not say the Mac was unreachable",
        )

        // A refresh while unreachable must not report an all-clear. It did: the
        // pass returned without asking anything and the window said "Up to date.
        // Every conversation on this Mac is stored on this phone." -- a claim
        // about the operator's data made out of a request that was never sent.
        let refresh = app.buttons["sessions.refresh"]
        expect(refresh, "there is no way to refresh")
        refresh.tap()
        XCTAssertTrue(
            app.buttons["sync.done"].waitForExistence(timeout: Self.patience),
            "tapping refresh did not show the progress window",
        )
        XCTAssertFalse(
            app.staticTexts["Up to date"].waitForExistence(timeout: 4),
            "a refresh against an unreachable Mac claimed everything was already stored",
        )
    }

    // MARK: - Session detail

    func testOpeningASessionShowsTheComposer() {
        let app = launch(pending: false)
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

    /// A session whose workspace the host has deleted is not drawn.
    ///
    /// The host reports two sessions: one in a workspace it has, and one in a
    /// directory it does not -- which is what a deleted workspace looks like,
    /// because deleting it removes the registry entry and leaves the session log
    /// behind. Grouping on the working directory drew both.
    func testADeletedWorkspaceIsNotListed() {
        let app = launch(session: nil)
        expect(app.staticTexts["Mock Mac (fixture)"], "the host's name is missing")

        // The workspace the host still has is there, with its one session.
        let demo = app.buttons["workspace./Users/you/projects/demo"]
        expect(demo, "the host's own workspace is missing")

        // And the directory the host has no workspace for is not, even though a
        // session still lives in it.
        XCTAssertEqual(
            app.buttons.matching(identifier: "workspace./Users/you/projects/deleted-workspace").count,
            0,
            "a session in a deleted workspace was listed",
        )
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
        let context = app.buttons["composer.context"]
        XCTAssertTrue(
            labelLands(context, containing: "35"),
            "the context percentage is not the host's: \(context.label)",
        )
    }

    /// Open every folded turn, so the steps inside can be asserted on.
    ///
    /// A turn's steps are folded behind a summary by default -- one prompt that
    /// took eleven steps read as the model talking to itself -- so a test that
    /// looks for a step has to open the turn it is in first.
    ///
    /// The element to tap is the `DisclosureGroup`, and its identifier is
    /// `turn.<n>`, not `turn.summary.<n>`: `DisclosureGroup` puts its own
    /// accessibility identity on the whole folded row and the identifier set
    /// inside the label never reaches the tree. This used to query
    /// `turn.summary.` in a loop until the first match stopped being hittable,
    /// which found nothing at all -- so it silently expanded nothing, and the
    /// assertions that relied on it were reading whatever happened to be open.
    ///
    /// Each summary is tapped **once**, keyed on its identifier, because
    /// expanding a row leaves it exactly where it was: a loop that taps until
    /// the row goes away taps it open and shut again.
    ///
    /// - Parameter app: the running app.
    private func expandTurns(_ app: XCUIApplication) {
        let summaries = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'turn.'"))
        var opened = Set<String>()
        for index in 0..<summaries.count {
            let summary = summaries.element(boundBy: index)
            guard summary.exists else { continue }
            guard opened.insert(summary.identifier).inserted else { continue }
            summary.tap()
        }
    }

    func testTheConversationRendersMessagesAndAFailedTurn() {
        // Nothing pending: the two interaction cards fill most of a phone screen,
        // and this test is about the conversation underneath them.
        let app = launch(pending: false)
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

    /// A turn that is still working says so, and does not claim to have finished.
    ///
    /// The reported bug, exactly. A running turn has no `turn/end`, and the
    /// reader invented an end time from its last record -- so a live turn was
    /// drawn as "已完成，用时 10 秒", with the seconds measuring the age of the
    /// newest message, and that newest message was then lifted out from under
    /// the bar and presented as the turn's conclusion.
    func testARunningTurnSaysItIsRunning() {
        // With nothing pending, so the conversation has the screen. The two
        // interaction cards take most of it, and they are asserted on by their
        // own tests.
        let app = launch(pending: false)

        // The state is written on the folded row, which is a `DisclosureGroup`
        // and therefore a button; its label is the whole summary. Found by label
        // rather than by identifier, because the identifier belongs to the
        // disclosure and the state belongs to the label.
        let running = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Running for "))
            .firstMatch
        expect(running, "no turn is reported as running")

        // Turn 1 did end, and still reads as finished -- so the fix is not just
        // "everything says running".
        let finished = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Completed in "))
            .firstMatch
        XCTAssertTrue(reveal(finished, in: app), "no turn is reported as completed")
    }

    /// The clock on a running turn moves.
    ///
    /// Separate from the assertion above because it is a different claim: that
    /// the elapsed time is the turn's own start measured against now, rather
    /// than a number computed once when the screen was drawn. The host is not
    /// asked anything, so this is the only evidence that the phone is doing the
    /// arithmetic itself.
    func testARunningTurnsClockMoves() {
        let app = launch(pending: false)
        let running = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Running for "))
            .firstMatch
        expect(running, "no turn is reported as running")
        let first = running.label

        let moved = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label != %@", first),
            object: running,
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [moved], timeout: 10),
            .completed,
            "the running turn's clock did not move past \(first)",
        )
    }

    /// A running turn shows no summary message, and folds its steps away.
    ///
    /// Both halves of the request, and they are opposites: the message that
    /// happens to be last must not be presented as a conclusion, and it must
    /// also not be lost -- opening the turn brings it back.
    func testARunningTurnShowsNoSummaryMessage() {
        let app = launch(pending: false)
        // Waited for first: without this the two assertions below pass on a
        // screen that has not drawn yet, which is a test that proves nothing.
        expect(app.staticTexts["And run the whole suite."], "the running turn's prompt is missing")

        let lastMessage = app.staticTexts["Two failures, fixing them."]
        let firstStep = app.staticTexts["Running the tests now."]

        // Closed, so neither step is on screen: nothing is presented as the
        // turn's answer while the turn is still being written.
        XCTAssertFalse(
            lastMessage.waitForExistence(timeout: 2),
            "a running turn's last message was shown as its summary",
        )
        XCTAssertFalse(firstStep.exists, "a running turn's steps are not folded")

        expandTurns(app)

        // Opened, so both are: the content was folded, not dropped.
        expect(firstStep, "opening a running turn did not reveal its first step")
        expect(lastMessage, "opening a running turn did not reveal its last step")
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
            labelLands(context, containing: "35"),
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
            "the message never reached the conversation (\(candidates.count) elements carry the text, none above the composer)\nHIERARCHY-START\n\(app.debugDescription)\nHIERARCHY-END",
        )
        XCTAssertEqual(composer.value as? String, "Ask your agent…", "the composer never emptied")
    }

    /// The selection bar is still there inside a conversation.
    ///
    /// It was not. Two reasons, and both are load-bearing:
    ///
    ///   - On iPhone a conversation is a *pushed* detail of the split view, and
    ///     a pushed detail hides the bar below it unless it says otherwise --
    ///     the behaviour UIKit has had since `hidesBottomBarWhenPushed`.
    ///   - On iOS 26 the bar was allowed to minimize itself while scrolling,
    ///     and a conversation opens scrolled to its newest message.
    ///
    /// Either one leaves the selector on the session list and gone from the one
    /// screen it exists for, because the point of it is to reach the settings
    /// without going back first.
    ///
    /// Opened by tapping, not by `-mizarSelectSession`: the launch argument sets
    /// the selection directly and skips the push, so a test that used it would
    /// have passed the whole time this was broken.
    func testTheSelectionBarSurvivesOpeningAConversation() {
        let app = launch(session: nil)
        expect(app.staticTexts["demo"], "the session list never arrived")
        app.staticTexts["demo"].tap()
        let session = app.staticTexts["Mock session"]
        expect(session, "the session row never appeared")
        session.tap()
        expect(app.textFields["composer.field"], "the conversation never opened")

        // Both tabs, and the second one works -- a bar that is drawn but cannot
        // be used is not a selector.
        XCTAssertEqual(
            app.tabBars.buttons.count,
            2,
            "the selection bar is not in the conversation",
        )
        app.tabBars.buttons.element(boundBy: 1).tap()
        expect(app.staticTexts["settings.empty"], "the settings tab does not open from a conversation")
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
        let chinese = launch(language: "zh-Hans", pending: false)
        // Scrolled back to: the failure card belongs to the second turn, and the
        // conversation opens on its newest one.
        let failure = chinese.staticTexts["本轮没有产生回复"]
        XCTAssertTrue(reveal(failure, in: chinese), "the failure card did not translate")
        // The composer's placeholder, which is interface copy. This used to
        // assert on the "对话" segmented control; that control is gone, and the
        // placeholder is the localised string nearest the same place on screen.
        XCTAssertEqual(
            chinese.textFields["composer.field"].value as? String,
            "给 agent 发消息…",
            "the interface did not follow Chinese",
        )
        // Message content is data from the session, not interface copy.
        let prompt = chinese.staticTexts["Refactor the parser and run the tests."]
        XCTAssertTrue(reveal(prompt, in: chinese), "message content was translated")
        chinese.terminate()

        let english = launch(language: "en", pending: false)
        expandTurns(english)
        let englishFailure = english.staticTexts["The turn ended without a response"]
        XCTAssertTrue(reveal(englishFailure, in: english), "the failure card did not translate")
        XCTAssertEqual(
            english.textFields["composer.field"].value as? String,
            "Ask your agent…",
            "the interface did not follow English",
        )
    }
}
