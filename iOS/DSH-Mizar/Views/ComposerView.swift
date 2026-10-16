//
//  ComposerView.swift
//  DSH-Mizar
//
//  Sending a prompt, and stopping one.
//
//  Laid out like the Messages field: a pill on the left that grows downward as
//  the text wraps, and one circular button on the right. The button carries both
//  actions, and which one it carries is the whole state machine:
//
//    the session is running, and nothing has been typed   -> stop
//    anything else                                        -> send
//
//  That is DSH's own rule, and it is the right one for the same reason it is
//  right there: mid-turn the thing an operator most often wants is to interrupt,
//  and the second most common is to queue something up. One button that changes
//  meaning is how both stay one tap away.
//
//  A separate stop button beside a send button -- what this used to be -- puts
//  two controls on screen for one decision, and the one that is not currently
//  meaningful sits there inviting a mistake.
//

import SwiftUI
import MizarKit

struct ComposerView: View {
    let sessionId: String
    /// What has been typed.
    ///
    /// Owned by the screen rather than by this view, because the command button
    /// in the bar above it puts text in here -- a command is something the
    /// operator finishes typing, not something that sends itself.
    @Binding var text: String
    /// Called with the text that was accepted, so the conversation can pick it up.
    let onSent: (String) async -> Void
    /// Whether the field holds the keyboard.
    ///
    /// Owned by the screen, not by this view, so tapping the conversation can
    /// put the keyboard away -- the field is the only thing that knows how to
    /// do it and it is not the thing being tapped.
    @FocusState.Binding var focused: Bool

    @Environment(AppModel.self) private var model
    @State private var sending = false
    @State private var stopping = false

    /// The diameter of Messages' trailing control, which does not change between
    /// the two jobs it does.
    private static let buttonSize: CGFloat = 36
    /// The field's corner. Messages rounds its field to half its height, which
    /// at one line makes a capsule and at several a rounded rectangle -- so the
    /// radius is half the single-line height rather than a number of its own.
    private static let fieldCorner: CGFloat = 19

    var body: some View {
        // The system's own grouping for glass elements. Two pieces of glass
        // side by side with a `GlassEffectContainer` blend at their edges the
        // way Messages' field and its button do; applied separately they meet
        // in a hard seam.
        GlassRow(spacing: 8) {
            HStack(alignment: .bottom, spacing: 8) {
                // The key, not the Chinese: this string is already in the
                // catalogue and already translated. Writing the translation
                // inline would have shown Chinese to English users too.
                TextField("Ask your agent…", text: $text, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...8)
                    .focused($focused)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 9)
                    // A capsule while it is one line and a rounded rectangle
                    // once it is several -- Messages does the same, and it is
                    // why a wrapped message is not a lozenge with square text
                    // in it.
                    .liquidSurface(in: RoundedRectangle(cornerRadius: Self.fieldCorner, style: .continuous))
                    .accessibilityIdentifier("composer.field")

                Button {
                    Task { await primary() }
                } label: {
                    Image(systemName: showsStop ? "stop.fill" : "arrow.up")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(buttonForeground)
                        .frame(width: Self.buttonSize, height: Self.buttonSize)
                        .background {
                            // Glass only where Messages uses it. A send that is
                            // ready is a solid accent circle and a stop is a
                            // solid red one, exactly as both Messages and DSH
                            // draw them; the glass circle is the resting state,
                            // where there is nothing to do yet.
                            if showsStop {
                                Circle().fill(.red)
                            } else if sendEnabled {
                                Circle().fill(Color.accentColor)
                            }
                        }
                        .liquidSurface(in: Circle(), when: !showsStop && !sendEnabled)
                }
                .buttonStyle(.plain)
                .disabled(!showsStop && !sendEnabled)
                .accessibilityLabel(showsStop ? "Stop" : "Send")
                .accessibilityIdentifier(showsStop ? "composer.stop" : "composer.send")
            }
        }
        // Nearly edge to edge, as Messages is: an 8pt gutter on each side
        // rather than a 12pt one, which is what made the field look inset from
        // the screen and narrower than the conversation above it.
        .padding(.horizontal, 8)
        .padding(.top, 4)
        .padding(.bottom, 8)
    }

    /// White on the solid states, secondary on the glass one, where white would
    /// vanish into the highlight.
    private var buttonForeground: Color {
        if showsStop || sendEnabled { return .white }
        return .secondary
    }

    /// Whether the session this composer belongs to has a turn in flight.
    private var running: Bool {
        model.sessions.first { $0.sessionId == sessionId }?.running ?? false
    }

    /// Whether the one button is a stop button right now.
    private var showsStop: Bool {
        running && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !stopping
    }

    private var sendEnabled: Bool {
        !sending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Do whichever job the button is currently carrying.
    private func primary() async {
        if showsStop {
            stopping = true
            await model.cancelTurn(sessionId: sessionId)
            stopping = false
        } else {
            await send()
        }
    }

    private func send() async {
        let outgoing = text
        sending = true
        // Clear optimistically so the field is ready for the next thought; put
        // the text back if the host refused it, so nothing is silently lost.
        text = ""
        let accepted = await model.sendPrompt(outgoing, to: sessionId)
        if accepted {
            await onSent(outgoing)
        } else {
            text = outgoing
        }
        sending = false
        focused = true
    }
}
