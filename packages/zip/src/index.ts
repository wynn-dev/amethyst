/**
 * Promise-based zip reading and writing on top of `yauzl` / `yazl`.
 *
 * {@link openZip} gives random access to single entries (mod metadata in jars, `pack.mcmeta`,
 * modpack manifests) without inflating the whole archive, plus safe streaming extraction for
 * natives, installers and modpack overrides. {@link createZip} streams a new archive to disk.
 *
 * All archives are treated as untrusted: extraction rejects path traversal and escaping
 * symlinks, entry sizes are validated while inflating, and errors are typed {@link ZipError}s.
 */
export { ZipError, type ZipErrorCode } from './errors'
export {
  openZip,
  type ExtractOptions,
  type ExtractResult,
  type ReadBufferOptions,
  type ZipEntryInfo,
  type ZipReader,
  type ZipSource,
} from './reader'
export { createZip, type CreateZipOptions, type ZipAddOptions, type ZipWriter } from './writer'
