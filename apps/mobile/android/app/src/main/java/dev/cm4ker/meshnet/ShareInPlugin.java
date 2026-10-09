package dev.cm4ker.meshnet;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Text another app shares to Ommesh (#88), for the web client's {@code lib/shareIn.ts}:
 * {@code window.Capacitor.Plugins.ShareIn}. Android hands it over as a SEND intent (the
 * manifest's filter), to a starting app or to the running one, which keeps one task
 * (singleTask). It waits here until the page asks with {@code take()}, which answers
 * {@code {title, text}} once, so a page still loading misses nothing; the page hears
 * {@code shared} when one comes while it runs.
 */
@CapacitorPlugin(name = "ShareIn")
public class ShareInPlugin extends Plugin {
    private JSObject pending;

    // Capacitor hands the starting intent here as well as each new one.
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        // Opened again from the recent apps, a task begun by a share gets that share again.
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String title = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        // Taken once: a page made anew (MainActivity.pageGone) starts from the same intent.
        intent.setAction(Intent.ACTION_MAIN);
        if (text == null && title == null) return;
        JSObject shared = new JSObject();
        if (text != null) shared.put("text", text.toString());
        if (title != null) shared.put("title", title);
        pending = shared;
        notifyListeners("shared", new JSObject());
    }

    @PluginMethod
    public void take(PluginCall call) {
        JSObject shared = pending != null ? pending : new JSObject();
        pending = null;
        call.resolve(shared);
    }
}
