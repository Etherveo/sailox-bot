import fs from 'fs'
import path from 'path'

let handler = async (m, { args, usedPrefix , command}) => {
	const key = (args[0] || '').toLowerCase()
	const flag = (args[1] || '').toLowerCase()

	const isAll = key === 'all'
	const isPublic = /^p(ubli(c|k))?$/.test(flag)
	const isForce = flag === 'force'
	
	if (!key) {
		return m.reply(`Ex: ${usedPrefix + command} pd/gd/mg/mf/gf/tr/all publik/force`)
	}

	// Mapping cache
	const cacheMap = {
		pd: './src/pixeldrain',
		gd: './src/gdrive',
		mg: './src/mega',
		mf: './src/mediafire',
		gf: './src/gofile',
		tr: './src/torrents',
		tw: './src/public/twitter',
		mp: './src/mp4upload'
	}
	
	const publicDir = {
		pd: './src/public/pixeldrain',
		gd: './src/public/gdrive',
		mg: './src/public/mega',
		mf: './src/public/mediafire',
		gf: './src/public/gofile',
		tr: './src/public/torrents',
		tw: './src/public/twitter',
		mp: './src/public/mp4upload',
		tmp: './src/public/tmp'
	}

	// Tentukan target
	let sources = []
	
	if (isForce) {
		sources.push(cacheMap, publicDir)
	} else if (isPublic) {
		sources.push(publicDir)
	} else {
		sources.push(cacheMap)
	}
	
	let targets = []
	
	for (const src of sources) {
		if (isAll) {
			targets.push(...Object.values(src))
		} else if (src[key]) {
			targets.push(src[key])
		}
	}
	
	if (!targets.length) return m.reply('❌ Cache tidak dikenali atau tidak tersedia.\nGunakan: pd/gd/mg/mf/gf/tr/all publik/force')

	let cleared = []
	let skipped = []
	
	m.reply("Processing to clearing cache ...")

	for (const dir of targets) {
		const targetDir = path.resolve(dir)

		// Validasi
		if (!fs.existsSync(targetDir)) {
			skipped.push(`${dir} (tidak ada)`)
			continue
		}
		if (!fs.statSync(targetDir).isDirectory()) {
			skipped.push(`${dir} (bukan folder)`)
			continue
		}

		try {
			const items = fs.readdirSync(targetDir)
			if (!items.length) {
				skipped.push(`${dir} (kosong)`)
				continue
			}

			for (const item of items) {
				const itemPath = path.join(targetDir, item)
				fs.rmSync(itemPath, { recursive: true, force: true })
			}

			cleared.push(dir)
		} catch (err) {
			console.error(err)
			skipped.push(`${dir} (error)`)
		}
	}

	// Output
	let result = `🧹 *Clear Cache Result*\n\n`

	if (cleared.length) {
		result += `✅ Dibersihkan:\n${cleared.map(v => '• ' + v).join('\n')}\n\n`
	}
	if (skipped.length) {
		result += `⚠️ Dilewati:\n${skipped.map(v => '• ' + v).join('\n')}`
	}

	await m.reply(result.trim())
}

handler.help = ['clearcache pd/gd/mg/mf/gf/all']
handler.tags = ['owner']
handler.command = /^(c(lear)?c(ac)?h(e)?)$/i
handler.rowner = true

export default handler