package dev.cm4ker.meshnet;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import androidx.core.app.Person;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONObject;

/**
 * Text another app shares to Ommesh (#88), for the web client's {@code lib/shareIn.ts}:
 * {@code window.Capacitor.Plugins.ShareIn}. Android hands it over as a SEND intent (the
 * manifest's filter), to a starting app or to the running one, which keeps one task
 * (singleTask). It waits here until the page asks with {@code take()}, which answers
 * {@code {title, text, chat}} once, so a page still loading misses nothing; the page hears
 * {@code shared} when one comes while it runs.
 *
 * {@code offer({chats})} makes the chats the page names sharing shortcuts: the share sheet
 * shows them in its row of people (res/xml/shortcuts.xml), and a share to one of them carries
 * its id. The launcher shows them on a long press of the icon too, where a tap opens the chat.
 */
@CapacitorPlugin(name = "ShareIn")
public class ShareInPlugin extends Plugin {
    /** The share target's category in res/xml/shortcuts.xml. */
    private static final String CATEGORY = "dev.cm4ker.meshnet.SHARE_TARGET";
    /** The chat a shortcut opens from the launcher. */
    private static final String EXTRA_CHAT = "dev.cm4ker.meshnet.CHAT";

    private JSObject pending;

    // Capacitor hands the starting intent here as well as each new one.
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null) return;
        boolean send = Intent.ACTION_SEND.equals(intent.getAction());
        boolean open = Intent.ACTION_VIEW.equals(intent.getAction()) && intent.hasExtra(EXTRA_CHAT);
        if (!send && !open) return;
        // Opened again from the recent apps, a task begun by a share gets that share again.
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        JSObject shared = new JSObject();
        if (send) {
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            String title = intent.getStringExtra(Intent.EXTRA_SUBJECT);
            String chat = intent.getStringExtra(ShortcutManagerCompat.EXTRA_SHORTCUT_ID);
            if (text != null) shared.put("text", text.toString());
            if (title != null) shared.put("title", title);
            if (chat != null) shared.put("chat", chat);
        } else {
            shared.put("chat", intent.getStringExtra(EXTRA_CHAT));
        }
        // Taken once: a page made anew (MainActivity.pageGone) starts from the same intent.
        intent.setAction(Intent.ACTION_MAIN);
        intent.removeExtra(EXTRA_CHAT);
        if (shared.length() == 0) return;
        pending = shared;
        notifyListeners("shared", new JSObject());
    }

    @PluginMethod
    public void take(PluginCall call) {
        JSObject shared = pending != null ? pending : new JSObject();
        pending = null;
        call.resolve(shared);
    }

    /** {@code chats}: {@code [{id, title, icon}]}, the icon a PNG in base64, the first ranked first. */
    @PluginMethod
    public void offer(PluginCall call) {
        Context context = getContext();
        JSArray chats = call.getArray("chats", new JSArray());
        List<ShortcutInfoCompat> shortcuts = new ArrayList<>();
        try {
            for (int i = 0; i < chats.length(); i++) {
                JSONObject chat = chats.getJSONObject(i);
                String id = chat.getString("id");
                String title = chat.getString("title");
                byte[] png = Base64.decode(chat.optString("icon", ""), Base64.DEFAULT);
                Bitmap picture = png.length > 0 ? BitmapFactory.decodeByteArray(png, 0, png.length) : null;
                Intent open = new Intent(Intent.ACTION_VIEW, null, context, MainActivity.class).putExtra(EXTRA_CHAT, id);
                ShortcutInfoCompat.Builder shortcut = new ShortcutInfoCompat.Builder(context, id)
                    .setShortLabel(title)
                    .setLongLived(true)
                    .setRank(i)
                    .setIntent(open)
                    .setCategories(Collections.singleton(CATEGORY))
                    .setPerson(new Person.Builder().setName(title).setKey(id).build());
                if (picture != null) shortcut.setIcon(IconCompat.createWithAdaptiveBitmap(picture));
                shortcuts.add(shortcut.build());
            }
            ShortcutManagerCompat.setDynamicShortcuts(context, shortcuts);
            call.resolve();
        } catch (Exception e) {
            call.reject("the chats could not be offered: " + e.getMessage());
        }
    }
}
