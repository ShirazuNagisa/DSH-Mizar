//
//  PairingView.swift
//  DSH-Mizar
//
//  Getting a device connected, once.
//
//  Two ways in, because the QR path can fail for reasons that have nothing to do
//  with the app: a camera that will not focus, a code on a screen across the
//  room, or a simulator with no camera at all. The manual path is the fallback
//  that makes all of those recoverable without a support conversation.
//

import SwiftUI
import MizarKit
import VisionKit

struct PairingView: View {
    @Environment(AppModel.self) private var model

    @State private var showingScanner = false
    @State private var authority = ""
    @State private var code = ""
    @State private var deviceName = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button {
                        showingScanner = true
                    } label: {
                        Label("Scan the code on your Mac", systemImage: "qrcode.viewfinder")
                    }
                    .disabled(!DataScannerViewController.isSupported)
                } footer: {
                    Text("On the Mac, open DSH and look for the Mizar panel in the sidebar.")
                }

                Section("Or enter it by hand") {
                    TextField("Host, for example 100.64.0.1:19390", text: $authority)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    TextField("Pairing code", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                }

                Section("This device") {
                    TextField(deviceNamePlaceholder, text: $deviceName)
                }

                Section {
                    Button("Pair") { pair() }
                        .disabled(!canSubmit)
                }
            }
            .navigationTitle("Connect to DSH")
            .sheet(isPresented: $showingScanner) {
                ScannerSheet { scanned in
                    showingScanner = false
                    if let target = PairingURI.parse(scanned) {
                        Task { await model.pair(with: target, deviceName: resolvedDeviceName) }
                    }
                }
                .ignoresSafeArea()
            }
        }
    }

    /// Whether both required fields look usable.
    private var canSubmit: Bool {
        !authority.trimmingCharacters(in: .whitespaces).isEmpty
            && !code.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// A blank name is fine — the host falls back to the device model.
    private var resolvedDeviceName: String {
        let trimmed = deviceName.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? "iPhone" : trimmed
    }

    private var deviceNamePlaceholder: String { "iPhone" }

    private func pair() {
        let target = PairingTarget(
            authority: authority.trimmingCharacters(in: .whitespaces),
            code: code.trimmingCharacters(in: .whitespaces),
        )
        Task { await model.pair(with: target, deviceName: resolvedDeviceName) }
    }
}

/// A camera view that reports the first pairing URI it recognises.
///
/// VisionKit is picky about being presented without a container, so this wraps it
/// in a `UIViewControllerRepresentable` rather than trying to embed the
/// controller directly.
private struct ScannerSheet: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let controller = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isHighlightingEnabled: true,
        )
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {
        try? controller.startScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        private let onScan: (String) -> Void
        private var reported = false

        init(onScan: @escaping (String) -> Void) {
            self.onScan = onScan
        }

        func dataScanner(
            _ scanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem],
        ) {
            // The camera keeps firing while the code stays in frame; only the
            // first read should start a pairing attempt.
            guard !reported else { return }
            for item in addedItems {
                guard case .barcode(let barcode) = item,
                      let value = barcode.payloadStringValue
                else { continue }
                reported = true
                onScan(value)
                return
            }
        }
    }
}
