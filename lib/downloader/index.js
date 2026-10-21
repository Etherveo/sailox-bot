// lib/downloader/index.js
//
// Barrel untuk subsistem downloader: registry engine (hot-reload),
// helper mime, dan streaming. Plugin interface (.unduh) dan perintah
// owner pengelola engine cukup impor dari sini.

export {
  createEngineRegistry,
  downloaderRegistry,
  ensureEngines,
  detectProvider,
  getEngine,
  supportedProviders,
  inspectEngine,
  engineName,
  ENGINE_NAME_RE
} from './registry.js'
export { resolveExtension, getExtFromMime, buildFileName, mimeMap } from './mime.js'
export { streamToFile, DEFAULT_MAX_DOWNLOAD_BYTES } from './stream.js'
export { createDownloadQueue, getDownloadQueue, attachDownloadProcessor, QUEUE_DEFAULTS } from './queue.js'
export { runDownloadJob, providerLabel, PROVIDER_LABELS, formatSize, WA_MAX_BYTES } from './runJob.js'
export { engineGuardian, attachEngineNotifierWithConn, reportEngineError, ownerJid, createEngineGuardian } from './guardian.js'
