package dev.cm4ker.meshnet;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps the app running while it is linked to a radio ({@link MeshRelay}), with the app in the
 * background or swiped away: a foreground service of the connected-device kind, with the notice
 * Android requires for one. Without it Android may stop or freeze the app soon after it leaves
 * the screen, and the radio's messages would wait unread. It holds nothing itself; the link
 * lives in the process.
 *
 * <p>While a coverage survey runs it is of the location kind as well: Android hands the phone's
 * position to an app out of sight only through such a service, and only one started while the
 * app was on screen, as a survey is.
 */
public class MeshRelayService extends Service {
    private static final String TAG = "MeshRelay";
    private static final String CHANNEL = "link";
    /** The channel of the notice from when it only showed while the radio was shared. */
    private static final String OLD_CHANNEL = "relay";
    private static final int NOTICE_ID = 0x4d52;
    private static final String EXTRA_NAME = "name";
    private static final String EXTRA_UP = "up";
    private static final String EXTRA_SHARING = "sharing";
    private static final String EXTRA_COMPUTER = "computer";
    private static final String EXTRA_SURVEY = "survey";

    /** What the notice says: which radio, and how it is. */
    static final class State {
        final String name;
        final boolean up;
        final boolean sharing;
        final boolean computer;
        /** A coverage survey runs. */
        final boolean survey;

        State(String name, boolean up, boolean sharing, boolean computer, boolean survey) {
            this.name = name;
            this.up = up;
            this.sharing = sharing;
            this.computer = computer;
            this.survey = survey;
        }
    }

    static void start(Context context, State state) {
        Intent intent = new Intent(context, MeshRelayService.class)
            .putExtra(EXTRA_NAME, state.name)
            .putExtra(EXTRA_UP, state.up)
            .putExtra(EXTRA_SHARING, state.sharing)
            .putExtra(EXTRA_COMPUTER, state.computer)
            .putExtra(EXTRA_SURVEY, state.survey);
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (RuntimeException e) {
            // Refused from the background (Android 12 and later): the link still works while the app is open.
            Log.w(TAG, "the background service did not start", e);
        }
    }

    /** A new line in the notice, when the radio or a computer comes or goes. */
    static void update(Context context, State state) {
        NotificationManager notices = context.getSystemService(NotificationManager.class);
        if (notices != null && notices.areNotificationsEnabled()) notices.notify(NOTICE_ID, notice(context, state));
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, MeshRelayService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        State state = intent == null
            ? new State(null, false, false, false, false)
            : new State(
                intent.getStringExtra(EXTRA_NAME),
                intent.getBooleanExtra(EXTRA_UP, false),
                intent.getBooleanExtra(EXTRA_SHARING, false),
                intent.getBooleanExtra(EXTRA_COMPUTER, false),
                intent.getBooleanExtra(EXTRA_SURVEY, false)
            );
        Notification notice = notice(this, state);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                if (!state.survey || !locating(notice)) startForeground(NOTICE_ID, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            } else {
                startForeground(NOTICE_ID, notice);
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "the background service was refused", e);
            stopSelf();
            return START_NOT_STICKY;
        }
        // Not restarted by Android after the process dies: the link went with it.
        return START_NOT_STICKY;
    }

    /**
     * Takes the location kind beside the connected-device one, for a survey. Android refuses it
     * without leave to read the position, or when the service was not started from the screen;
     * the survey then only runs while the app is open, and the link stays as it was.
     */
    private boolean locating(Notification notice) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false;
        try {
            startForeground(NOTICE_ID, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE | ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            return true;
        } catch (RuntimeException e) {
            Log.w(TAG, "the background service may not read the phone's position", e);
            return false;
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private static Notification notice(Context context, State state) {
        NotificationManager notices = context.getSystemService(NotificationManager.class);
        if (notices != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && notices.getNotificationChannel(CHANNEL) == null) {
            notices.deleteNotificationChannel(OLD_CHANNEL);
        }
        // Made again each time: the same id keeps the reader's settings, and takes the name in the language now.
        if (notices != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, Words.get(context, "relayChannel", "Radio connection"), NotificationManager.IMPORTANCE_LOW);
            channel.setDescription(Words.get(context, "relayChannelHint", "Shown while the app keeps the radio connected in the background."));
            channel.setShowBadge(false);
            notices.createNotificationChannel(channel);
        }
        String name = state.name == null || state.name.isEmpty() ? Words.get(context, "relayTheRadio", "the radio") : state.name;
        String title;
        String text;
        if (!state.up) {
            title = Words.get(context, "relayReconnecting", "Reconnecting to {name}", name);
            text = Words.get(context, "relayWaitingRadio", "Waiting for the radio");
        } else if (state.sharing) {
            title = Words.get(context, "relaySharing", "Sharing {name}", name);
            text = state.computer ? Words.get(context, "relayComputer", "A computer is connected") : Words.get(context, "relayWaitingComputer", "Waiting for a computer");
        } else if (state.survey) {
            title = Words.get(context, "relayConnected", "Connected to {name}", name);
            text = Words.get(context, "relaySurvey", "Coverage survey running");
        } else {
            title = Words.get(context, "relayConnected", "Connected to {name}", name);
            text = Words.get(context, "relayAppClosed", "Messages arrive with the app closed");
        }
        Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        PendingIntent tap = open == null ? null : PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_meshnet)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(tap)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }
}
