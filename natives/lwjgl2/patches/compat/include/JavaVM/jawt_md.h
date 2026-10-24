/*
 * Amethyst: JavaVM.framework (Apple Java 6) no longer exists in macOS SDKs. LWJGL's
 * org_lwjgl_opengl_AWTSurfaceLock.c includes <JavaVM/jawt_md.h>; forward it to the JDK's
 * <jawt_md.h> (include/darwin), which is on the include path.
 */
#include <jawt_md.h>
