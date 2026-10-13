package dev.cm4ker.meshnet;

import android.Manifest;
import android.annotation.SuppressLint;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import dev.cm4ker.meshnet.speech.Heard;
import dev.cm4ker.meshnet.speech.SpeechInput;
import dev.cm4ker.meshnet.speech.SpeechModel;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Voice input (#89) for the web client's {@code lib/voiceInput.ts}: what is said into the
 * microphone, written down on the phone by Whisper (crates/speech, inside the app's Rust library)
 * and handed to the page phrase by phrase. The sound goes from the microphone to the recogniser
 * here, never through the page, and is forgotten once heard.
 *
 * <p>{@code models()} answers {@code { models: [{ id, bytes, present }], unable }} ({@code unable}:
 * why this phone cannot hear speech, or null); {@code download({ id })} fetches a model, telling
 * {@code progress} events {@code { model, done, total }}; {@code delete({ id })}; {@code unload()}.
 * {@code start({ model, language, before })} turns the microphone on once the model is read in,
 * asking for the microphone the first time; while it listens, {@code phrase} events
 * {@code { text }} bring what was heard, {@code level} events {@code { level, speaking }} how loud
 * it is, {@code quiet} a long silence, and {@code error} events {@code { message }} a failure that
 * turned it off. {@code stop()} answers {@code { phrases }}, the last ones heard; {@code cancel()}
 * drops them.
 */
@CapacitorPlugin(name = "Speech", permissions = { @Permission(alias = SpeechPlugin.MICROPHONE, strings = { Manifest.permission.RECORD_AUDIO }) })
public class SpeechPlugin extends Plugin {
    static final String MICROPHONE = "microphone";
    /** What Whisper hears: 16 kHz mono. */
    private static final int RATE = 16_000;
    /** A quarter of a second a time, so the text keeps close behind the speech. */
    private static final int PIECE = RATE / 4;

    private SpeechInput speech;
    /** Reading a model in and hearing the last phrase, one at a time. */
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    /** Downloads, apart, so that one does not hold up listening with the model already here. */
    private final ExecutorService fetches = Executors.newSingleThreadExecutor();
    private Thread microphone;
    private volatile boolean listening;

    /** Kept where the phone does not back up: a model is hundreds of megabytes, fetched again at will. */
    private synchronized SpeechInput speech() {
        if (speech == null) speech = new SpeechInput(new File(getContext().getNoBackupFilesDir(), "voice").getAbsolutePath());
        return speech;
    }

    @PluginMethod
    public void models(PluginCall call) {
        work.execute(() -> {
            try {
                JSArray models = new JSArray();
                for (SpeechModel model : speech().models()) {
                    JSObject info = new JSObject();
                    info.put("id", model.getId());
                    info.put("bytes", model.getBytes());
                    info.put("present", model.getPresent());
                    models.put(info);
                }
                JSObject result = new JSObject();
                result.put("models", models);
                result.put("unable", speech().unable());
                call.resolve(result);
            } catch (Exception e) {
                call.reject(message(e));
            }
        });
    }

    @PluginMethod
    public void download(PluginCall call) {
        String id = call.getString("id", "");
        fetches.execute(() -> {
            try {
                speech().download(id, (done, total) -> {
                    JSObject event = new JSObject();
                    event.put("model", id);
                    event.put("done", done);
                    event.put("total", total);
                    notifyListeners("progress", event);
                });
                call.resolve();
            } catch (Exception e) {
                call.reject(message(e));
            }
        });
    }

    @PluginMethod
    public void delete(PluginCall call) {
        String id = call.getString("id", "");
        work.execute(() -> {
            try {
                speech().delete(id);
                call.resolve();
            } catch (Exception e) {
                call.reject(message(e));
            }
        });
    }

    @PluginMethod
    public void unload(PluginCall call) {
        stopMicrophone();
        work.execute(() -> {
            speech().unload();
            call.resolve();
        });
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState(MICROPHONE) == PermissionState.GRANTED) begin(call);
        else requestPermissionForAlias(MICROPHONE, call, "microphoneAnswered");
    }

    @PermissionCallback
    private void microphoneAnswered(PluginCall call) {
        if (getPermissionState(MICROPHONE) == PermissionState.GRANTED) begin(call);
        else call.reject("No access to the microphone", "denied");
    }

    private void begin(PluginCall call) {
        stopMicrophone();
        String model = call.getString("model", "small");
        String language = call.getString("language", "ru");
        String before = call.getString("before", "");
        work.execute(() -> {
            try {
                speech().start(model, language, before);
                startMicrophone();
                call.resolve();
            } catch (Exception e) {
                speech().cancel();
                call.reject(message(e));
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopMicrophone();
        work.execute(() -> {
            try {
                JSArray phrases = new JSArray();
                for (String phrase : speech().finish()) phrases.put(phrase);
                JSObject result = new JSObject();
                result.put("phrases", phrases);
                call.resolve(result);
            } catch (Exception e) {
                call.reject(message(e));
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        stopMicrophone();
        speech().cancel();
        call.resolve();
    }

    /** Out of sight, the microphone goes off: Android would hand an app in the background silence. */
    @Override
    protected void handleOnPause() {
        if (!listening) return;
        stopMicrophone();
        speech().cancel();
        JSObject event = new JSObject();
        event.put("message", "The microphone went off with the app out of sight");
        notifyListeners("error", event);
    }

    @Override
    protected void handleOnDestroy() {
        stopMicrophone();
        if (speech != null) speech.cancel();
    }

    /** Called once the permission is granted, which the lint does not follow. */
    @SuppressLint("MissingPermission")
    private void startMicrophone() {
        int least = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_FLOAT);
        // The source tuned for speech recognition: no echo cancelling or gain the recogniser would mind.
        AudioRecord recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_FLOAT, Math.max(least, PIECE * 4 * 2));
        if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
            recorder.release();
            throw new IllegalStateException("The microphone could not be opened");
        }
        recorder.startRecording();
        listening = true;
        microphone = new Thread(() -> listen(recorder), "speech-microphone");
        microphone.start();
    }

    private void listen(AudioRecord recorder) {
        float[] piece = new float[PIECE];
        try {
            while (listening) {
                int read = recorder.read(piece, 0, PIECE, AudioRecord.READ_BLOCKING);
                if (read < 0) throw new IllegalStateException("The microphone stopped (" + read + ")");
                if (read == 0) continue;
                List<Float> samples = new ArrayList<>(read);
                for (int i = 0; i < read; i++) samples.add(piece[i]);
                Heard heard = speech().feed(samples);
                for (String phrase : heard.getPhrases()) {
                    JSObject event = new JSObject();
                    event.put("text", phrase);
                    notifyListeners("phrase", event);
                }
                JSObject level = new JSObject();
                level.put("level", (double) heard.getLevel());
                level.put("speaking", heard.getSpeaking());
                notifyListeners("level", level);
                if (heard.getEnded()) notifyListeners("quiet", new JSObject());
            }
        } catch (Exception e) {
            if (listening) {
                listening = false;
                JSObject event = new JSObject();
                event.put("message", message(e));
                notifyListeners("error", event);
            }
        } finally {
            recorder.stop();
            recorder.release();
        }
    }

    /** Lets the microphone go, once what it read last has been handed in. */
    private void stopMicrophone() {
        Thread running = microphone;
        microphone = null;
        listening = false;
        if (running == null) return;
        try {
            running.join(2_000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static String message(Exception e) {
        String message = e.getMessage();
        return message == null || message.isEmpty() ? e.toString() : message;
    }
}
