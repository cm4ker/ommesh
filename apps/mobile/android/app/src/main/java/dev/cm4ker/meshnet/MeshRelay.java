package dev.cm4ker.meshnet;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothStatusCodes;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Base64;
import android.util.Log;
import androidx.core.app.NotificationManagerCompat;
import dev.cm4ker.meshnet.core.Client;
import dev.cm4ker.meshnet.core.Effect;
import dev.cm4ker.meshnet.core.Inbox;
import dev.cm4ker.meshnet.core.Notice;
import dev.cm4ker.meshnet.core.Radio;
import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The app's link to its radio on Android, and the radio shared with a computer nearby through
 * the phone: the Android side of the iOS app's {@code MeshRelay.swift}.
 *
 * <p>The page talks to its radio through here, and the radio core ({@code crates/meshcore-core},
 * {@link Radio}) decides whose command goes to the radio when and whose an answer is, reads the
 * radio's message queue into an inbox per client, and announces what the page leaves unread
 * while it sleeps: Android stops the page's scripts about a minute after the app leaves the
 * screen. While linked, {@link MeshRelayService} keeps the app running in the background, so
 * the messages keep coming, and their notices with them.
 *
 * <p>Shared with a computer, the phone serves the same UART service the radio does (Nordic UART,
 * {@code 6E400001…}), so a computer connects to the phone as if it were the radio, with the
 * client it already has, and the core takes turns between the two. The framing is BLE's own, one
 * frame per write or notification.
 *
 * <p>The radio is held by this object's own GATT client, on the link the BLE plugin already
 * made: Android shares one link between the clients on it. The page's plugin stays connected (it
 * is how the page learns of a drop) but the page's frames come and go through here. With
 * autoConnect, this client comes back by itself when the radio does, the page asleep or not.
 *
 * <p>Both characteristics demand an encrypted link, so a computer has to be paired with the
 * phone first: Android asks on its own screen. Android advertises under the phone's own
 * Bluetooth name, which is what the computer lists.
 *
 * <p>Everything runs on the main thread; the Bluetooth callbacks hop there first.
 */
@SuppressLint("MissingPermission") // The plugin asks for Bluetooth before start().
final class MeshRelay {
    private static final String TAG = "MeshRelay";
    private static final UUID SERVICE = UUID.fromString("6E400001-B5A3-F393-E0A9-E50E24DCCA9E");
    private static final UUID RX = UUID.fromString("6E400002-B5A3-F393-E0A9-E50E24DCCA9E");
    private static final UUID TX = UUID.fromString("6E400003-B5A3-F393-E0A9-E50E24DCCA9E");
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final String PREFS = "meshnet.relay";
    private static final String INBOXES_KEY = "inboxes";
    /** The page's notice settings and names for the core, and the signal its notices ring with. */
    private static final String WATCH_KEY = "watch";
    private static final String SOUND_KEY = "sound";

    interface Listener {
        /** Every change: whether a radio is linked and up, whether it is shared, and whether a computer is connected. */
        void changed();

        void pageFrame(byte[] frame);
    }

    @SuppressLint("StaticFieldLeak") // The application context, which lives as long as the process.
    private static MeshRelay shared;

    static MeshRelay shared(Context context) {
        if (shared == null) shared = new MeshRelay(context.getApplicationContext());
        return shared;
    }

    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Radio core;
    private Listener listener;
    /** The page's writes waiting to hear they went, by the number the core knows them by. */
    private final Map<Long, Runnable> writes = new HashMap<>();
    private long lastWrite = 0;

    private BluetoothGattServer server;
    private BluetoothGattCharacteristic served;
    private boolean published = false;
    private boolean advertising = false;

