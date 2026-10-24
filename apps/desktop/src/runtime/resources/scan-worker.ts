/**
 * Entry point of a scan worker thread (`out/main/scan-worker.js`): hashing, zip parsing,
 * fingerprints, icon extraction and world imports, off the runtime's event loop.
 */
import { parentPort } from 'node:worker_threads'
import { serveScanWorker, type ScanWorkerHandlers } from '@amethyst/content'
import { createResourceWorkerHandlers } from './worker-handlers'

if (!parentPort) throw new Error('scan-worker must run in a worker thread')
// `serveScanWorker` dispatches any own method of the handler object, so the extra jobs ride along.
serveScanWorker(parentPort, createResourceWorkerHandlers() as unknown as ScanWorkerHandlers)
