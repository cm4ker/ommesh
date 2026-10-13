package dev.cm4ker.meshnet;

import android.annotation.SuppressLint;
import android.app.ActivityManager;
import android.content.ComponentCallbacks2;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Point;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.Display;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    /** When the page was last brought back after its renderer went; a second loss soon after is not. */
    private static long pageRestored = 0;
    /** How often a page out of sight looks at the phone's free memory. */
    private static final long MEMORY_CHECK_MS = 30_000;

    private boolean outOfSight = false;
    private final Handler memoryChecks = new Handler(Looper.getMainLooper());
    private final Runnable memoryCheck = new Runnable() {
        @Override
        public void run() {
            if (memoryShort()) {
                releasePage("memory short");
            } else {
                memoryChecks.postDelayed(this, MEMORY_CHECK_MS);
            }
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins that live in this app rather than in a package are registered by hand, before the bridge starts.
        registerPlugin(MeshTcpPlugin.class);
        registerPlugin(SystemTextPlugin.class);
        registerPlugin(NoticesPlugin.class);
        registerPlugin(MeshRelayPlugin.class);
        registerPlugin(ShareInPlugin.class);
        super.onCreate(savedInstanceState);

        holdOrientation();
        drawUnderBars();

        // The page draws its text at the system's size itself (SystemTextPlugin); the WebView scaling
        // it as well would apply the setting twice.
        WebView view = getBridge() != null ? getBridge().getWebView() : null;
        if (view != null) view.getSettings().setTextZoom(100);

        // The page's renderer is a process of its own, which Android lowers to a cached one once the
        // app is out of sight: the first a phone short of memory kills. Held as important, it keeps
        // the app's own standing, which the link's foreground service keeps high.
        if (view != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        if (getBridge() != null) {
            getBridge().addWebViewListener(new WebViewListener() {
                @Override
                public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                    return pageGone(webView, detail);
                }
            });
        }

        preferFastestRefresh();

        // Back is the page's to take (back.ts): it closes a sheet or a dialog, then a screen, then
        // returns to Chats. Only when it has no step left does Back leave the app, as Android's own
        // apps do. Asked directly rather than through the WebView's history: Chromium may skip an
        // entry a page added without a tap, and then Back leaves the app from a screen still open.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge() != null ? getBridge().getWebView() : null;
                if (web == null) {
                    leave();
                    return;
                }
                web.evaluateJavascript(BACK, (taken) -> {
                    if (!"true".equals(taken)) leave();
                });
            }

            private void leave() {
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }

    // A phone unfolded into a tablet, or folded back, turns again or stays upright from then on.
    @Override
    public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        holdOrientation();
    }

    // The radio core announces what arrives while the page is out of sight and asleep; in front, the page does.
    @Override
    public void onStart() {
        super.onStart();
        outOfSight = false;
        memoryChecks.removeCallbacks(memoryCheck);
        MeshRelay.shared(this).setBackground(false);
    }

    @Override
    public void onStop() {
        super.onStop();
        outOfSight = true;
        MeshRelay.shared(this).setBackground(true);
        memoryChecks.postDelayed(memoryCheck, MEMORY_CHECK_MS);
    }

    @Override
    public void onDestroy() {
        memoryChecks.removeCallbacks(memoryCheck);
        super.onDestroy();
    }

    /**
     * Before Android 14 a process with a foreground service hears when the phone runs short, and
     * the page is let go then; later ones tell it no more, and the checks above do instead.
     */
    @Override
    @SuppressWarnings("deprecation") // The RUNNING_ levels are the ones a foreground service heard.
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (!outOfSight) return;
        if (level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW
            || level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL
            || level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND) {
            releasePage("trim " + level);
        }
    }

    /**
     * Near where Android starts ending apps for memory: past half as much again as its own line.
     * Out of sight, the page is only a place where the radio's messages wait to be read, while the
     * radio core behind the link reads and announces them; it is let go before Android ends the
     * whole app for the room it takes.
     */
    private boolean memoryShort() {
        ActivityManager manager = getSystemService(ActivityManager.class);
        if (manager == null) return false;
        ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo();
        manager.getMemoryInfo(memory);
        return memory.lowMemory || memory.availMem < memory.threshold + memory.threshold / 2;
    }

    /** Lets the page go, WebView and renderer with it; the link stays. The app opened again makes a new one. */
    private void releasePage(String why) {
        if (isFinishing() || isDestroyed()) return;
        Log.i("MeshRelay", "the page is let go out of sight: " + why);
        AppExits.notePage(this, "let go for memory");
        // Capacitor destroys its WebView once the window is detached, which an activity finished out
        // of sight can put off; its renderer and memory would stay till then.
        WebView view = getBridge() != null ? getBridge().getWebView() : null;
        if (view != null) {
            if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
            view.destroy();
        }
        finish();
    }

    /**
     * The page's renderer is gone, killed for memory or crashed. Left unhandled, Android ends the whole
     * app with it, and the link to the radio, its service and the radio core's notices go too. The
     * page is made anew instead, and finds the link where it left it.
     */
    private boolean pageGone(WebView webView, RenderProcessGoneDetail detail) {
        boolean crashed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && detail != null && detail.didCrash();
        Log.w("MeshRelay", "the page's renderer is gone" + (crashed ? ", crashed" : ", killed"));
        AppExits.notePage(this, crashed ? "crashed" : "killed for memory");
        long now = SystemClock.elapsedRealtime();
        // A page that loses its renderer again at once would only go round; let the app end as before.
        if (pageRestored != 0 && now - pageRestored < 10_000) return false;
        pageRestored = now;
        // A WebView whose renderer is gone cannot be used again: out of the window, and destroyed.
        if (webView.getParent() instanceof ViewGroup) ((ViewGroup) webView.getParent()).removeView(webView);
        webView.destroy();
        new Handler(Looper.getMainLooper()).post(this::recreate);
        return true;
    }

    /**
     * A phone stays upright: turned sideways, the Mesh sheet took most of its screen. A tablet turns
     * every way, and held sideways it has room for the page's desktop layout, the list and the chat
     * side by side (layout.ts). A tablet is Android's own large screen, 600 dp or more on its shorter
     * side, and its whole display is measured rather than the window, so a split screen or a
     * computer's window does not make it a phone. Android 16 already turns a large screen whatever
     * an app asks; this does the same on the ones before it.
     */
    @SuppressLint("SourceLockedOrientationActivity") // Only a phone is held upright.
    private void holdOrientation() {
        int wanted = largeScreen() ? ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
        if (getRequestedOrientation() != wanted) setRequestedOrientation(wanted);
    }

    @SuppressWarnings("deprecation") // getRealSize is how the display is measured before Android 11.
    private boolean largeScreen() {
        int width;
        int height;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Rect bounds = getWindowManager().getMaximumWindowMetrics().getBounds();
            width = bounds.width();
            height = bounds.height();
        } else {
            Point size = new Point();
            getWindowManager().getDefaultDisplay().getRealSize(size);
            width = size.x;
            height = size.y;
        }
        return Math.min(width, height) / getResources().getDisplayMetrics().density >= 600;
    }

    /**
     * Edge to edge on every Android, as Android 15 and later make it anyway, so there is one layout:
     * the page keeps clear of the bars with env(safe-area-inset-*), and the SystemBars plugin lifts
     * the web view above the keyboard. Left to fit the bars below Android 15, the window stopped
     * above the buttons while the plugin still lifted it by the keyboard's full height, buttons
     * included, and the composer floated a button bar's height above the keyboard.
     */
    @SuppressWarnings("deprecation") // The bar colours are what Android before 15 paints the bars with.
    private void drawUnderBars() {
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        // No veil behind the three buttons: the page is under them, and their colour follows its theme.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) window.setNavigationBarContrastEnforced(false);
    }

    /**
     * Asks for the panel's fastest mode at the current resolution. Some vendors (ColorOS, for one)
     * hold an app they do not know at 60 Hz on a 120 Hz screen, and every scroll and sheet then
     * moves at half the rate the rest of the phone does.
     */
    private void preferFastestRefresh() {
        Display display = getWindowManager().getDefaultDisplay();
        Display.Mode current = display.getMode();
        Display.Mode best = current;
        for (Display.Mode mode : display.getSupportedModes()) {
            if (mode.getPhysicalWidth() == current.getPhysicalWidth()
                    && mode.getPhysicalHeight() == current.getPhysicalHeight()
                    && mode.getRefreshRate() > best.getRefreshRate()) {
                best = mode;
            }
        }
        WindowManager.LayoutParams params = getWindow().getAttributes();
        params.preferredDisplayModeId = best.getModeId();
        getWindow().setAttributes(params);
    }

    /** True when the page took the step; false, or anything else, lets the app go. */
    private static final String BACK =
        "(function(){try{var m=window.meshnet;return !!(m&&m.back&&m.back());}catch(e){return false;}})()";
}
