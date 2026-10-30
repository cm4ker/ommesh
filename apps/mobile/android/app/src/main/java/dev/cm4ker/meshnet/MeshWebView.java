package dev.cm4ker.meshnet;

import android.content.Context;
import android.util.AttributeSet;
import android.view.ActionMode;
import com.getcapacitor.CapacitorWebView;

/**
 * The page's web view (put in Capacitor's layout by {@code res/layout/capacitor_bridge_layout_main.xml}),
 * whose toolbar over selected text carries the composer's formatting (FormatMenuPlugin).
 */
public class MeshWebView extends CapacitorWebView {
    public MeshWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    public ActionMode startActionMode(ActionMode.Callback callback, int type) {
        return super.startActionMode(type == ActionMode.TYPE_FLOATING ? FormatMenuPlugin.wrap(callback) : callback, type);
    }
}
