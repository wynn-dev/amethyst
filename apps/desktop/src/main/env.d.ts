/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly AMETHYST_MSA_CLIENT_ID?: string
  readonly AMETHYST_CURSEFORGE_API_KEY?: string
  readonly AMETHYST_POSTHOG_KEY?: string
  readonly AMETHYST_POSTHOG_HOST?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
