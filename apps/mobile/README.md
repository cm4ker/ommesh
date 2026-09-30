# The phone shell

On a phone the app is called Ommesh: in App Store Connect, under its icon on iOS
and Android, and in the Bluetooth prompt. The bundle ID stays `dev.cm4ker.meshnet`, and so do the internal names (the App ID,
the "Meshnet App Store" profile).

Capacitor 8 around the built client (`apps/web/dist`), for iOS and Android. The
shell carries the client rather than loading it from a server: a radio in a field
has no network, and the app must open without one. The native code is the
plugins the client calls: BLE (`@capacitor-community/bluetooth-le`), the secure
storage that keeps node passwords, and the app's own `MeshTcp`.

## Wi-Fi

Companion firmware built with Wi-Fi (ESP32 boards, `WIFI_SSID` at build time)
listens on TCP port 5000 and speaks what its USB serial speaks. `MeshTcp` is a
socket and nothing more: `ios/App/App/MeshTcpPlugin.swift` (Network.framework)
and `android/app/src/main/java/dev/cm4ker/meshnet/MeshTcpPlugin.java`, the same
methods and events on both. The framing is the client's
(`apps/web/src/transports/capacitorTcp.ts`, with what the desktop shares in
`tcp.ts`).

- iOS registers it in `MeshViewController`, which `Main.storyboard` names in
  place of Capacitor's own bridge view controller. Android registers it in
  `MainActivity`.
- iOS asks for Local Network access the first time a radio's address is dialled
  (`NSLocalNetworkUsageDescription`). A connection waits through the prompt, up
  to its 10-second timeout.

## Android

    pnpm android         # builds the client, syncs, opens Android Studio
    pnpm --filter @meshnet/mobile android:apk

The build also compiles the radio core (`crates/meshcore-core`, Rust) for the
phone and writes its Kotlin bindings (Gradle's `buildRustCore` and
`bindRustCore`), so it needs cargo, the Android targets and cargo-ndk:

    rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
    cargo install cargo-ndk

On Android the page always reaches a Bluetooth radio through `MeshRelay.java`,
which runs the core: it keeps reading the radio while Android has the page's
scripts stopped in the background, kept alive by a connected-device foreground
service ("Connected to …"), and posts what arrives meanwhile as notices.

A coverage survey runs in the core too, so it goes on with the phone locked:
`MeshRelay.java` reads the phone's position itself (`LocationManager`, not the
location plugin, whose watch is the page's) and hands each fix to the core,
which asks "who hears me" through the mux. Android gives an app out of sight
the position only through a foreground service of the `location` kind started
from the screen, so the link's service takes that kind while a survey runs
(`MeshRelayService.locating`), and the app asks for no background-location
permission. Google Play wants that kind declared (App content › Foreground
service permissions) with a short video of the survey.

CI builds a debug APK on every push (`.github/workflows/build.yml`).

### Sharing a radio with Windows: realme service discovery timeout

