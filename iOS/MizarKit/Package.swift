// swift-tools-version: 6.0
import PackageDescription

// MizarKit — the DSH-Mizar protocol layer.
//
// Built as a Swift package rather than straight into the app target for one
// practical reason: `swift test` runs on the host Mac in about a second, while
// anything requiring a simulator round-trip costs far more per iteration. The
// app project consumes this as a local package.
//
// The macOS platform is declared so the test suite can run on the host; nothing
// here is iOS-only.
let package = Package(
    name: "MizarKit",
    platforms: [
        .iOS(.v18),
        .macOS(.v15),
    ],
    products: [
        .library(name: "MizarKit", targets: ["MizarKit"]),
    ],
    targets: [
        .target(
            name: "MizarKit",
            swiftSettings: [
                // Swift 6 language mode: data-race safety is checked at compile
                // time rather than discovered in the field.
                .swiftLanguageMode(.v6),
            ],
        ),
        .testTarget(
            name: "MizarKitTests",
            dependencies: ["MizarKit"],
            // No bundled resources: the golden frames live at
            // `protocol/fixtures/` in the repository and are read from there via
            // `#filePath`. Copying them into the test bundle would create a
            // second copy that can drift from the one the TypeScript side reads,
            // which is precisely what the fixtures exist to prevent.
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ],
        ),
    ],
)
