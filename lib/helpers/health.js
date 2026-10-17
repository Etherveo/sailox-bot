import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
export function createHealthServer({ port = process.env.PORT || process.env.SERVER_PORT || 3000, host = process.env.HEALTH_HOST || '127.0.0.1', token = process.env.HEALTH_TOKEN || '' } = {}) {
  const server = http.createServer((req, res) => {
    const supplied = req.headers.authorization ?? '', expected = 'Bearer ' + token
    const ok = token.length >= 16 && Buffer.byteLength(supplied) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    res.setHeader('content-type', 'text/plain; charset=utf-8'); res.setHeader('cache-control', 'no-store')
    if (!ok) { res.writeHead(401); res.end('Unauthorized'); return }
    if (req.method !== 'GET' || req.url !== '/') { res.writeHead(404); res.end('Not found'); return }
    res.end('OK')
  }); server.requestTimeout = 5000; server.headersTimeout = 5000
  server.listen(Number(port), host); return server
}
