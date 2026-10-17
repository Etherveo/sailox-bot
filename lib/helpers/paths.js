import { fileURLToPath } from 'node:url'
import path from 'node:path'
export const filename = url => fileURLToPath(url)
export const dirname = url => path.dirname(filename(url))
export function installPaths() { global.__filename = filename; global.__dirname = dirname }