    private String radioAddress;
    /** What the notice about the link calls the radio. */
    private String radioName = "the radio";
    private boolean sharing = false;
    private BluetoothGatt radio;
    private BluetoothGattCharacteristic radioRx;
    /** Frames for the radio; Android takes one GATT operation at a time. */
    private final ArrayDeque<byte[]> radioWrites = new ArrayDeque<>();
    private boolean radioWriting = false;
    /**
     * Whether this client's own MTU request is out. A client that joins a link the plugin already
     * made hears the link's MTU at once, before it has asked; taken for the answer, discovery and
     * the subscription went out while the request was still pending, and Android drops a second
     * operation on a busy link without a word ("already has a pending command"). The client then
     * waited for a callback that never came, and the radio was never read.
     */
    private volatile boolean mtuAsked = false;
    /** Discovery goes on after this if the MTU exchange never answers. */
    private final Runnable mtuTimeout = () -> {
        mtuAsked = false;
        if (radio != null && radioRx == null) radio.discoverServices();
    };
    /** Times the radio's client was made anew because its subscription never answered. */
    private int remakes = 0;
    private static final int REMAKES = 3;
    /**
     * A subscription with no answer leaves the client busy for good: Android turns away every
     * later operation on it. The client is made anew instead.
     */
    private final Runnable subscribeTimeout = new Runnable() {
        @Override
        public void run() {
            if (radio == null || radioSubscribed) return;
            // A PIN being typed holds the subscription up; it answers once the pairing is done.
            if (radio.getDevice().getBondState() == BluetoothDevice.BOND_BONDING) {
                main.postDelayed(this, SUBSCRIBE_MS);
                return;
            }
            remakeRadio();
        }
    };
    private static final long SUBSCRIBE_MS = 6000;
    /** Whether the radio's TX notifies here, so the core has been told the radio is up. */
    private boolean radioSubscribed = false;
    /** Discoveries that came back without the UART service; tried again a few times, a second apart. */
    private int discoveries = 0;
    private final Runnable rediscover = () -> {
        if (radio != null && radioRx == null) radio.discoverServices();
    };

    private BluetoothDevice computer;
    private int computerMtu = 23;
    /** Notifications for the computer, one at a time: the next goes when Android says the last went. */
    private final ArrayDeque<byte[]> backlog = new ArrayDeque<>();
    private boolean notifying = false;
    /** Tries of the frame at the head of a queue Android turned away; it is dropped after {@link #TRIES}. */
    private int notifyTries = 0;
    private int writeTries = 0;
    private static final int TRIES = 50;
    /** A long write from the computer, in pieces, until it is executed. */
    private final ByteArrayOutputStream prepared = new ByteArrayOutputStream();

    private boolean watchingAdapter = false;

    private MeshRelay(Context context) {
        this.context = context;
        core = new Radio(loadInboxes());
        String watch = prefs().getString(WATCH_KEY, null);
        if (watch != null) run(core.configure(watch));
    }

    void setListener(Listener listener) {
        this.listener = listener;
    }

    /** A page that is gone no longer hears; a newer page's listener stays. */
    void clearListener(Listener gone) {
        if (listener == gone) listener = null;
    }

    /** Linked to a radio for the page. */
    boolean isOn() {
        return radioAddress != null;
    }

    boolean isSharing() {
        return isOn() && sharing;
    }

    /** The radio linked for the page, by its Bluetooth address; null when none is. */
    String radioAddress() {
        return radioAddress;
    }

    /** The linked radio's TX notifies here: a page's frames go to it at once. */
    boolean isUp() {
        return radio != null && radioSubscribed;
    }

    boolean hasComputer() {
        return computer != null;
    }

    private boolean radioUp() {
        return radio != null && radioRx != null;
    }

    private void changed() {
        if (listener != null) listener.changed();
        if (isOn()) MeshRelayService.update(context, state());
    }

    private MeshRelayService.State state() {
        return new MeshRelayService.State(radioName, radioUp(), isSharing(), hasComputer());
    }

    // The core asks; this does.

