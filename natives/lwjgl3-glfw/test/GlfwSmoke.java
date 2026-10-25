import static org.lwjgl.glfw.GLFW.*;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import org.lwjgl.BufferUtils;
import org.lwjgl.glfw.GLFWErrorCallback;
import org.lwjgl.glfw.GLFWImage;
import org.lwjgl.glfw.GLFWVidMode;

/**
 * Smoke test for the patched libglfw.dylib under LWJGL 3.3.1 (see run.sh).
 *
 * Replays the GLFW calls Minecraft 1.13-1.18 make while their start-up error callback is active
 * (from glfwInit to the first frame), for both window set-ups they use: a legacy context
 * (1.13-1.16) and a 3.2 core forward-compatible context (1.17-1.18). Any GLFW error is a failure,
 * as it is for the game. With --expect-icon-error the only allowed error is the window icon one
 * (the control run against the official LWJGL build, which must reproduce the bug).
 */
public class GlfwSmoke {
    static final List<String> errors = new ArrayList<>();

    public static void main(String[] args) {
        boolean expectIconError = args.length > 0 && args[0].equals("--expect-icon-error");
        glfwSetErrorCallback((code, description) ->
            errors.add(String.format("0x%X %s", code, GLFWErrorCallback.getDescription(description))));
        check(glfwInit(), "glfwInit");
        System.out.println("library: " + org.lwjgl.glfw.GLFW.getLibrary().getPath());
        System.out.println("version: " + glfwGetVersionString());
        List<String> initErrors = take();
        // Minecraft only logs errors raised during glfwInit, but there should be none.
        if (!initErrors.isEmpty()) fail("errors during glfwInit: " + initErrors);

        int failures = 0;
        failures += window("legacy (1.13-1.16)", false, expectIconError);
        failures += window("core 3.2 (1.17-1.18)", true, expectIconError);
        glfwTerminate();
        if (failures > 0) fail(failures + " check(s) failed");
        System.out.println("OK");
    }

    static int window(String name, boolean core, boolean expectIconError) {
        // Monitor queries the game makes before and while creating the window.
        long primary = glfwGetPrimaryMonitor();
        check(primary != 0, "glfwGetPrimaryMonitor");
        for (long m : toArray(glfwGetMonitors())) {
            int[] x = new int[1], y = new int[1];
            glfwGetMonitorPos(m, x, y);
            GLFWVidMode.Buffer modes = glfwGetVideoModes(m);
            check(modes != null && modes.remaining() > 0, "glfwGetVideoModes");
            check(glfwGetVideoMode(m) != null, "glfwGetVideoMode");
        }

        glfwDefaultWindowHints();
        glfwWindowHint(GLFW_CLIENT_API, GLFW_OPENGL_API);
        glfwWindowHint(GLFW_CONTEXT_CREATION_API, GLFW_NATIVE_CONTEXT_API);
        if (core) {
            glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
            glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 2);
            glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
            glfwWindowHint(GLFW_OPENGL_FORWARD_COMPAT, GLFW_TRUE);
        } else {
            glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 2);
            glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 0);
            glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_ANY_PROFILE);
        }
        long w = glfwCreateWindow(427, 240, "GlfwSmoke " + name, 0, 0);
        check(w != 0, "glfwCreateWindow");
        glfwMakeContextCurrent(w);
        glfwSwapInterval(1);
        int[] x = new int[1], y = new int[1];
        glfwGetWindowPos(w, x, y);
        glfwGetFramebufferSize(w, x, y);
        check(x[0] > 0 && y[0] > 0, "glfwGetFramebufferSize");
        glfwGetWindowMonitor(w);
        glfwSetWindowTitle(w, "GlfwSmoke " + name);
        List<String> before = take();

        // The call that broke: Minecraft sets a 16x16 and a 32x32 icon.
        GLFWImage.Buffer icons = GLFWImage.malloc(2);
        icons.position(0).width(16).height(16).pixels(rgba(16));
        icons.position(1).width(32).height(32).pixels(rgba(32));
        icons.position(0);
        glfwSetWindowIcon(w, icons);
        icons.free();
        List<String> icon = take();

        // Input set-up (MouseHandler/KeyboardHandler, raw input option, mouse grab).
        if (glfwRawMouseMotionSupported()) glfwSetInputMode(w, GLFW_RAW_MOUSE_MOTION, GLFW_TRUE);
        glfwSetInputMode(w, GLFW_CURSOR, GLFW_CURSOR_NORMAL);
        glfwSetInputMode(w, GLFW_CURSOR, GLFW_CURSOR_DISABLED);
        glfwSetInputMode(w, GLFW_CURSOR, GLFW_CURSOR_NORMAL);
        glfwSetCursorPos(w, 10, 10);
        glfwGetKeyName(GLFW_KEY_W, 0);
        glfwGetKey(w, GLFW_KEY_W);
        glfwSetClipboardString(w, "amethyst");
        glfwPollEvents();
        glfwSwapBuffers(w);
        List<String> after = take();
        glfwDestroyWindow(w);

        int failures = 0;
        failures += report(name + ": window creation", before, false);
        failures += report(name + ": glfwSetWindowIcon", icon, expectIconError);
        failures += report(name + ": input set-up", after, false);
        return failures;
    }

    static int report(String what, List<String> errs, boolean expectIconError) {
        boolean ok = expectIconError
            ? errs.size() == 1 && errs.get(0).startsWith("0x1000C ") // GLFW_FEATURE_UNAVAILABLE
            : errs.isEmpty();
        System.out.println((ok ? "  ok    " : "  FAIL  ") + what + (errs.isEmpty() ? "" : " " + errs));
        return ok ? 0 : 1;
    }

    static ByteBuffer rgba(int size) {
        ByteBuffer b = BufferUtils.createByteBuffer(size * size * 4);
        for (int i = 0; i < size * size; i++) b.put((byte) 0x8A).put((byte) 0x2B).put((byte) 0xE2).put((byte) 0xFF);
        return (ByteBuffer) b.flip();
    }

    static long[] toArray(org.lwjgl.PointerBuffer p) {
        long[] a = new long[p == null ? 0 : p.remaining()];
        for (int i = 0; i < a.length; i++) a[i] = p.get(i);
        return a;
    }

    static List<String> take() {
        List<String> copy = new ArrayList<>(errors);
        errors.clear();
        return copy;
    }

    static void check(boolean ok, String what) {
        if (!ok) fail(what + " failed " + errors);
    }

    static void fail(String message) {
        System.out.println("FAIL: " + message);
        System.exit(1);
    }
}
