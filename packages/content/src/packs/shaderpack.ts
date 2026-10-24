import { throwIfAborted } from '../errors'
import { nestedRootWith, type PackWarning } from './resourcepack'
import { openPackSource } from './source'

/** What can be learned about a shader pack without a metadata file. */
export interface ShaderPackInfo {
  format: 'zip' | 'folder'
  /** True when the pack root contains a `shaders/` directory. */
  valid: boolean
  /** True when `shaders/shaders.properties` exists (optional; many valid packs lack it). */
  hasProperties: boolean
  /** Names of the `shaders/lang/*.lang` files, if any (e.g. `en_US.lang`). */
  languages: string[]
  /** When the real pack root is one folder deeper, that folder's name. */
  nestedRoot?: string
  warnings: PackWarning[]
}

/**
 * Detect a shader pack (zip or folder): it is valid when it has a `shaders/` directory at the
 * root. A zip without one is reported with a warning (and `nestedRoot` when the directory is
 * one level too deep).
 *
 * @throws {ContentError} `EINVALID_ZIP`, `ENOT_FOUND` or `EPERMISSION` when the pack cannot be opened.
 */
export async function readShaderPack(packPath: string, options: { signal?: AbortSignal } = {}): Promise<ShaderPackInfo> {
  throwIfAborted(options.signal)
  const source = await openPackSource(packPath)
  try {
    if (await source.hasDir('shaders')) {
      const hasProperties = await source.hasFile('shaders/shaders.properties')
      const languages: string[] = []
      if (await source.hasDir('shaders/lang')) {
        for (const name of await source.listDir('shaders/lang')) if (name.endsWith('.lang')) languages.push(name)
      }
      return { format: source.format, valid: true, hasProperties, languages, warnings: [] }
    }
    const nestedRoot = await nestedRootWith(source, (d) => source.hasDir(`${d}/shaders`))
    return {
      format: source.format,
      valid: false,
      hasProperties: false,
      languages: [],
      ...(nestedRoot !== undefined ? { nestedRoot } : {}),
      warnings: [
        nestedRoot !== undefined
          ? { code: 'nested-too-deep', message: `The shader pack is nested one folder too deep (inside "${nestedRoot}")` }
          : { code: 'missing-shaders', message: 'Not a shader pack: no shaders/ folder' },
      ],
    }
  } finally {
    await source.close()
  }
}
