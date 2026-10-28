/**
 * Environment variables that change how macOS, Java, Node or Electron load code. They are never
 * accepted in the game's override env (global settings or an instance), so nothing stored on disk
 * can inject a library or an agent into the game, the pre-launch shell or the wrapper.
 */
const UNSAFE_ENV = /^(?:DYLD_|LD_|ELECTRON_)|^(?:JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|NODE_OPTIONS)$/i

/** True for a variable an override env may not set (`DYLD_*`, `LD_*`, `JAVA_TOOL_OPTIONS`…). */
export function isUnsafeEnvKey(key: string): boolean {
  return UNSAFE_ENV.test(key)
}

/** `env` without the keys {@link isUnsafeEnvKey} rejects. */
export function withoutUnsafeEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !isUnsafeEnvKey(k)))
}
