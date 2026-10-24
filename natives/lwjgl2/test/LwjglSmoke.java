import java.awt.BorderLayout;
import java.awt.Canvas;
import java.awt.EventQueue;
import java.awt.Frame;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.IntBuffer;

import net.java.games.input.Controller;
import net.java.games.input.ControllerEnvironment;

import org.lwjgl.BufferUtils;
import org.lwjgl.Sys;
import org.lwjgl.input.Keyboard;
import org.lwjgl.input.Mouse;
import org.lwjgl.openal.AL;
import org.lwjgl.openal.AL10;
import org.lwjgl.opengl.Display;
import org.lwjgl.opengl.DisplayMode;
import org.lwjgl.opengl.GL11;

/**
 * Smoke test for the Amethyst-built LWJGL 2 arm64 natives.
 *
 * Runs against the official (Mojang) lwjgl jar of one version, with -Djava.library.path pointing
 * at the extracted natives jar. Usage: LwjglSmoke window|game|input|canvas|al|jinput ...
 *
 *   window  Display.create() on its own NSWindow (Minecraft 1.6+), clear to a colour, read back.
 *   game    the Display calls Minecraft makes: resizable window, resize, title, mouse grab, native
 *           cursor, fullscreen and back.
 *   input   synthetic key, mouse move and click (java.awt.Robot) arrive via Keyboard/Mouse.
 *   canvas  Display.setParent() on an AWT Canvas in a Frame (the applet path of Minecraft <= 1.5.2).
 *   al      AL.create() with the bundled openal.dylib; plays nothing, queries the device.
 *   jinput  JInput's OS X HID plugin loads libjinput-osx and enumerates controllers.
 *
 * Exits 0 only if every requested check passes; prints one "PASS"/"FAIL" line per check.
 */
public final class LwjglSmoke {
	private static int failures;

	public static void main(String[] args) throws Exception {
		System.out.println("java " + System.getProperty("java.version") + " (" + System.getProperty("java.vendor")
				+ "), os.arch=" + System.getProperty("os.arch") + ", os " + System.getProperty("os.name") + " "
				+ System.getProperty("os.version"));
		System.out.println("LWJGL " + Sys.getVersion() + ", 64-bit natives: " + Sys.is64Bit());
		for (String a : args) {
			try {
				if (a.equals("window")) {
					window();
				} else if (a.equals("canvas")) {
					canvas();
				} else if (a.equals("al")) {
					al();
				} else if (a.equals("jinput")) {
					jinput();
				} else if (a.equals("game")) {
					game();
				} else if (a.equals("input")) {
					input();
				} else {
					throw new IllegalArgumentException("unknown check " + a);
				}
			} catch (Throwable t) {
				fail(a, t);
			}
		}
		System.out.println(failures == 0 ? "ALL PASS" : failures + " FAILED");
		System.exit(failures == 0 ? 0 : 1);
	}

	private static void pass(String check, String detail) {
		System.out.println("PASS " + check + ": " + detail);
	}

	private static void fail(String check, Throwable t) {
		failures++;
		System.out.println("FAIL " + check + ": " + t);
		t.printStackTrace(System.out);
	}

	/** Clear to a known colour, swap, and read the pixel back from the back buffer. */
	private static String drawAndCheck() {
		String gl = GL11.glGetString(GL11.GL_VERSION) + " / " + GL11.glGetString(GL11.GL_RENDERER);
		for (int i = 0; i < 3; i++) {
			Display.processMessages();
			GL11.glClearColor(0.2f, 0.4f, 0.6f, 1f);
			GL11.glClear(GL11.GL_COLOR_BUFFER_BIT);
			if (i == 2) {
				break; // keep this frame in the back buffer for the read-back
			}
			Display.update();
		}
		ByteBuffer px = BufferUtils.createByteBuffer(4);
		GL11.glReadPixels(0, 0, 1, 1, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, px);
		int r = px.get(0) & 0xff, g = px.get(1) & 0xff, b = px.get(2) & 0xff;
		int err = GL11.glGetError();
		Display.update();
		if (Math.abs(r - 51) > 2 || Math.abs(g - 102) > 2 || Math.abs(b - 153) > 2) {
			throw new IllegalStateException("read back rgb(" + r + "," + g + "," + b + "), expected rgb(51,102,153)");
		}
		if (err != GL11.GL_NO_ERROR) {
			throw new IllegalStateException("glGetError " + err);
		}
		return gl + ", pixel rgb(" + r + "," + g + "," + b + ")";
	}

