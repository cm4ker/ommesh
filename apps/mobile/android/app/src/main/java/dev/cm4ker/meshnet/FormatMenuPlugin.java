package dev.cm4ker.meshnet;

import android.graphics.Rect;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/**
 * Formatting in the toolbar over selected text, for the web client's {@code lib/formatMenu.ts}:
 * {@code window.Capacitor.Plugins.FormatMenu}.
 *
 * <ul>
 *   <li>{@code set({ title, items })}: while the composer has the focus, its items,
 *       {@code [{ choice, title }]}, in the reader's language; {@code set({})} takes them away.</li>
 *   <li>{@code select({ selected })}: whether the composer has text selected. The toolbar comes up
 *       as a long press selects a word, before the page hears of it, so it is redrawn when told.</li>
 *   <li>Event: {@code pick} with {@code { choice }} when one is chosen.</li>
 * </ul>
 *
 * The items go after the web view's own, in the toolbar's overflow, as Telegram puts its formatting.
 */
@CapacitorPlugin(name = "FormatMenu")
public class FormatMenuPlugin extends Plugin {
    /** The group and the first id of the items, far from the web view's own. */
    private static final int GROUP = 0x6f6d;
    private static final int FIRST_ID = 0x6f6d0000;

    /** What the toolbar offers now: the items while the composer has the focus, else empty. Main thread only. */
    private static final List<String[]> items = new ArrayList<>();
    private static boolean selected = false;
    private static WeakReference<FormatMenuPlugin> current = new WeakReference<>(null);
    private static WeakReference<ActionMode> shown = new WeakReference<>(null);

    @Override
    public void load() {
        current = new WeakReference<>(this);
    }

    @PluginMethod
    public void set(PluginCall call) {
        List<String[]> next = new ArrayList<>();
        JSArray list = call.getArray("items", new JSArray());
        for (int i = 0; i < list.length(); i++) {
            JSONObject item = list.optJSONObject(i);
            if (item != null && item.has("choice") && item.has("title")) next.add(new String[] { item.optString("choice"), item.optString("title") });
        }
        getActivity().runOnUiThread(() -> {
            items.clear();
            items.addAll(next);
            if (items.isEmpty()) selected = false;
            redraw();
            call.resolve();
        });
    }

    @PluginMethod
    public void select(PluginCall call) {
        boolean now = Boolean.TRUE.equals(call.getBoolean("selected", false));
        getActivity().runOnUiThread(() -> {
            if (selected != now) {
                selected = now;
                redraw();
            }
            call.resolve();
        });
    }

    private static void redraw() {
        ActionMode mode = shown.get();
        if (mode != null) mode.invalidate();
    }

    private static void pick(String choice) {
        FormatMenuPlugin plugin = current.get();
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("choice", choice);
        plugin.notifyListeners("pick", data);
    }

    /** The items, after whatever the web view put in the menu, while there is selected text in the composer. */
    private static void add(Menu menu) {
        menu.removeGroup(GROUP);
        if (!selected) return;
        for (int i = 0; i < items.size(); i++) {
            menu.add(GROUP, FIRST_ID + i, 100 + i, items.get(i)[1]).setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER);
        }
    }

    /** The web view's callback for its toolbar over selected text, with the formatting added. */
    static ActionMode.Callback wrap(ActionMode.Callback inner) {
        return new ActionMode.Callback2() {
            @Override
            public boolean onCreateActionMode(ActionMode mode, Menu menu) {
                if (!inner.onCreateActionMode(mode, menu)) return false;
                shown = new WeakReference<>(mode);
                add(menu);
                return true;
            }

            @Override
            public boolean onPrepareActionMode(ActionMode mode, Menu menu) {
                inner.onPrepareActionMode(mode, menu);
                add(menu);
                return true;
            }

            @Override
            public boolean onActionItemClicked(ActionMode mode, MenuItem item) {
                int at = item.getItemId() - FIRST_ID;
                if (item.getGroupId() != GROUP || at < 0 || at >= items.size()) return inner.onActionItemClicked(mode, item);
                pick(items.get(at)[0]);
                return true;
            }

            @Override
            public void onDestroyActionMode(ActionMode mode) {
                if (shown.get() == mode) shown = new WeakReference<>(null);
                inner.onDestroyActionMode(mode);
            }

            @Override
            public void onGetContentRect(ActionMode mode, View view, Rect outRect) {
                if (inner instanceof ActionMode.Callback2) ((ActionMode.Callback2) inner).onGetContentRect(mode, view, outRect);
                else super.onGetContentRect(mode, view, outRect);
            }
        };
    }
}