    private void run(List<Effect> effects) {
        for (Effect effect : effects) {
            if (effect instanceof Effect.ToRadio) {
                writeRadio(((Effect.ToRadio) effect).getFrame());
            } else if (effect instanceof Effect.ToClient) {
                Effect.ToClient to = (Effect.ToClient) effect;
                if (to.getClient() == Client.COMPUTER) {
                    toComputer(to.getFrame());
                } else if (listener != null) {
                    listener.pageFrame(to.getFrame());
                }
            } else if (effect instanceof Effect.Written) {
                Runnable done = writes.remove(((Effect.Written) effect).getWrite());
                if (done != null) done.run();
            } else if (effect instanceof Effect.Wait) {
                Effect.Wait wait = (Effect.Wait) effect;
                main.postDelayed(() -> run(core.timeout(wait.getTimer())), wait.getMillis());
            } else if (effect instanceof Effect.InboxesChanged) {
                saveInboxes();
            } else if (effect instanceof Effect.Post) {
                Notice notice = ((Effect.Post) effect).getNotice();
                NoticesPlugin.show(context, notice.getId(), notice.getTag(), kind(notice), notice.getTitle(), notice.getBody(),
                    prefs().getString(SOUND_KEY, null));
            } else if (effect instanceof Effect.Withdraw) {
                NotificationManagerCompat.from(context).cancel(((Effect.Withdraw) effect).getId());
            } else if (effect instanceof Effect.Log) {
                Log.w(TAG, ((Effect.Log) effect).getLine());
            }
        }
    }

    /** The notice's channel, as the page names it. */
    private static String kind(Notice notice) {
        switch (notice.getKind()) {
            case DIRECT:
                return "direct";
            case NODES:
                return "nodes";
            default:
                return "chats";
        }
    }

    // The inboxes outlive the app: the radio's copy of a message is gone once the core has read it.

    private List<Inbox> loadInboxes() {
        List<Inbox> inboxes = new ArrayList<>();
        String text = prefs().getString(INBOXES_KEY, null);
        if (text == null) return inboxes;
        try {
            JSONObject saved = new JSONObject(text);
            for (Client client : Client.values()) {
                JSONArray frames = saved.optJSONArray(key(client));
                if (frames == null) continue;
                List<byte[]> list = new ArrayList<>();
                for (int i = 0; i < frames.length(); i++) list.add(Base64.decode(frames.getString(i), Base64.NO_WRAP));
                inboxes.add(new Inbox(client, list));
            }
        } catch (JSONException | IllegalArgumentException e) {
            Log.w(TAG, "the saved inboxes could not be read", e);
        }
        return inboxes;
    }

    private void saveInboxes() {
        JSONObject saved = new JSONObject();
        try {
            for (Inbox inbox : core.inboxes()) {
                JSONArray frames = new JSONArray();
                for (byte[] frame : inbox.getFrames()) frames.put(Base64.encodeToString(frame, Base64.NO_WRAP));
                saved.put(key(inbox.getClient()), frames);
            }
        } catch (JSONException e) {
            Log.w(TAG, "the inboxes could not be saved", e);
            return;
        }
        prefs().edit().putString(INBOXES_KEY, saved.toString()).apply();
    }

    /** Where a client's inbox is saved, as before the core: {@code page} and {@code computer}. */
    private static String key(Client client) {
        return client == Client.COMPUTER ? "computer" : "page";
    }

    /** The page's last settings for the core, words included (see {@link Words}); null before the page has said. */
    static String savedWatch(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(WATCH_KEY, null);
    }

