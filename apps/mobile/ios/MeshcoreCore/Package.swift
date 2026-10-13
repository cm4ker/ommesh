// swift-tools-version: 5.9
import PackageDescription

// The radio core (crates/meshcore-core, Rust) for the app: the library and its
// Swift bindings, both written into build/ by scripts/core-ios.sh.
let package = Package(
    name: "MeshcoreCore",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "MeshcoreCore", targets: ["MeshcoreCore"]),
    ],
    targets: [
        .binaryTarget(name: "MeshcoreCoreFFI", path: "build/MeshcoreCoreFFI.xcframework"),
        .target(name: "MeshcoreCore", dependencies: ["MeshcoreCoreFFI"], path: "build/Sources/MeshcoreCore"),
    ]
)