	private static void window() throws Exception {
		Display.setDisplayMode(new DisplayMode(320, 240));
		Display.setTitle("Amethyst LWJGL 2 arm64 smoke test");
		Display.create();
		try {
			String gl = drawAndCheck();
			String input = "keyboard=" + Keyboard.isCreated() + " mouse=" + Mouse.isCreated();
			Mouse.poll();
			Keyboard.poll();
			Mouse.setGrabbed(true);
			Mouse.setGrabbed(false);
			// Display.update() round-trips to the main thread for NSOpenGLContext -update; time it.
			Display.setVSyncEnabled(false);
			long t0 = System.nanoTime();
			frames(300);
			String perFrame = String.format("%.2f ms/frame (vsync off)", (System.nanoTime() - t0) / 300 / 1e6);
			pass("window", gl + ", " + input + ", " + perFrame + ", desktop " + Display.getDesktopDisplayMode()
					+ ", modes " + Display.getAvailableDisplayModes().length);
		} finally {
			Display.destroy();
		}
	}

	private static void frames(int n) {
		for (int i = 0; i < n; i++) {
			GL11.glClearColor(0.2f, 0.4f, 0.6f, 1f);
			GL11.glClear(GL11.GL_COLOR_BUFFER_BIT | GL11.GL_DEPTH_BUFFER_BIT);
			Display.update();
			while (Keyboard.next()) {
				// drain, as Minecraft does every tick
			}
			while (Mouse.next()) {
				// drain
			}
		}
	}

	/** The Display calls Minecraft 1.0-1.12.2 makes on its own window (not the applet path). */
	private static void game() throws Exception {
		StringBuilder log = new StringBuilder();
		Display.setTitle("Amethyst LWJGL 2 arm64 smoke test (game)");
		Display.setResizable(true);
		Display.setDisplayMode(new DisplayMode(427, 240));
		Display.create(new org.lwjgl.opengl.PixelFormat().withDepthBits(24));
		try {
			Display.setVSyncEnabled(true);
			Keyboard.enableRepeatEvents(true);
			frames(10);
			log.append("created ").append(Display.getWidth()).append('x').append(Display.getHeight());

			Display.setDisplayMode(new DisplayMode(640, 360));
			frames(10);
			log.append(", resized ").append(Display.getWidth()).append('x').append(Display.getHeight());

			Display.setTitle("Amethyst LWJGL 2 arm64 smoke test (title changed)");
			Mouse.setGrabbed(true);
			frames(5);
			Mouse.setGrabbed(false);
			Mouse.setCursorPosition(10, 10);
			log.append(", grab/ungrab ok");

			IntBuffer img = BufferUtils.createIntBuffer(16 * 16);
			for (int i = 0; i < 256; i++) {
				img.put(i, 0xff00ff00);
			}
			org.lwjgl.input.Cursor cursor = new org.lwjgl.input.Cursor(16, 16, 0, 0, 1, img, null);
			Mouse.setNativeCursor(cursor);
			frames(2);
			Mouse.setNativeCursor(null);
			cursor.destroy();
			log.append(", native cursor ok");

			// Like Minecraft: a fullscreen-capable mode of the desktop size if listed (LWJGL before
			// 2.9.1 does not list the scaled Retina desktop mode), else the largest one.
			DisplayMode desktop = Display.getDesktopDisplayMode();
			DisplayMode fs = null;
			for (DisplayMode m : Display.getAvailableDisplayModes()) {
				if (!m.isFullscreenCapable()) {
					continue;
				}
				if (m.getWidth() == desktop.getWidth() && m.getHeight() == desktop.getHeight()) {
					fs = m;
					break;
				}
				if (fs == null || m.getWidth() * m.getHeight() > fs.getWidth() * fs.getHeight()) {
					fs = m;
				}
			}
			Display.setDisplayModeAndFullscreen(fs);
			frames(30);
			log.append(", fullscreen ").append(Display.isFullscreen()).append(' ').append(Display.getWidth()).append('x')
					.append(Display.getHeight());
			Display.setFullscreen(false);
			Display.setDisplayMode(new DisplayMode(427, 240));
			frames(30);
			log.append(", windowed again ").append(Display.getWidth()).append('x').append(Display.getHeight());

			String px = drawAndCheck();
			pass("game", log + ", " + px);
		} finally {
			Display.destroy();
		}
	}