    private SharedPreferences prefs() {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * Links to the radio the page is connected to (the BLE plugin's id: its address), and shares it
     * with a computer if {@code share}.
     */
    void start(String address, String name, boolean share) {
        remakes = 0;
        if (!address.equals(radioAddress)) {
            releaseRadio();
            radioAddress = address;
        }
        if (name != null && !name.isEmpty()) radioName = name;
        sharing = share;
        watchAdapter();
        MeshRelayService.start(context, state());
        attachRadio();
        if (sharing) {
            publish();
        } else {
            unpublish();
            dropComputer();
        }
        changed();
    }

    /** Shares the linked radio with a computer, or stops. */
    void share(boolean on) {
        sharing = on;
        if (!isOn()) return;
        if (on) {
            publish();
        } else {
            unpublish();
            dropComputer();
        }
        changed();
    }

    /** Lets go of the radio: no link, no sharing, and the app is free to stop in the background. */
    void stop() {
        radioAddress = null;
        sharing = false;
        unpublish();
        dropComputer();
        run(core.detach(Client.PAGE));
        releaseRadio();
        MeshRelayService.stop(context);
        changed();
    }

    // The page

    void attachPage() {
        run(core.attach(Client.PAGE));
    }

    void detachPage() {
        run(core.detach(Client.PAGE));
    }

    /** {@code dispatched} is called once the frame has gone to the radio, or been answered here. */
    void fromPage(byte[] frame, Runnable dispatched) {
        if (!isOn()) {
            dispatched.run();
            return;
        }
        long write = ++lastWrite;
        writes.put(write, dispatched);
        run(core.fromClient(Client.PAGE, frame, write));
    }

    /**
     * The page's notice settings and names, as the JSON the core reads ({@code WatchConfig}), and the
     * signal file its notices ring with; kept, for a process Android starts again without the page.
     */
    void configure(String json, String sound) {
        prefs().edit().putString(WATCH_KEY, json).putString(SOUND_KEY, sound).apply();
        run(core.configure(json));
    }

    /** The app left the screen, or came back to it: the core announces what the page misses meanwhile. */
    void setBackground(boolean background) {
        run(core.setBackground(background));
    }

    /** The page announced this tag itself. */
    void announced(String tag) {
        run(core.announced(tag));
    }

    // The computer's side

    private BluetoothManager manager() {
        return (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
    }

    private boolean poweredOn() {
        BluetoothManager manager = manager();
        BluetoothAdapter adapter = manager != null ? manager.getAdapter() : null;
        return adapter != null && adapter.isEnabled();
    }

    private void publish() {
        if (!isSharing() || !poweredOn()) return;
        if (published) {
            advertise();
            return;
        }
        server = manager().openGattServer(context, serverCallback);
        if (server == null) {
            Log.w(TAG, "no GATT server");
            return;
        }
        BluetoothGattCharacteristic rx = new BluetoothGattCharacteristic(
            RX,
            BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_WRITE_ENCRYPTED
        );
        BluetoothGattCharacteristic tx = new BluetoothGattCharacteristic(
            TX,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_READ_ENCRYPTED
        );
        tx.addDescriptor(new BluetoothGattDescriptor(
            CCCD,
            BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE_ENCRYPTED
        ));
        BluetoothGattService service = new BluetoothGattService(SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY);
        service.addCharacteristic(rx);
        service.addCharacteristic(tx);
        served = tx;
        published = true;
        server.addService(service);
    }

    private void unpublish() {
        stopAdvertising();
        if (server != null) {
            if (computer != null) server.cancelConnection(computer);
            server.close();
        }
        server = null;
        served = null;
        published = false;
    }

    private BluetoothLeAdvertiser advertiser() {
        BluetoothManager manager = manager();
        BluetoothAdapter adapter = manager != null ? manager.getAdapter() : null;
        return adapter != null ? adapter.getBluetoothLeAdvertiser() : null;
    }

    /** Only while no computer is connected: this serves one, as the firmware does. */
    private void advertise() {
        if (!isSharing() || !published || computer != null || advertising || !poweredOn()) return;
        BluetoothLeAdvertiser advertiser = advertiser();
        if (advertiser == null) {
            Log.w(TAG, "this phone cannot advertise");
            return;
        }
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true)
            .setTimeout(0)
            .build();
        // The 128-bit service takes most of the advert; the name, which the computer lists, goes in the scan response.
        AdvertiseData data = new AdvertiseData.Builder().addServiceUuid(new ParcelUuid(SERVICE)).build();
        AdvertiseData response = new AdvertiseData.Builder().setIncludeDeviceName(true).build();
        advertising = true;
        advertiser.startAdvertising(settings, data, response, advertiseCallback);
    }

    private void stopAdvertising() {
        if (!advertising) return;
        advertising = false;
        BluetoothLeAdvertiser advertiser = advertiser();
        if (advertiser != null && poweredOn()) advertiser.stopAdvertising(advertiseCallback);
    }

    private final AdvertiseCallback advertiseCallback = new AdvertiseCallback() {
        @Override
        public void onStartFailure(int errorCode) {
            main.post(() -> {
                if (errorCode == ADVERTISE_FAILED_ALREADY_STARTED) return;
                Log.w(TAG, "advertising failed: " + errorCode);
                advertising = false;
            });
        }
    };

    private void attachComputer(BluetoothDevice device) {
        Log.i(TAG, "computer subscribed: " + device.getAddress());
        if (computer != null && computer.equals(device)) return;
        computer = device;
        backlog.clear();
        notifying = false;
        stopAdvertising();
        run(core.attach(Client.COMPUTER));
        attachRadio();
        changed();
    }

    private void dropComputer() {
        if (computer == null) return;
        computer = null;
        computerMtu = 23;
        backlog.clear();
        notifying = false;
        prepared.reset();
        run(core.detach(Client.COMPUTER));
        advertise();
        changed();
    }

    private void toComputer(byte[] frame) {
        if (computer == null) return;
        backlog.add(frame);
        if (!notifying) sendNext();
    }

    @SuppressWarnings("deprecation") // setValue and the three-argument notify are what Android before 13 has.
    private void sendNext() {
        byte[] frame = backlog.poll();
        if (frame == null || server == null || served == null || computer == null) {
            notifying = false;
            return;
        }
        if (frame.length > computerMtu - 3) {
            Log.w(TAG, "a " + frame.length + "-byte frame does not fit the computer's MTU of " + computerMtu);
        }
        boolean queued;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            queued = server.notifyCharacteristicChanged(computer, served, false, frame) == BluetoothStatusCodes.SUCCESS;
        } else {
            served.setValue(frame);
            queued = server.notifyCharacteristicChanged(computer, served, false);
        }
        notifying = true;
        if (queued) {
            notifyTries = 0;
        } else if (++notifyTries < TRIES) {
            // Android is busy; tried again shortly.
            backlog.addFirst(frame);
            main.postDelayed(this::sendNext, 20);
        } else {
            Log.w(TAG, "a frame for the computer was dropped");
            notifyTries = 0;
            main.post(this::sendNext);
        }
    }

    private final BluetoothGattServerCallback serverCallback = new BluetoothGattServerCallback() {
        @Override
        public void onServiceAdded(int status, BluetoothGattService service) {
            main.post(() -> {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    Log.w(TAG, "the service was not published: " + status);
                    published = false;
                    return;
                }
                advertise();
            });
        }

        @Override
        public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
            Log.i(TAG, "computer " + device.getAddress() + " state " + newState + " status " + status);
            main.post(() -> {
                if (newState == BluetoothProfile.STATE_DISCONNECTED && device.equals(computer)) dropComputer();
            });
        }

