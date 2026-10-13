// swift-tools-version: 5.9
import PackageDescription

// The radio core and voice input (crates/phone, Rust) for the app: one library
// holding both, and the Swift bindings of each, all written into build/ by
// scripts/core-ios.sh.
let package = Package(
    name: "MeshcoreCore",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "MeshcoreCore", targets: ["MeshcoreCore", "SpeechCore"]),
    ],
    targets: [
        .binaryTarget(name: "MeshcoreCoreFFI", path: "build/MeshcoreCoreFFI.xcframework"),
        .target(name: "MeshcoreCore", dependencies: ["MeshcoreCoreFFI"], path: "build/Sources/MeshcoreCore"),
        // whisper.cpp inside the library is C++ that does its sums with Accelerate.
        .target(
            name: "SpeechCore",
            dependencies: ["MeshcoreCoreFFI"],
            path: "build/Sources/SpeechCore",
            linkerSettings: [.linkedLibrary("c++"), .linkedFramework("Accelerate")]
        ),
    ]
)