	/**
	 * Real input events: java.awt.Robot posts CGEvents (a key press, a mouse move and a click) at
	 * the focused LWJGL window, which must arrive through Keyboard.next()/Mouse.next(). macOS only
	 * delivers synthetic events if the calling app (the terminal) has the Accessibility permission.
	 */
	private static void input() throws Exception {
		Display.setDisplayMode(new DisplayMode(320, 240));
		Display.setTitle("Amethyst LWJGL 2 arm64 smoke test (input)");
		Display.create();
		try {
			frames(20);
			java.awt.Robot robot = new java.awt.Robot();
			int cx = Display.getX() + 160, cy = Display.getY() + 120 + 28; // below the title bar
			robot.mouseMove(cx, cy);
			frames(10);
			robot.mouseMove(cx + 20, cy + 10);
			robot.mousePress(java.awt.event.InputEvent.BUTTON1_DOWN_MASK);
			robot.mouseRelease(java.awt.event.InputEvent.BUTTON1_DOWN_MASK);
			robot.keyPress(java.awt.event.KeyEvent.VK_A);
			robot.keyRelease(java.awt.event.KeyEvent.VK_A);
			boolean keyA = false, moved = false, clicked = false;
			char typed = 0;
			long end = System.currentTimeMillis() + 3000;
			while (System.currentTimeMillis() < end && !(keyA && moved && clicked)) {
				Display.update();
				while (Keyboard.next()) {
					if (Keyboard.getEventKey() == Keyboard.KEY_A) {
						keyA = true;
						if (Keyboard.getEventCharacter() != 0) {
							typed = Keyboard.getEventCharacter();
						}
					}
				}
				while (Mouse.next()) {
					if (Mouse.getEventButton() == 0) {
						clicked = true;
					}
					if (Mouse.getEventDX() != 0 || Mouse.getEventDY() != 0) {
						moved = true;
					}
				}
			}
			String detail = "focused=" + Display.isActive() + " key A=" + keyA + " char='" + typed + "' mouse moved="
					+ moved + " click=" + clicked;
			if (!keyA || !moved || !clicked) {
				throw new IllegalStateException("no input events (" + detail
						+ "); synthetic events need the Accessibility permission");
			}
			pass("input", detail);
		} finally {
			Display.destroy();
		}
	}