        @Override
        public void onMtuChanged(BluetoothDevice device, int mtu) {
            main.post(() -> {
                if (device.equals(computer) || computer == null) computerMtu = mtu;
            });
        }

        /** Nothing here is readable, but every request is answered: one left unanswered stalls the computer's discovery. */
        @Override
        public void onCharacteristicReadRequest(BluetoothDevice device, int requestId, int offset, BluetoothGattCharacteristic characteristic) {
            Log.i(TAG, "computer reads " + characteristic.getUuid());
            respond(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, new byte[0]);
        }

        @Override
        public void onDescriptorReadRequest(BluetoothDevice device, int requestId, int offset, BluetoothGattDescriptor descriptor) {
            Log.i(TAG, "computer reads descriptor " + descriptor.getUuid());
            byte[] value = device.equals(computer)
                ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                : BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE;
            respond(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, value);
        }

        @Override
        public void onDescriptorWriteRequest(
            BluetoothDevice device,
            int requestId,
            BluetoothGattDescriptor descriptor,
            boolean preparedWrite,
            boolean responseNeeded,
            int offset,
            byte[] value
        ) {
            Log.i(TAG, "computer writes descriptor " + descriptor.getUuid());
            if (responseNeeded) respond(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null);
            if (!CCCD.equals(descriptor.getUuid()) || !TX.equals(descriptor.getCharacteristic().getUuid())) return;
            boolean subscribed = value != null && value.length > 0 && (value[0] & 0x01) != 0;
            main.post(() -> {
                if (subscribed) {
                    attachComputer(device);
                } else if (device.equals(computer)) {
                    dropComputer();
                }
            });
        }

