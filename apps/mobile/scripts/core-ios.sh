#!/bin/bash
# Builds the radio core (crates/meshcore-core, Rust) for the iPhone and the
# simulator, as the XCFramework and Swift bindings that the local package
# ios/MeshcoreCore links into the app. Run by ios.sh before Xcode builds; needs
# cargo with the aarch64-apple-ios, aarch64-apple-ios-sim and x86_64-apple-ios
# targets (a simulator build is for both kinds of Mac).
#
# Written for the bash macOS ships, which is 3.2.

set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
core=$(cd "$here/../../crates/meshcore-core" && pwd)
out=$here/ios/MeshcoreCore/build

# rustup's cargo, which an ssh session's PATH may lack.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

cd "$core"
cargo build --release --locked --target aarch64-apple-ios
cargo build --release --locked --target aarch64-apple-ios-sim
cargo build --release --locked --target x86_64-apple-ios

rm -rf "$out"
mkdir -p "$out/Sources/MeshcoreCore" "$out/headers" "$out/simulator"
cargo run -q --locked --features bindgen --bin uniffi-bindgen -- generate \
  --library target/aarch64-apple-ios/release/libmeshcore_core.a \
  --language swift --out-dir "$out/gen"

mv "$out/gen/MeshcoreCore.swift" "$out/Sources/MeshcoreCore/"
mv "$out/gen/MeshcoreCoreFFI.h" "$out/headers/"
# An XCFramework's headers name their module map module.modulemap.
mv "$out/gen/MeshcoreCoreFFI.modulemap" "$out/headers/module.modulemap"
rm -rf "$out/gen"

# One library for both simulators, as an XCFramework holds one per platform.
lipo -create \
  target/aarch64-apple-ios-sim/release/libmeshcore_core.a \
  target/x86_64-apple-ios/release/libmeshcore_core.a \
  -output "$out/simulator/libmeshcore_core.a"

xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/libmeshcore_core.a -headers "$out/headers" \
  -library "$out/simulator/libmeshcore_core.a" -headers "$out/headers" \
  -output "$out/MeshcoreCoreFFI.xcframework" >/dev/null
rm -rf "$out/headers" "$out/simulator"
echo "radio core: $out"
