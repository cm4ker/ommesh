import Capacitor
import UIKit

/// Capacitor's bridge, with the plugins that live in this app rather than in a
/// package. `SceneDelegate` makes the window with this class.
class MeshViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(MeshTcpPlugin())
        bridge?.registerPluginInstance(MeshWatchPlugin())
        bridge?.registerPluginInstance(MeshRelayPlugin())
        MeshWatch.installSounds()
    }
}
