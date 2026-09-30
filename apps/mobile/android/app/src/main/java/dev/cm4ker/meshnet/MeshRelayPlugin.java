package dev.cm4ker.meshnet;

import android.Manifest;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * The page's side of its link to the radio ({@link MeshRelay}), the plugin the iOS app carries
 * too, used by the web client's {@code lib/relay.ts}: {@code start({ deviceId, name, share })}
 * with the radio the page is connected to, {@code share({ on })}, {@code stop()},
 * {@code state()}, and a {@code state} event {@code { linked, radio, up, on, computer }} whenever one
 * of them changes ({@code radio}: the linked radio's address; {@code up}: its TX notifies, so frames
 * go through at once; {@code on}: shared). While {@code attach()}ed, the page talks to the radio through
 * here: {@code send({ data })} (base64), answered once the frame has gone to the radio, and
 * {@code frame} events {@code { data }}. {@code configure({ json, sound })} hands the radio core
 * the page's notice settings and names, {@code announced({ tag })} what the page announced itself,
 * and {@code exits()} why the app or its page stopped lately.
 *
 * <p>A coverage survey is run by the core, so it goes on while the page sleeps:
 * {@code surveyStart({ json })}, {@code surveyStop()} and {@code survey()} answer
 * {@code { json, running }} with the survey and all its points ({@code json} null when there is
 * none), and a {@code survey} event {@code { json }} tells each step with its last point.
 *
 * <p>Advertising to a computer takes Bluetooth's "nearby devices" permission for advertising on
 * Android 12 and later, asked the first time sharing is turned on.
 */
@CapacitorPlugin(
    name = "MeshRelay",
    permissions = { @Permission(alias = MeshRelayPlugin.ADVERTISE, strings = { Manifest.permission.BLUETOOTH_ADVERTISE }) }
)
public class MeshRelayPlugin extends Plugin {
    static final String ADVERTISE = "advertise";

    private MeshRelay relay() {
        return MeshRelay.shared(getContext());
    }

    private MeshRelay.Listener listener;

    @Override
    public void load() {
        listener = new MeshRelay.Listener() {
            @Override
            public void changed() {
                notifyListeners("state", state());
            }

            @Override
            public void pageFrame(byte[] frame) {
                JSObject event = new JSObject();
                event.put("data", Base64.encodeToString(frame, Base64.NO_WRAP));
                notifyListeners("frame", event);
            }

            @Override
            public void survey(String json) {
                JSObject event = new JSObject();
                event.put("json", json);
                notifyListeners("survey", event);
            }
        };
        relay().setListener(listener);
    }

    /**
     * The page is gone (let go for memory, its renderer lost, the app swiped away) while the link
     * may stay: the core keeps its messages in the inbox, and announces them, until a new page comes.
     */
    @Override
    protected void handleOnDestroy() {
        relay().detachPage();
        relay().clearListener(listener);
    }

    private JSObject state() {
        MeshRelay relay = relay();
        JSObject state = new JSObject();
        state.put("linked", relay.isOn());
        state.put("radio", relay.radioAddress());
        state.put("up", relay.isUp());
        state.put("on", relay.isSharing());
        state.put("computer", relay.hasComputer());
        return state;
    }

    /** Sharing asks for the permission to advertise first, where Android has one. */
    private boolean mayAdvertise(PluginCall call, String then) {
        if (!call.getBoolean("share", call.getBoolean("on", false))) return true;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || getPermissionState(ADVERTISE) == PermissionState.GRANTED) return true;
        requestPermissionForAlias(ADVERTISE, call, then);
        return false;
    }

    private boolean refused(PluginCall call) {
        if (getPermissionState(ADVERTISE) == PermissionState.GRANTED) return false;
        call.reject("Allow nearby devices for Ommesh to share the radio with a computer");
        return true;
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (call.getString("deviceId", "").isEmpty()) {
            call.reject("start needs the radio's deviceId");
            return;
        }
        if (mayAdvertise(call, "startAllowed")) begin(call);
    }

    @PermissionCallback
    private void startAllowed(PluginCall call) {
        if (!refused(call)) begin(call);
    }

    private void begin(PluginCall call) {
        String address = call.getString("deviceId", "");
        String name = call.getString("name", "");
        boolean share = call.getBoolean("share", false);
        getActivity().runOnUiThread(() -> {
            relay().start(address, name, share);
            call.resolve(state());
        });
    }

    @PluginMethod
    public void share(PluginCall call) {
        if (mayAdvertise(call, "shareAllowed")) share(call, call.getBoolean("on", false));
    }

    @PermissionCallback
    private void shareAllowed(PluginCall call) {
        if (!refused(call)) share(call, true);
    }

    private void share(PluginCall call, boolean on) {
        getActivity().runOnUiThread(() -> {
            relay().share(on);
            call.resolve(state());
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            relay().stop();
            call.resolve(state());
        });
    }

    @PluginMethod
    public void state(PluginCall call) {
        getActivity().runOnUiThread(() -> call.resolve(state()));
    }

    @PluginMethod
    public void attach(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            relay().attachPage();
            call.resolve();
        });
    }

    @PluginMethod
    public void detach(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            relay().detachPage();
            call.resolve();
        });
    }

    @PluginMethod
    public void send(PluginCall call) {
        String data = call.getString("data");
        byte[] frame;
        try {
            frame = data == null ? null : Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            frame = null;
        }
        if (frame == null) {
            call.reject("send needs base64 data");
            return;
        }
        byte[] bytes = frame;
        getActivity().runOnUiThread(() -> relay().fromPage(bytes, call::resolve));
    }

    @PluginMethod
    public void configure(PluginCall call) {
        String json = call.getString("json");
        if (json == null) {
            call.reject("configure needs json");
            return;
        }
        String sound = call.getString("sound");
        getActivity().runOnUiThread(() -> {
            relay().configure(json, sound);
            call.resolve();
        });
    }

    private static JSObject answer(String json, boolean running) {
        JSObject result = new JSObject();
        result.put("json", json == null ? JSObject.NULL : json);
        result.put("running", running);
        return result;
    }

    @PluginMethod
    public void surveyStart(PluginCall call) {
        String json = call.getString("json");
        if (json == null) {
            call.reject("surveyStart needs json");
            return;
        }
        getActivity().runOnUiThread(() -> {
            String now = relay().surveyStart(json);
            call.resolve(answer(now, relay().isSurveying()));
        });
    }

    @PluginMethod
    public void surveyStop(PluginCall call) {
        getActivity().runOnUiThread(() -> call.resolve(answer(relay().surveyStop(), false)));
    }

    @PluginMethod
    public void survey(PluginCall call) {
        getActivity().runOnUiThread(() -> call.resolve(answer(relay().survey(), relay().isSurveying())));
    }

    /** Why the app or its page stopped lately ({@link AppExits}), for Settings › About. */
    @PluginMethod
    public void exits(PluginCall call) {
        JSObject result = new JSObject();
        result.put("stops", AppExits.recent(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void announced(PluginCall call) {
        String tag = call.getString("tag", "");
        getActivity().runOnUiThread(() -> {
            relay().announced(tag);
            call.resolve();
        });
    }
}
