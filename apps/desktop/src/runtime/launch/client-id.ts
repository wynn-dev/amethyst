/**
 * The launcher client id passed to the game as `${clientid}` (`--clientId`): a random UUID made
 * once per install and kept in `client-id.json`. It is unrelated to telemetry's install id, so
 * the two can never be joined.
 */
import { randomUUID } from 'node:crypto'
import { JsonDocument } from '../store/json-store'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Read the stored client id, creating and persisting one when there is none (or it is invalid). */
export async function loadClientId(file: string): Promise<string> {
  const doc = new JsonDocument<{ clientId: string }>(file, {
    version: 1,
    parse: (raw) => ({ clientId: typeof raw.clientId === 'string' && UUID.test(raw.clientId) ? raw.clientId : '' }),
    defaults: () => ({ clientId: '' }),
  })
  await doc.load()
  if (doc.value.clientId) return doc.value.clientId
  const clientId = randomUUID()
  await doc.set({ clientId })
  return clientId
}
