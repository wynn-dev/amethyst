/*
 * Amethyst: force-included (clang -include) into every LWJGL 2 native source file.
 *
 * It re-declares Apple APIs that were removed from the *headers* of modern macOS SDKs but are
 * still exported by the system frameworks (macOS 13 through at least 27), plus one Apple Java 6
 * type. This keeps the upstream sources untouched for these cases, in all five LWJGL versions.
 * A missing export would fail at link time (the SDK .tbd stubs are checked), never at run time.
 *
 * Only plain C types are used here: pulling in Cocoa or ApplicationServices would drag Apple's
 * OpenGL headers into the generated GL sources, which declare their own GL types.
 */
#ifndef AMETHYST_LWJGL2_COMPAT_H
#define AMETHYST_LWJGL2_COMPAT_H

#include <stddef.h>
#include <stdint.h>

/* CGRemoteOperation.h: removed from the headers, still exported by CoreGraphics. Used by
 * MacOSXMouseEventQueue.getMouseDeltas (mouse deltas for Display.setParent / AWT canvases). */
typedef int32_t CGMouseDelta;
extern void CGGetLastMouseDelta(CGMouseDelta *deltaX, CGMouseDelta *deltaY);

/* CGDirectDisplay.h: removed from the headers, still exported (CGDirectDisplayID is uint32_t).
 * Only reached when the display mode's pixel encoding is not one of the known IOKit strings. */
extern size_t CGDisplayBitsPerPixel(uint32_t display);

/* Run a block synchronously on the main (AppKit) thread; used by the main-thread patches.
 *
 * Current macOS versions enforce that NSOpenGLContext -setView:, -update etc. run on
 * the main thread (AppKit traps otherwise). LWJGL 2 calls them from the thread that owns the
 * Display, which is never the main thread on macOS (LWJGL 2 runs without -XstartOnFirstThread).
 * The java launcher (or AWT) keeps the main thread in a CFRunLoop; the block is queued for the
 * common modes plus AWT's private run loop mode, the same modes AWT uses for its own calls. */
#if defined(__OBJC__)
#include <CoreFoundation/CoreFoundation.h>
#include <dispatch/dispatch.h>
#include <pthread.h>
static inline void amethyst_run_on_main(void (^block)(void)) {
	if (pthread_main_np()) {
		block();
		return;
	}
	dispatch_semaphore_t done = dispatch_semaphore_create(0);
	const void *modes[] = { kCFRunLoopCommonModes, CFSTR("AWTRunLoopMode") };
	CFArrayRef mode_array = CFArrayCreate(NULL, modes, 2, &kCFTypeArrayCallBacks);
	CFRunLoopPerformBlock(CFRunLoopGetMain(), mode_array, ^{
		block();
		dispatch_semaphore_signal(done);
	});
	CFRelease(mode_array);
	CFRunLoopWakeUp(CFRunLoopGetMain());
	dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
	dispatch_release(done);
}

/* Run loop modes for LWJGL's own blocking performSelectorOnMainThread calls (see
 * patches/lwjgl/mainthread-awt-run-loop-mode.patch). Expanded at the call sites, which import
 * Cocoa. */
#define AMETHYST_MAIN_THREAD_MODES ([NSArray arrayWithObjects:NSRunLoopCommonModes, @"AWTRunLoopMode", nil])
#endif

#if defined(__OBJC__)
/* Apple Java 6's JavaVM.framework jawt_md.h. OpenJDK (7+) on macOS does not have it: its
 * drawing-surface platformInfo is an object implementing JAWT_SurfaceLayers instead. LWJGL only
 * dereferences cocoaViewRef on the legacy (non-CALayer) path, which OpenJDK never takes because
 * LWJGL always requests JAWT_MACOSX_USE_CALAYER and OpenJDK's JAWT requires that flag. */
@class NSView;
typedef struct JAWT_MacOSXDrawingSurfaceInfo {
	NSView *cocoaViewRef;
} JAWT_MacOSXDrawingSurfaceInfo;
#endif

#endif
