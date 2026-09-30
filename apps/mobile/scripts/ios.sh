#!/bin/bash
# Builds the iOS shell on a Mac, from a tree that has no .git (the Mac gets a
# tarball of the working copy; see README.md here).
#
#   scripts/ios.sh simulator    Debug build, installed and opened in a simulator
#   scripts/ios.sh archive      Release archive, signed, not uploaded
#   scripts/ios.sh testflight   Release archive, signed and uploaded to TestFlight
#
# Written for the bash macOS ships, which is 3.2.

set -euo pipefail

mode=${1:-simulator}
here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../.." && pwd)
bundle=dev.cm4ker.meshnet

# Kept outside the tree, which is replaced on every ship, and removed after an
# upload: the Mac this runs on is also a production host, and its disk is the
# thing that runs out first.
cache=${IOS_CACHE:-$HOME/Library/Caches/meshnet-ios}
derived=$cache/DerivedData

say() { printf '\n== %s\n' "$*"; }

say "install the packages"
cd "$repo"
pnpm install --frozen-lockfile >/dev/null

# The shell carries the built client, so the protocol package and the client
# are built before `cap sync` copies `apps/web/dist` into the project.
say "build the client"
pnpm --filter @meshnet/meshcore build
pnpm --filter @meshnet/web build

say "sync the client and the plugins into the Xcode project"
cd "$here"
npx cap sync ios

# The local package ios/MeshcoreCore links it; Xcode resolves the package from what this writes.
say "build the radio core"
bash "$here/scripts/core-ios.sh"
cd "$here/ios/App"

case "$mode" in
  simulator)
    device=${SIMULATOR:-Meshnet iPhone}
    say "build for the simulator"
    xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
      -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
      -derivedDataPath "$derived" CODE_SIGNING_ALLOWED=NO build -quiet

    app="$derived/Build/Products/Debug-iphonesimulator/App.app"

    if ! xcrun simctl list devices | grep -q "$device ("; then
      # The list is not in release order; the highest-numbered Pro is the newest.
      type=$(xcrun simctl list devicetypes | grep -E '^iPhone [0-9]+ Pro \(' | sort -t' ' -k2 -n | tail -1 | sed -E 's/.*\((.*)\)$/\1/')
      runtime=$(xcrun simctl list runtimes | grep -E '^iOS ' | tail -1 | sed -E 's/.* - (com\.apple[^ ]*).*/\1/')
      say "create the simulator \"$device\" ($type, $runtime)"
      xcrun simctl create "$device" "$type" "$runtime" >/dev/null
    fi

    say "install and open"
    xcrun simctl boot "$device" 2>/dev/null || true
    xcrun simctl bootstatus "$device" -b >/dev/null
    xcrun simctl install "$device" "$app"
    xcrun simctl terminate "$device" "$bundle" 2>/dev/null || true
    xcrun simctl launch "$device" "$bundle"
    ;;

  archive | testflight)
    # This Mac's account settings, kept beside the key rather than in the tree:
    # ASC_KEY_ID and ASC_ISSUER_ID for the App Store Connect API, KEYCHAIN for the
    # keychain that holds the Apple Distribution identity, and
    # KEYCHAIN_PASSWORD_FILE to unlock it, which an ssh session has to do itself.
    # The team is the one Sovabox ships from, so the file is shared with it.
    # shellcheck disable=SC1090
    . "${ASC_ENV:-$HOME/.appstoreconnect/owlmail.env}"
    : "${BUILD_NUMBER:?BUILD_NUMBER is the commit count on master: git rev-list --count HEAD}"

    security unlock-keychain -p "$(cat "$KEYCHAIN_PASSWORD_FILE")" "$KEYCHAIN"

    # Bluetooth needs no capability on the App ID: the usage strings and the
    # `bluetooth-central` background mode live in Info.plist.
    say "the App ID and its profile"
    node "$here/scripts/apple.mjs" bundle "$bundle" Meshnet
    node "$here/scripts/apple.mjs" profile "$bundle" "Meshnet App Store"
    # The extension that draws a running survey on the locked screen is signed as an app of its own.
    node "$here/scripts/apple.mjs" bundle "$bundle.SurveyActivity" "Meshnet Survey"
    node "$here/scripts/apple.mjs" profile "$bundle.SurveyActivity" "Meshnet Survey App Store"
    if [ "$mode" = testflight ]; then
      node "$here/scripts/apple.mjs" app "$bundle"
    fi

    archive="$cache/Meshnet.xcarchive"
    rm -rf "$archive"

    say "archive build $BUILD_NUMBER"
    xcodebuild -project App.xcodeproj -scheme App -configuration Release \
      -destination 'generic/platform=iOS' -archivePath "$archive" \
      -derivedDataPath "$derived" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" archive -quiet

    if [ "$mode" = testflight ]; then
      # A build goes up for internal testing only, which App Review never
      # sees; REVIEW=1 uploads one that can be picked for an App Store version.
      options="$here/ios/export-testflight.plist"
      if [ "${REVIEW:-0}" = 1 ]; then
        options="$cache/export-review.plist"
        cp "$here/ios/export-testflight.plist" "$options"
        /usr/libexec/PlistBuddy -c "Set :testFlightInternalTestingOnly false" "$options"
        say "this build can go to App Review"
      fi
      say "export and upload to App Store Connect"
      xcodebuild -exportArchive -archivePath "$archive" \
        -exportOptionsPlist "$options" \
        -exportPath "$cache/export" \
        -authenticationKeyPath "${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8}" \
        -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"
      rm -rf "$archive" "$cache/export" "$cache/export-review.plist" "$derived"
      # The radio core's Rust build, a gigabyte; the next ship starts from a fresh tree anyway.
      rm -rf "$repo/crates/meshcore-core/target"
    fi
    ;;

  *)
    echo "unknown mode: $mode" >&2
    exit 2
    ;;
esac
