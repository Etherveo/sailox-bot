// lib/downloader/engines/mega.js
//
// Refactored: primary engine = direct MEGA API (tanpa megajs),
// megajs hanya dipakai sebagai fallback di blok catch.
//
// Primary flow:
//   parseMegaUrl → getMegaInfo + decodeAttr (nama & ukuran) →
//   getMegaDirect (CDN URL) → fetch → pipeline stream ke disk
//
// Fallback flow (bila primary throw di titik mana pun):
//   megajs File.fromURL → loadAttributes → file.download() → pipe ke disk
//   (reuse _megaFile dari getInfo kalau tersedia, hindari loadAttributes ulang)

import { createDecipheriv } from 'crypto'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import fs from 'fs'
import path from 'path'
import { buildFileName } from '../mime.js'

export const id = 'mega'

const MEGA_API = 'https://g.api.mega.co.nz/cs'

// ─── Helpers (diadaptasi dari downloader-mega-new.js) ─────────────────────────

function parseMegaUrl(url) {
	url = String(url).trim()
	const m =
		url.match(/mega\.(?:nz|co\.nz)\/file\/([A-Za-z0-9_-]{8})#([A-Za-z0-9_-]+)/) ||
		url.match(/mega\.(?:nz|co\.nz)\/#!([A-Za-z0-9_-]{8})!([A-Za-z0-9_-]+)/)
	if (!m) throw new Error('Link Mega tidak valid!')
	return { fileId: m[1], fileKey: m[2] }
}

async function getMegaInfo(fileId) {
	const res = await fetch(`${MEGA_API}?id=${Date.now()}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify([{ a: 'g', g: 1, ssl: 2, p: fileId }]),
	})
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	const data = await res.json()
	const info = Array.isArray(data) ? data[0] : data
	if (typeof info === 'number' && info < 0) {
		const errMap = { '-9': 'File tidak ditemukan / expired', '-3': 'Too many requests' }
		throw new Error(errMap[String(info)] ?? `Mega error: ${info}`)
	}
	return info
}

async function getMegaDirect(url) {
	const { fileId } = parseMegaUrl(url)
	const res = await fetch(`${MEGA_API}?id=${Date.now()}&n=${fileId}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify([{ a: 'g', g: 1, ssl: 1, p: fileId }]),
	})
	if (!res.ok) throw new Error('Gagal memanggil API MEGA')
	const data = await res.json()
	const direct = data?.[0]?.g
	if (!direct) throw new Error('Direct link tidak tersedia')
	return direct
}

function b64ToA32(str) {
	const buf = Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
	const arr = []
	for (let i = 0; i < buf.length; i += 4)
		arr.push(
			((buf[i] || 0) << 24) | ((buf[i + 1] || 0) << 16) |
			((buf[i + 2] || 0) << 8) | (buf[i + 3] || 0)
		)
	return arr
}

function a32ToBuffer(a32) {
	const buf = Buffer.alloc(a32.length * 4)
	for (let i = 0; i < a32.length; i++) buf.writeUInt32BE(a32[i] >>> 0, i * 4)
	return buf
}

function decodeAttr(attrStr, keyB64) {
	const key = b64ToA32(keyB64)
	const k = [
		(key[0] ^ key[4]) >>> 0,
		(key[1] ^ key[5]) >>> 0,
		(key[2] ^ key[6]) >>> 0,
		(key[3] ^ key[7]) >>> 0,
	]
	const aesKey = a32ToBuffer(k)
	const attrBuf = Buffer.from(attrStr.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
	const iv = Buffer.alloc(16, 0)
	const decipher = createDecipheriv('aes-128-cbc', aesKey, iv)
	decipher.setAutoPadding(false)
	const decrypted = Buffer.concat([decipher.update(attrBuf), decipher.final()])
		.toString('utf8')
		.replace(/\0+$/g, '')
	if (!decrypted.startsWith('MEGA')) return null
	const json = JSON.parse(decrypted.slice(4))
	return json?.n ?? null
}

// ─── Engine interface ──────────────────────────────────────────────────────────

export function match(url = '') {
	return /mega\.nz/i.test(url)
}

export async function getInfo(url) {
	try {
		// ── Primary: direct MEGA API ──────────────────────────────────────────
		const { fileId, fileKey } = parseMegaUrl(url)
		const apiInfo = await getMegaInfo(fileId)

		let fileName = `mega_${fileId}`
		if (fileKey && apiInfo?.at) {
			try {
				const decoded = decodeAttr(apiInfo.at, fileKey)
				if (decoded) fileName = decoded
			} catch {}
		}

		return {
			fileName,
			size: apiInfo?.s ?? null,
			_fileId: fileId,
			_fileKey: fileKey,
			// _megaFile tidak diisi — fallback di download() load sendiri kalau dibutuhkan
		}
	} catch {
		// ── Fallback: megajs ──────────────────────────────────────────────────
		const { File } = await import('megajs')
		let file = File.fromURL(url)
		file = await file.loadAttributes()
		if (!file?.name) throw new Error('Gagal membaca metadata file Mega (link mungkin sudah tidak valid).')
		return { fileName: file.name, size: file.size ?? null, _megaFile: file }
	}
}

export async function download(url, info, { destDir, baseName }) {
	const fileName = buildFileName(baseName, { mimetype: '', fileName: info.fileName })
	const filePath = path.join(destDir, fileName)

	try {
		// ── Primary: CDN direct → pipeline stream ke disk (tanpa buffer penuh di RAM) ──
		const directUrl = await getMegaDirect(url)
		const res = await fetch(directUrl)
		if (!res.ok) throw new Error(`CDN Mega balik ${res.status}`)

		await pipeline(
			Readable.fromWeb(res.body),
			fs.createWriteStream(filePath)
		)

	} catch {
		// ── Fallback: megajs stream ───────────────────────────────────────────
		// Reuse _megaFile dari getInfo() kalau ada (getInfo sudah loadAttributes),
		// kalau tidak ada (getInfo pakai primary path), load sendiri di sini.
		const { File } = await import('megajs')
		const file = info._megaFile ?? await File.fromURL(url).loadAttributes()

		await new Promise((resolve, reject) => {
			const stream = file.download()
			const writer = fs.createWriteStream(filePath)
			stream.on('error', reject)
			writer.on('error', reject).on('finish', resolve)
			stream.pipe(writer)
		})
	}

	return { filePath, fileName, mimetype: 'application/octet-stream' }
}