        @Override
        public void onCharacteristicWriteRequest(
            BluetoothDevice device,
            int requestId,
            BluetoothGattCharacteristic characteristic,
            boolean preparedWrite,
            boolean responseNeeded,
            int offset,
            byte[] value
        ) {
            Log.d(TAG, "computer writes " + (value == null ? 0 : value.length) + " bytes");
            if (responseNeeded) respond(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value);
            if (!RX.equals(characteristic.getUuid()) || value == null) return;
            main.post(() -> {
                if (!device.equals(computer)) return;
                if (preparedWrite) {
                    // A frame longer than the link's MTU comes as a long write, in pieces with offsets.
                    prepared.write(value, 0, value.length);
                } else if (value.length > 0) {
                    run(core.fromClient(Client.COMPUTER, value, null));
                }
            });
        }

        @Override
        public void onExecuteWrite(BluetoothDevice device, int requestId, boolean execute) {
            Log.i(TAG, "computer executes a long write: " + execute);
            respond(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null);
            main.post(() -> {
                byte[] frame = prepared.toByteArray();
                prepared.reset();
                if (execute && frame.length > 0 && device.equals(computer)) run(core.fromClient(Client.COMPUTER, frame, null));
            });
        }

        @Override
        public void onNotificationSent(BluetoothDevice device, int status) {
            main.post(MeshRelay.this::sendNext);
        }
    };

    private void respond(BluetoothDevice device, int requestId, int status, int offset, byte[] value) {
        BluetoothGattServer server = this.server;
        if (server != null) server.sendResponse(device, requestId, status, offset, value);
    }

    // The radio's side

    private void attachRadio() {
        if (!isOn() || radio != null || !poweredOn()) return;
        BluetoothDevice device;
        try {
            device = manager().getAdapter().getRemoteDevice(radioAddress);
        } catch (IllegalArgumentException e) {
            Log.w(TAG, radioAddress + " is not a Bluetooth address");
            return;
        }
        forgetLink();
        // Joins the link the plugin already has; with autoConnect, waits for a radio out of range.
        radio = device.connectGatt(context, true, radioCallback, BluetoothDevice.TRANSPORT_LE);
    }

    private void releaseRadio() {
        run(core.radioDown());
        forgetLink();
        if (radio == null) return;
        radio.disconnect();
        radio.close();
        radio = null;
    }

    private void remakeRadio() {
        if (++remakes > REMAKES) {
            Log.w(TAG, "the radio's TX never subscribed; given up");
            return;
        }
        Log.w(TAG, "the radio's TX did not answer; its client is made anew");
        releaseRadio();
        attachRadio();
    }

    /** Only called while the radio is up: the core holds commands until then. */
    private void writeRadio(byte[] frame) {
        if (radio == null || radioRx == null) {
            Log.w(TAG, "a frame for the radio with no radio");
            return;
        }
        radioWrites.add(frame);
        if (!radioWriting) writeNext();
    }

    @SuppressWarnings("deprecation") // setValue and the one-argument write are what Android before 13 has.
    private void writeNext() {
        byte[] frame = radioWrites.poll();
        if (frame == null || radio == null || radioRx == null) {
            radioWriting = false;
            return;
        }
        // With response, as the page writes: the characteristic demands encryption.
        boolean started;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            started = radio.writeCharacteristic(radioRx, frame, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS;
        } else {
            radioRx.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            radioRx.setValue(frame);
            started = radio.writeCharacteristic(radioRx);
        }
        radioWriting = true;
        if (started) {
            writeTries = 0;
        } else if (++writeTries < TRIES) {
            // Another operation on the link is still going; tried again shortly.
            radioWrites.addFirst(frame);
            main.postDelayed(this::writeNext, 20);
        } else {
            Log.w(TAG, "a frame for the radio was dropped");
            writeTries = 0;
            main.post(this::writeNext);
        }
    }

    @SuppressWarnings("deprecation")
    private void subscribeRadio(BluetoothGatt gatt, BluetoothGattCharacteristic tx) {
        gatt.setCharacteristicNotification(tx, true);
        BluetoothGattDescriptor cccd = tx.getDescriptor(CCCD);
        if (cccd == null) {
            // Nothing to write: notifications flow as they are.
            radioReady(gatt);
            return;
        }
        main.removeCallbacks(subscribeTimeout);
        main.postDelayed(subscribeTimeout, SUBSCRIBE_MS);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
        } else {
            cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
            gatt.writeDescriptor(cccd);
        }
    }

    /** The radio is up once its TX notifies here: then the waiting commands go. */
    private void radioReady(BluetoothGatt gatt) {
        if (gatt != radio || radioRx == null) return;
        main.removeCallbacks(subscribeTimeout);
        radioSubscribed = true;
        remakes = 0;
        run(core.radioUp());
        changed();
    }

    /** What one link to the radio knew, forgotten when it goes. */
    private void forgetLink() {
        main.removeCallbacks(mtuTimeout);
        main.removeCallbacks(rediscover);
        main.removeCallbacks(subscribeTimeout);
        mtuAsked = false;
        discoveries = 0;
        radioSubscribed = false;
        radioRx = null;
        radioWrites.clear();
        radioWriting = false;
    }

    private final BluetoothGattCallback radioCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            main.post(() -> {
                if (gatt != radio) return;
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    // The plugin asked for the same on this link; asked again for a link this made itself.
                    mtuAsked = true;
                    if (gatt.requestMtu(512)) {
                        main.postDelayed(mtuTimeout, 2000);
                    } else {
                        mtuAsked = false;
                        gatt.discoverServices();
                    }
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    forgetLink();
                    run(core.radioDown());
                    changed();
                    // An autoConnect client reconnects by itself when the radio is back.
                }
            });
        }

        @Override
        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
            // Heard before the request went out: the link's MTU told to a client that has just joined it.
            if (!mtuAsked) return;
            main.post(() -> {
                if (gatt != radio || radioRx != null || !mtuAsked) return;
                mtuAsked = false;
                main.removeCallbacks(mtuTimeout);
                gatt.discoverServices();
            });
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            main.post(() -> {
                if (gatt != radio) return;
                BluetoothGattService service = gatt.getService(SERVICE);
                if (status != BluetoothGatt.GATT_SUCCESS || service == null) {
                    // Right after the link comes up, Android can answer from a discovery still under way.
                    Log.w(TAG, "the radio's UART service was not found: " + status);
                    if (++discoveries < 5) main.postDelayed(rediscover, 1000);
                    return;
                }
                discoveries = 0;
                radioRx = service.getCharacteristic(RX);
                BluetoothGattCharacteristic tx = service.getCharacteristic(TX);
                if (radioRx == null || tx == null) {
                    Log.w(TAG, "the radio's UART service is missing RX or TX");
                    return;
                }
                subscribeRadio(gatt, tx);
            });
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
            main.post(() -> {
                if (!CCCD.equals(descriptor.getUuid())) return;
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    Log.w(TAG, "the radio's TX did not subscribe: " + status);
                    return;
                }
                radioReady(gatt);
            });
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            main.post(() -> {
                if (gatt != radio) return;
                if (status != BluetoothGatt.GATT_SUCCESS) Log.w(TAG, "a write to the radio failed: " + status);
                writeNext();
            });
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value) {
            received(gatt, characteristic, value);
        }

        @Override
        @SuppressWarnings("deprecation") // Android before 13 calls this one, with the value on the characteristic.
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) received(gatt, characteristic, characteristic.getValue());
        }

        private void received(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value) {
            if (!TX.equals(characteristic.getUuid()) || value == null || value.length == 0) return;
            byte[] frame = value.clone();
            main.post(() -> {
                if (gatt == radio) run(core.fromRadio(frame));
            });
        }
    };

    // Bluetooth turned off and on

    private void watchAdapter() {
        if (watchingAdapter) return;
        watchingAdapter = true;
        IntentFilter filter = new IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED);
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                int state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR);
                if (state == BluetoothAdapter.STATE_TURNING_OFF || state == BluetoothAdapter.STATE_OFF) {
                    adapterOff();
                } else if (state == BluetoothAdapter.STATE_ON) {
                    attachRadio();
                    publish();
                }
            }
        };
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            context.registerReceiver(receiver, filter);
        }
    }

    /** A Bluetooth restart takes the published service and both links with it. */
    private void adapterOff() {
        advertising = false;
        if (server != null) server.close();
        server = null;
        served = null;
        published = false;
        dropComputer();
        if (radio != null) radio.close();
        radio = null;
        forgetLink();
        run(core.radioDown());
        changed();
    }
}
