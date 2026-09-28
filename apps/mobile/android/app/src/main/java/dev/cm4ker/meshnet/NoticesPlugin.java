package dev.cm4ker.meshnet;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;
import android.util.Base64;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The web client's notices on Android ({@code lib/notify.ts}), drawn here rather than by
 * Capacitor's LocalNotifications, which can say neither who wrote nor ring with the app's own
 * signal:
 *
 * <ul>
 *   <li>a conversation's notice is a {@link NotificationCompat.MessagingStyle}, each message by its
 *       writer with their circle, and a long-lived shortcut for the chat, so Android files it
 *       under Conversations with the chat's circle and the app's icon as a badge;
 *   <li>the channels (direct messages, channels and rooms, new nodes) ring with the signal the
 *       reader picked, a raw resource ({@code res/raw/signal_*.wav}). A channel's sound is fixed
 *       once it is made, so a new signal makes the three anew under new ids and deletes the old;
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

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    /** The channels, ringing with {@code sound} ({@code signal_<id>.wav}, or none for quiet ones). */
    @PluginMethod
    public void channels(PluginCall call) {
        channels(getContext(), call.getString("sound"));
        call.resolve();
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

        JSObject thread = call.getObject("thread");
        try {
            if (thread != null) converse(builder, tag, thread);
            else {
                Bitmap face = bitmap(call.getString("avatar"));
                if (face != null) builder.setLargeIcon(round(face));
            }
        } catch (JSONException error) {
            // Drawn as a plain notice: what it says is still worth showing.
        }

        try {
            NotificationManagerCompat.from(context).notify(id, builder.build());
            call.resolve();
        } catch (SecurityException refused) {
            call.reject("Notifications are not allowed", refused);
        }
    }

    /**
     * A plain notice of the radio core's, on the page's channel for its kind, under the page's id for its tag;
     * {@code silent} for one after the first of a burst of news.
     */
    static void show(Context context, int id, String tag, String kind, String title, String body, String sound, boolean silent) {
        NotificationCompat.Builder builder = builder(context, id, tag, kind, title, body, sound)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body));
        if (silent) builder.setSilent(true);
        try {
            NotificationManagerCompat.from(context).notify(id, builder.build());
        } catch (SecurityException refused) {
            // Notifications are not allowed: there is nowhere to show it.
        }
    }

    /** What every notice has: its channel and sound, its words, and the tap that opens its chat. */
    private static NotificationCompat.Builder builder(Context context, int id, String tag, String kind, String title, String body, String sound) {
        channels(context, sound);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channelId(kind, sound))
            .setSmallIcon(R.drawable.ic_stat_meshnet)
            .setColor(COLOR)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(opener(context, id, tag));
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

    /** A conversation's notice: its messages by their writers, and the chat's shortcut. */
    private void converse(NotificationCompat.Builder builder, String tag, JSObject thread) throws JSONException {
        Context context = getContext();
        String title = thread.getString("title", "");
        boolean group = thread.getBool("group") != null && thread.getBool("group");
        JSONObject people = thread.getJSObject("people", new JSObject());
        Bitmap chat = bitmap(thread.getString("avatar"));

        Person me = new Person.Builder().setName("You").setKey("me").build();
        NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(me);
        if (group) {
            style.setConversationTitle(title);
            style.setGroupConversation(true);
        }
        Person last = null;
        JSONArray lines = thread.optJSONArray("lines");
        for (int i = 0; lines != null && i < lines.length(); i++) {
            JSONObject line = lines.getJSONObject(i);
            String sender = line.optString("sender", title);
            Person.Builder who = new Person.Builder().setName(sender).setKey(sender);
            Bitmap face = people.isNull(sender) ? null : bitmap(people.optString(sender));
            if (face != null) who.setIcon(IconCompat.createWithBitmap(face));
            last = who.build();
            style.addMessage(line.optString("text", ""), line.optLong("at", System.currentTimeMillis()), last);
        }
        builder.setStyle(style).setCategory(NotificationCompat.CATEGORY_MESSAGE);

        // A long-lived shortcut makes it a conversation: Android draws the chat's circle with the
        // app's badge and lists it under Conversations. Launched from the app's icon, it opens the
        // chat the way a tap on the notice does.
        ShortcutInfoCompat.Builder shortcut = new ShortcutInfoCompat.Builder(context, tag)
            .setShortLabel(title.isEmpty() ? "Chat" : title)
            .setLongLived(true)
            .setIntent(openIntent(context, 0, tag));
        if (chat != null) shortcut.setIcon(IconCompat.createWithBitmap(chat));
        if (!group && last != null) shortcut.setPerson(last);
        try {
            ShortcutManagerCompat.pushDynamicShortcut(context, shortcut.build());
            builder.setShortcutId(tag);
        } catch (RuntimeException refused) {
            // Too many shortcuts or a launcher that keeps none: the notice is still a message one.
        }
    }

    /** The three channels ringing with this sound, and none of ours ringing with another. */
    private static void channels(Context context, String sound) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        Set<String> wanted = new HashSet<>();
        Uri uri = soundUri(context, sound);
        for (String[] kind : KINDS) {
            String id = channelId(kind[0], sound);
            wanted.add(id);
            String word = "channel" + Character.toUpperCase(kind[0].charAt(0)) + kind[0].substring(1);
            String name = Words.get(context, word, kind[1]);
            String description = Words.get(context, word + "Hint", kind[2]);
            NotificationChannel existing = manager.getNotificationChannel(id);
            if (existing != null) {
                // Renamed in the language now. Of a channel that is there Android takes only the name
                // and the description, so the reader's settings for it stay.
                if (!name.contentEquals(existing.getName()) || !description.equals(existing.getDescription())) {
                    NotificationChannel renamed = new NotificationChannel(id, name, existing.getImportance());
                    renamed.setDescription(description);
                    manager.createNotificationChannel(renamed);
                }
                continue;
            }
            NotificationChannel channel = new NotificationChannel(id, name, NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription(description);
            channel.setLockscreenVisibility(NotificationCompat.VISIBILITY_PRIVATE);
            channel.setSound(uri, uri != null ? attributes() : null);
            manager.createNotificationChannel(channel);
        }
        // The ones made for another signal, and the three LocalNotifications made before these,
        // with the bare kind as their id.
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

    private static Bitmap bitmap(String base64) {
        if (base64 == null || base64.isEmpty()) return null;
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (IllegalArgumentException broken) {
            return null;
        }
    }

    /** A large icon is drawn as given, so a circle is cut here, as the page's avatars are. */
    private static Bitmap round(Bitmap square) {
        int side = Math.min(square.getWidth(), square.getHeight());
        Bitmap out = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        canvas.drawCircle(side / 2f, side / 2f, side / 2f, paint);
        paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
        canvas.drawBitmap(square, new Rect(0, 0, side, side), new Rect(0, 0, side, side), paint);
        return out;
    }
}
