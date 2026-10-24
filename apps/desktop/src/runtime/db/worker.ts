/**
 * Entry point of the SQLite worker thread (`out/main/db-worker.js`). Owns the only connection
 * to `index.sqlite`; everything else talks to it through {@link DbClient}.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { serveDatabase } from './serve'
import type { DbWorkerData } from './protocol'

if (!parentPort) throw new Error('db-worker must run in a worker thread')
serveDatabase(parentPort, workerData as DbWorkerData)
