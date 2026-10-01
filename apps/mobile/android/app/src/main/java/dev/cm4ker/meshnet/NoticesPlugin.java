package dev.cm4ker.meshnet;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The web client's notices on Android ({@code lib/notify.ts}), drawn here rather than by
 * Capacitor's LocalNotifications, which cannot ring with the app's own signal:
 *
 * <ul>
 *   <li>a notice is words alone under the app's icon. A circle of who wrote stood in for the
 *       app's icon in the shade (gh #49) and crowded the words on a watch the phone passes
 *       notices on to;
 *   <li>the channels (direct messages, channels and rooms, new nodes) ring with the signals the
 *       reader picked, raw resources ({@code res/raw/signal_*.wav}). A channel's sound is fixed
 *       once it is made, so each kind has a channel for each sound it rings with, its own and the
 *       ones its chats have (gh #73), under ids that name the sound; a sound nobody rings with
 *       any more takes its channel with it;
 *   <li>a tap goes to the activity with LocalNotifications' own extras, so the page's listener
 *       for that plugin ({@code localNotificationActionPerformed}) opens the chat, cold start
 *       included.
 * </ul>
 *
 * Also the system's notification settings for the app, and the signal on its own for the app's
 * banner, played on the notification stream so the ringer mode and Do not disturb keep it quiet.
 *
 * <p>The radio core's notices ({@link #show}, from {@link MeshRelay}), for what arrived while the
 * page slept, go on the same channels with the page's tags and ids, so the page's own notice for a
 * chat takes the place of the core's, and a tap on either opens the chat.
 */
@CapacitorPlugin(name = "Notices")
public class NoticesPlugin extends Plugin {
    /**
     * The kinds, each one channel: id prefix, name, description, in English; the page's words for
     * them ({@link Words}) are {@code channel<Kind>} and {@code channel<Kind>Hint}.
     */
    private static final String[][] KINDS = {
        {"direct", "Direct messages", "A message from a person to you."},
        {"chats", "Channels and rooms", "Messages in channels and rooms, or only the ones that mention you."},
        {"nodes", "New nodes", "A node heard for the first time."},
    };

    /** LocalNotifications' intent extras, which its listener reads the tap from. */
    private static final String ID_KEY = "LocalNotificationId";
    private static final String ACTION_KEY = "LocalNotificationUserAction";
    private static final String OBJECT_KEY = "LocalNotficationObject";

    private static final int COLOR = 0xFF74ADE8;

    @Override
    public void load() {
        // Earlier builds made each chat a conversation with a shortcut of its own, which the
        // launcher went on offering; a notice needs none now.
        Context context = getContext();
        try {
            List<String> ids = new ArrayList<>();
            for (ShortcutInfoCompat shortcut : ShortcutManagerCompat.getDynamicShortcuts(context)) ids.add(shortcut.getId());
            if (!ids.isEmpty()) ShortcutManagerCompat.removeLongLivedShortcuts(context, ids);
        } catch (RuntimeException refused) {
            // A launcher that keeps no shortcuts has none to forget.
        }
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    /**
     * The channels the page wants, {@code wanted: [{ kind, sound, label }]}: each kind's own, ringing
     * with {@code sound} ({@code signal_<id>.wav}, or none for a quiet one), and one more for each
     * other sound a chat of that kind rings with, named with its {@code label} after the kind's.
     */
    @PluginMethod
    public void channels(PluginCall call) {
        JSArray wanted = call.getArray("wanted", new JSArray());
        List<String[]> channels = new ArrayList<>();
        for (int i = 0; i < wanted.length(); i++) {
            JSONObject one = wanted.optJSONObject(i);
            if (one != null) channels.add(new String[] {one.optString("kind", "chats"), text(one, "sound"), text(one, "label")});
        }
        channels(getContext(), channels);
        call.resolve();
    }

    /** A string the page may have sent as null, which {@code optString} would read as "null". */
    private static String text(JSONObject object, String key) {
        return object.isNull(key) ? null : object.optString(key);
    }

    @PluginMethod
    public void post(PluginCall call) {
        Context context = getContext();
        Integer id = call.getInt("id");
        String tag = call.getString("tag", "");
        if (id == null) {
            call.reject("A notice needs an id");
            return;
        }
        NotificationCompat.Builder builder =
            builder(context, id, tag, call.getString("kind", "chats"), call.getString("title", ""), call.getString("body", ""), call.getString("sound"));
        // A burst of news rings with its first notice; the rest keep the channel and drop the sound.
        if (Boolean.TRUE.equals(call.getBoolean("silent", false))) builder.setSilent(true);
        try {
            NotificationManagerCompat.from(context).notify(id, builder.build());
            call.resolve();
        } catch (SecurityException refused) {
            call.reject("Notifications are not allowed", refused);
        }
    }

    /**
     * A notice of the radio core's, on the page's channel for its kind, under the page's id for its tag;
     * {@code silent} for one after the first of a burst of news.
     */
    static void show(Context context, int id, String tag, String kind, String title, String body, String sound, boolean silent) {
        NotificationCompat.Builder builder = builder(context, id, tag, kind, title, body, sound);
        if (silent) builder.setSilent(true);
        try {
            NotificationManagerCompat.from(context).notify(id, builder.build());
        } catch (SecurityException refused) {
            // Notifications are not allowed: there is nowhere to show it.
        }
    }

    /**
     * A notice: its channel and sound, its words, whole once opened out, and the tap that opens its
     * chat. A message's is filed as one, which Do not disturb's exceptions for messages go by.
     */
    private static NotificationCompat.Builder builder(Context context, int id, String tag, String kind, String title, String body, String sound) {
        made(context, kind, sound);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channelId(kind, sound))
            .setSmallIcon(R.drawable.ic_stat_meshnet)
            .setColor(COLOR)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(opener(context, id, tag));
        if (!"nodes".equals(kind)) builder.setCategory(NotificationCompat.CATEGORY_MESSAGE);
        // Before Android 8 a notice carries its own sound; after, its channel does.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            Uri uri = soundUri(context, sound);
            if (uri != null) builder.setSound(uri);
            else builder.setSilent(true);
        }
        return builder;
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Integer id = call.getInt("id");
        if (id != null) NotificationManagerCompat.from(getContext()).cancel(id);
        call.resolve();
    }

    /** The signal on its own, for the app's banner: on the notification stream, or a buzz on vibrate. */
    @PluginMethod
    public void chime(PluginCall call) {
        Context context = getContext();
        AudioManager audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        NotificationManager notifications = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        boolean disturbed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
            && notifications.getCurrentInterruptionFilter() > NotificationManager.INTERRUPTION_FILTER_ALL;
        if (disturbed || audio == null) {
            call.resolve();
            return;
        }
        int mode = audio.getRingerMode();
        if (mode == AudioManager.RINGER_MODE_NORMAL) {
            Uri uri = soundUri(context, "signal_" + call.getString("signal", "chirp") + ".wav");
            Ringtone tone = uri != null ? RingtoneManager.getRingtone(context, uri) : null;
            if (tone != null) {
                tone.setAudioAttributes(attributes());
                tone.play();
            }
        } else if (mode == AudioManager.RINGER_MODE_VIBRATE) {
            Vibrator vibrator = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                try {
                    vibrator.vibrate(VibrationEffect.createOneShot(60, VibrationEffect.DEFAULT_AMPLITUDE));
                } catch (SecurityException refused) {
                    // No vibration permission in this build: the banner still shows.
                }
            }
        }
        call.resolve();
    }

    /** These channels, each {@code { kind, sound, label }}, and none of ours ringing with another sound. */
    private static void channels(Context context, List<String[]> channels) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        Set<String> wanted = new HashSet<>();
        for (String[] channel : channels) wanted.add(channel(context, manager, channel[0], channel[1], channel[2], true));
        // The ones made for a sound nobody rings with any more, and the three LocalNotifications
        // made before these, with the bare kind as their id.
        for (NotificationChannel channel : manager.getNotificationChannels()) {
            String id = channel.getId();
            if (wanted.contains(id)) continue;
            for (String[] kind : KINDS) {
                if (id.equals(kind[0]) || id.startsWith(kind[0] + ".")) {
                    manager.deleteNotificationChannel(id);
                    break;
                }
            }
        }
    }

    /**
     * The channel a notice goes on, made when the page has not had it made yet (the radio core may
     * post first after the app starts again): named after its kind alone until the page names it.
     */
    private static void made(Context context, String kind, String sound) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) channel(context, manager, kind, sound, null, false);
    }

    /**
     * The channel of a kind ringing with a sound, made when it is not there and, when
     * {@code rename}, named in the language now, with the sound's {@code label} after the kind's
     * name when it is not the kind's own; its id. Of a channel that is there Android takes only
     * the name and the description, so the reader's settings for it stay.
     */
    private static String channel(Context context, NotificationManager manager, String kind, String sound, String label, boolean rename) {
        String[] english = KINDS[1];
        for (String[] k : KINDS) if (k[0].equals(kind)) english = k;
        String id = channelId(english[0], sound);
        String word = "channel" + Character.toUpperCase(english[0].charAt(0)) + english[0].substring(1);
        String name = Words.get(context, word, english[1]) + (label == null ? "" : " · " + label);
        String description = Words.get(context, word + "Hint", english[2]);
        NotificationChannel existing = manager.getNotificationChannel(id);
        if (existing != null) {
            if (rename && (!name.contentEquals(existing.getName()) || !description.equals(existing.getDescription()))) {
                NotificationChannel renamed = new NotificationChannel(id, name, existing.getImportance());
                renamed.setDescription(description);
                manager.createNotificationChannel(renamed);
            }
            return id;
        }
        Uri uri = soundUri(context, sound);
        NotificationChannel channel = new NotificationChannel(id, name, NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription(description);
        channel.setLockscreenVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        channel.setSound(uri, uri != null ? attributes() : null);
        manager.createNotificationChannel(channel);
        return id;
    }

    private static String channelId(String kind, String sound) {
        return kind + "." + (sound == null ? "quiet" : sound.replace(".wav", ""));
    }

    /** A raw resource by its file name, {@code signal_chirp.wav}; null when there is none. */
    private static Uri soundUri(Context context, String sound) {
        if (sound == null) return null;
        int res = context.getResources().getIdentifier(sound.replace(".wav", ""), "raw", context.getPackageName());
        return res == 0 ? null : Uri.parse("android.resource://" + context.getPackageName() + "/" + res);
    }

    private static AudioAttributes attributes() {
        return new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
    }

    private static PendingIntent opener(Context context, int id, String tag) {
        return PendingIntent.getActivity(context, id, openIntent(context, id, tag), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** To the app, carrying the tag the way LocalNotifications' taps do. */
    private static Intent openIntent(Context context, int id, String tag) {
        String object;
        try {
            object = new JSONObject().put("id", id).put("extra", new JSONObject().put("tag", tag)).toString();
        } catch (JSONException impossible) {
            object = "{}";
        }
        return new Intent(context, MainActivity.class)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(ID_KEY, id)
            .putExtra(ACTION_KEY, "tap")
            .putExtra(OBJECT_KEY, object);
    }
}