On a realme 15T running Android 16, the phone could use Node-21 normally while
Windows failed with `service discovery: Windows gave no answer in 20 s`.
The phone's Bluetooth log showed a read of characteristic
`00009890-0000-1000-8000-00805f9b34fb`, owned by `com.heytap.accessory`, with no
response. Windows never reached the relay's notification subscription. Asking
WinRT for only the UART UUID did not isolate discovery from the vendor service.
The desktop now uses `BluetoothCacheMode::Cached` for the UART service as well
as its characteristics, so it can reuse a completed discovery. As described in
[Microsoft's cache documentation](https://learn.microsoft.com/en-us/uwp/api/windows.devices.bluetooth.bluetoothcachemode),
a cache miss still queries the device; this does not fix a first discovery
blocked by the vendor service.
An existing cached list can also omit a service that the iPhone app published
later. When the cached UART lookup succeeds but returns nothing, the desktop
explicitly repeats discovery with `Uncached` before reporting that the service
is missing. A cached UART match still avoids that extra query on Android.
The cached service is explicitly granted access and opened for shared reading
and writing in each process, then retained until disconnect. Without that,
restarting the Windows app could immediately return `AccessDenied` while
enumerating characteristics.

Discovery and subscription failures also used to request pairing for every
non-success status. On a phone, that automatically removed the existing bond
even for a temporary `Unreachable` or `AccessDenied` result, losing Windows'
ability to resolve the phone's rotating BLE address. The desktop now requests
bond repair only for ATT authentication/authorization/encryption errors
(`0x05`, `0x08`, `0x0F`); a device with no bond still follows the pairing flow.

To diagnose this specific conflict with an attached phone, temporarily disable
the accessory package, connect to the phone in the Windows app, then restore
the package's original enabled state. On the tested phone that state was
`default`:

    adb shell pm disable-user --user 0 com.heytap.accessory
    # Connect to realme 15T in Ommesh on Windows.
    adb shell pm default-state --user 0 com.heytap.accessory

The package runs realme's cross-device features, which are unavailable during
this brief test. A plain `am force-stop` was insufficient: the service restarted
before discovery completed. With its original state restored, the tested link
continued working and reconnected; both clients read Node-21's battery, 93
contacts and four channels. This is a device-specific workaround, not a fix
for the vendor service; a later return of its unresponsive GATT service can
cause the timeout again.

## iOS

As on Android, the page reaches a Bluetooth radio through `MeshRelay.swift`,
which runs the radio core: iOS suspends the page's scripts soon after the app
leaves the screen, while the `bluetooth-central` background mode keeps the link
up and wakes the core for every frame, and the core reads the radio's queue and
posts what arrives as notices.

A coverage survey runs in the core too: `MeshRelay.swift` follows the phone
with its own `CLLocationManager` and hands each fix to the core. The `location`
background mode lets that go on with the phone locked for an app that began on
screen, on the "While Using" permission the page already asked for, with iOS's
own sign in the status bar. App Review asks what the mode is for: the coverage
survey, "Survey on the move" under "Who hears me" on the map.

It needs a Mac with Xcode. The Mac here is `server.lan`, the same one the Sovabox
phone app is built on, and the same Apple team (8CNDTQVA32). The build keeps its
derived data under `~/Library/Caches/meshnet-ios` and the tree under
`~/build/meshnet`.

Ship the tree from Windows, with LF line endings. `git archive` follows
`core.autocrlf` and would otherwise put a `\r` after `#!/bin/bash`:

    git add apps/mobile
    git -c core.autocrlf=false archive --format=tar $(git write-tree) |
      ssh cmaker@server.lan 'rm -rf ~/build/meshnet && mkdir -p ~/build/meshnet && tar -xf - -C ~/build/meshnet'

Then, on the Mac:

    cd ~/build/meshnet
    bash apps/mobile/scripts/ios.sh simulator

That installs the packages, builds the client, syncs it into the project,
builds the radio core (`crates/meshcore-core`, Rust) for the phone and the
simulator with `scripts/core-ios.sh` into the local package `ios/MeshcoreCore`
(cargo with the `aarch64-apple-ios`, `aarch64-apple-ios-sim` and
`x86_64-apple-ios` targets), builds, creates the simulator "Meshnet iPhone" if it is missing, installs the app and
opens it. The simulator has no Bluetooth, so the connect screen says "BLE
unsupported" there; a radio needs a phone. `xcrun simctl delete "Meshnet iPhone"`
afterwards: a simulator is about 2 GB, and that Mac's disk is short.

### TestFlight

    BUILD_NUMBER=$(git rev-list --count HEAD)     # on Windows, before shipping
    bash apps/mobile/scripts/ios.sh testflight     # on the Mac, with BUILD_NUMBER set

It registers the App ID and makes a fresh App Store profile, "Meshnet App Store",
through the App Store Connect API (`scripts/apple.mjs`). Then it archives, signed
with the team's Apple Distribution identity, and `xcodebuild -exportArchive`
uploads the build for internal testing. `ios.sh archive` stops before the upload.

A build for internal testing cannot be chosen for an App Store version. One meant
for App Review goes up with `REVIEW=1` as well; it is then offered under the
version's Build section in App Store Connect, and to external testers.

What it reads is the Mac's, not the tree's: `~/.appstoreconnect/owlmail.env`
names the API key (`ASC_KEY_ID`, `ASC_ISSUER_ID`; the key itself is in
`~/.appstoreconnect/private_keys`) and the keychain holding the identity, with the
file that unlocks it. An ssh session has to unlock a keychain itself. `ASC_ENV`
names another file.

The one thing the API cannot do is create the app in App Store Connect. That is
done once, by hand, at appstoreconnect.apple.com → Apps → New App, with bundle ID
`dev.cm4ker.meshnet`. Until then `testflight` stops and says so.

The build number is the commit count on master. App Store Connect refuses a
number it has already seen, and that count only grows.

### Known and worked around

- `CapApp-SPM/Package.swift` points into `node_modules/.pnpm`, and pnpm shortens
  those directory names on Windows but not on a Mac. `cap sync` rewrites the file,
  so `ios.sh` always syncs before it builds; a sync on Windows leaves the
  shortened paths, which is what is committed.
- Bluetooth needs no capability on the App ID. The usage strings and the
  `bluetooth-central` background mode, which keeps a connection alive while
  another app is in front, are in `Info.plist`.
- A notice is words alone, with no picture of who wrote it (`MeshWatch.show`):
  a watch the phone passes it on to showed the picture in place of the words.
- `ITSAppUsesNonExemptEncryption` is false. The radio encrypts what goes on the
  air. The client only uses WebCrypto (the system's AES and SHA-256) to recognise
  its own channel messages when a repeater sends them back.
