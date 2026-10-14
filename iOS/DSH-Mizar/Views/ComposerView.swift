//
//  ComposerView.swift
//  DSH-Mizar
//
//  Sending a prompt, and stopping one.
//
//  The composer stays available while the agent is working, because the most
//  common thing to want mid-turn is to stop it, and hiding the control until the
//  turn ends would mean waiting for the very thing you want to interrupt.
//

import SwiftUI
import MizarKit

struct ComposerView: View {
    let sessionId: String

    @Environment(AppModel.self) private var model
    @State private var text = ""
    @State private var sending = false
    @FocusState private var focused: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Ask your agent…", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...6)
                .focused($focused)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 18))

            Button {
                Task { await send() }
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 30))
            }
            .disabled(!canSend)
            .opacity(canSend ? 1 : 0.4)

            Button {
                Task { await model.cancelTurn(sessionId: sessionId) }
            } label: {
                Image(systemName: "stop.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(.red)
            }
            .accessibilityLabel("Stop")
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var canSend: Bool {
        !sending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() async {
        let outgoing = text
        sending = true
        // Clear optimistically so the field is ready for the next thought; put
        // the text back if the host refused it, so nothing is silently lost.
        text = ""
        let accepted = await model.sendPrompt(outgoing, to: sessionId)
        if !accepted { text = outgoing }
        sending = false
        focused = true
    }
}
