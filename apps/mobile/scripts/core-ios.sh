#!/bin/bash
# Builds the radio core and voice input (crates/phone, Rust: crates/meshcore-core
# and crates/speech in one library) for the iPhone and the simulator, as the
# XCFramework and Swift bindings that the local package ios/MeshcoreCore links
# into the app. Run by ios.sh before Xcode builds; needs cargo with the
# aarch64-apple-ios, aarch64-apple-ios-sim and x86_64-apple-ios targets (a
# simulator build is for both kinds of Mac), and CMake for whisper.cpp.
#
# Written for the bash macOS ships, which is 3.2.

set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
phone=$(cd "$here/../../crates/phone" && pwd)
out=$here/ios/MeshcoreCore/build
lib=libmeshnet_phone.a

# rustup's cargo, which an ssh session's PATH may lack; Homebrew's CMake.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"

# whisper.cpp for the processors iPhones have had for years (the dot product,
# half floats), which the library checks for at run time before it hears
# anything, rather than for the Mac that builds it.
export GGML_NATIVE=OFF
export GGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16
# The Rust and the C++ built for the iOS the app runs on (Package.swift), so
# the two agree on what the system provides.
export IPHONEOS_DEPLOYMENT_TARGET=15.0

# The static library alone: the app links it, and a shared one for iOS would
# be linked here for nothing, without the compiler's runtime that the C++ needs.
cd "$phone"
for target in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
  cargo rustc --lib --crate-type staticlib --release --locked --target "$target"
done

rm -rf "$out"
mkdir -p "$out/Sources/MeshcoreCore" "$out/Sources/SpeechCore" "$out/headers" "$out/simulator"
cargo run -q --locked --features bindgen --bin uniffi-bindgen -- generate \
  --library "target/aarch64-apple-ios/release/$lib" \
  --language swift --out-dir "$out/gen"

mv "$out/gen/MeshcoreCore.swift" "$out/Sources/MeshcoreCore/"
mv "$out/gen/SpeechCore.swift" "$out/Sources/SpeechCore/"
mv "$out/gen/MeshcoreCoreFFI.h" "$out/gen/SpeechCoreFFI.h" "$out/headers/"
# An XCFramework's headers name their module map module.modulemap; it maps both crates' modules.
cat "$out/gen/MeshcoreCoreFFI.modulemap" > "$out/headers/module.modulemap"
printf '\n' >> "$out/headers/module.modulemap"
cat "$out/gen/SpeechCoreFFI.modulemap" >> "$out/headers/module.modulemap"
rm -rf "$out/gen"

# One library for both simulators, as an XCFramework holds one per platform.
lipo -create \
  "target/aarch64-apple-ios-sim/release/$lib" \
  "target/x86_64-apple-ios/release/$lib" \
  -output "$out/simulator/$lib"

xcodebuild -create-xcframework \
  -library "target/aarch64-apple-ios/release/$lib" -headers "$out/headers" \
  -library "$out/simulator/$lib" -headers "$out/headers" \
  -output "$out/MeshcoreCoreFFI.xcframework" >/dev/null
rm -rf "$out/headers" "$out/simulator"
echo "radio core and voice input: $out"