	private static void canvas() throws Exception {
		final Frame[] frame = new Frame[1];
		final Canvas canvas = new Canvas();
		EventQueue.invokeAndWait(new Runnable() {
			public void run() {
				frame[0] = new Frame("Amethyst LWJGL 2 arm64 smoke test (canvas)");
				frame[0].setLayout(new BorderLayout());
				canvas.setSize(320, 240);
				frame[0].add(canvas, BorderLayout.CENTER);
				frame[0].pack();
				frame[0].setVisible(true);
			}
		});
		try {
			Display.setParent(canvas);
			Display.create();
			try {
				pass("canvas", drawAndCheck() + ", keyboard=" + Keyboard.isCreated() + " mouse=" + Mouse.isCreated());
			} finally {
				Display.destroy();
				Display.setParent(null);
			}
		} finally {
			EventQueue.invokeAndWait(new Runnable() {
				public void run() {
					frame[0].dispose();
				}
			});
		}
	}

	private static void al() throws Exception {
		AL.create();
		try {
			String detail = AL10.alGetString(AL10.AL_VENDOR) + " " + AL10.alGetString(AL10.AL_VERSION) + ", device "
					+ AL.getDevice() + ", renderer " + AL10.alGetString(AL10.AL_RENDERER);
			IntBuffer src = BufferUtils.createIntBuffer(1);
			AL10.alGenSources(src);
			FloatBuffer pos = ByteBuffer.allocateDirect(12).order(ByteOrder.nativeOrder()).asFloatBuffer();
			pos.put(new float[] { 0, 0, 0 }).flip();
			AL10.alSource(src.get(0), AL10.AL_POSITION, pos);
			// Play 0.15 s of a quiet 440 Hz tone and wait for the mixer to finish it, which only
			// happens if OpenAL Soft's CoreAudio backend is really consuming samples.
			int rate = 22050, n = rate * 15 / 100;
			ByteBuffer pcm = BufferUtils.createByteBuffer(n * 2);
			for (int i = 0; i < n; i++) {
				pcm.putShort((short) (Math.sin(2 * Math.PI * 440 * i / rate) * 1500));
			}
			pcm.flip();
			IntBuffer buf = BufferUtils.createIntBuffer(1);
			AL10.alGenBuffers(buf);
			AL10.alBufferData(buf.get(0), AL10.AL_FORMAT_MONO16, pcm, rate);
			AL10.alSourcei(src.get(0), AL10.AL_BUFFER, buf.get(0));
			AL10.alSourcePlay(src.get(0));
			long t0 = System.nanoTime();
			while (AL10.alGetSourcei(src.get(0), AL10.AL_SOURCE_STATE) == AL10.AL_PLAYING
					&& System.nanoTime() - t0 < 3000000000L) {
				Thread.sleep(10);
			}
			int state = AL10.alGetSourcei(src.get(0), AL10.AL_SOURCE_STATE);
			long ms = (System.nanoTime() - t0) / 1000000;
			AL10.alSourcei(src.get(0), AL10.AL_BUFFER, 0);
			AL10.alDeleteBuffers(buf);
			if (state != AL10.AL_STOPPED) {
				throw new IllegalStateException("tone still not finished after " + ms + " ms (state " + state + ")");
			}
			detail += ", played 150 ms tone in " + ms + " ms";
			AL10.alDeleteSources(src);
			int err = AL10.alGetError();
			if (err != AL10.AL_NO_ERROR) {
				throw new IllegalStateException("alGetError " + err);
			}
			pass("al", detail);
		} finally {
			AL.destroy();
		}
	}

	private static void jinput() {
		// The OS X plugin loads libjinput-osx in its static initialiser and reports whether it could.
		ControllerEnvironment osx = new net.java.games.input.OSXEnvironmentPlugin();
		if (!osx.isSupported()) {
			throw new IllegalStateException("OSXEnvironmentPlugin is not supported (libjinput-osx did not load)");
		}
		Controller[] cs = osx.getControllers();
		StringBuilder sb = new StringBuilder();
		for (Controller c : cs) {
			sb.append(sb.length() == 0 ? "" : ", ").append(c.getType()).append(" '").append(c.getName()).append('\'');
		}
		pass("jinput", "OSXEnvironmentPlugin supported, " + cs.length + " controllers [" + sb + "]");
	}
}
