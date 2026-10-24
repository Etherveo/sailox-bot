// Salin ke config.js. Jangan commit config.js. Semua nomor digit E.164 tanpa +.
global.founder = [] // [[nomor, lidTanpaSuffixAtauKosong, nama]]
global.owner = []
global.mods = []
global.pairing = '' // opsional, tepat 8 huruf/angka; kosong = acak
global.nomorbot = '' // boleh kosong, diminta saat pairing; QR tidak memerlukannya
global.namebot = 'Sailox'
global.timezone = 'Asia/Jakarta'
global.countryCode = '62'
global.prefix = '.!/#$'
global.defaultLimit = 100
global.markOnline = false
global.cooldownMs = 1000
global.maxMessageAgeSec = 120
global.hotReloadCore = false
global.logPrivacy = 'masked' // AGENTS: minimalkan isi chat/nomor pada log secara default
global.kdriveMode = 'direct' // Engine downloader kDrive: 'direct' = request langsung ke kuramadrive (perlu jaringan ter-whitelist); 'stranger' = server asing — bot tidak request ke kuramadrive, .unduh hanya menerima URL endpoint langsung hasil resolusi pihak ter-whitelist. Bisa diganti runtime: .config set kdriveMode stranger
global.rynScope = 'private' // Jangkauan chat Ryn (.ryn dkk): 'private' = DM founder saja | 'group' = grup saja | 'both'. Bisa diganti runtime: .config set rynScope both
global.rynUsers = 'anyone' // Siapa yang boleh memanggil Ryn di grup: 'founder' | 'anyone' (semua anggota). DM selalu founder-only. Runtime: .config set rynUsers founder
global.rynGroups = [] // Allowlist JID grup untuk chat Ryn (cth ['120363xxx@g.us']); kosong = semua grup. Runtime: .config set rynGroups 120363xxx@g.us
global.rynTriggerReply = true // Pesan bebas yang me-reply pesan bot = memanggil Ryn. Runtime: .config set rynTriggerReply off
global.rynTriggerMention = true // Pesan bebas yang men-mention bot = memanggil Ryn. Runtime: .config set rynTriggerMention off
global.kdrivePeer = '' // Nomor bot pasangan relay kDrive (digit saja): mode stranger -> alamat bot resolver; bot resolver -> satu-satunya peminta yang dilayani. Bisa diganti runtime: .config set kdrivePeer 62812...
global.kdriveRelayToken = '' // Token rahasia bersama relay kDrive (samakan persis di kedua bot). SENGAJA hanya dari file ini, tidak dikelola lewat chat. Kosong = autentikasi hanya dari nomor pasangan.
// Catatan: nilai-nilai di file ini adalah DEFAULT awal. Founder dapat mengubah sebagian
// kunci saat runtime lewat perintah .config (list/get/set/del); override-nya tersimpan di
// databases/config.json, diterapkan saat boot, dan langsung berlaku tanpa restart.
global.database = { dir: 'databases', autosaveSec: 30 }
global.identity = { mentionForm: 'pn', validate: true, aliasMigration: true, actionFallback: true }
global.bots = {
  enabled: false, maxBots: 5, maxPerUser: 1, pairingTimeoutSec: 120,
  heapMB: 256, spawnStaggerSec: 4, allowCustomPlugins: false,
  maxPlugins: 30, maxPluginKB: 64, maxDiskMB: 100,
  outbound: { perChatMs: 1200, perSecond: 3 }, allowedPackages: [], logRelay: 'masked',
}
global.legacyAliases = true
global.APIs = {}
global.APIKeys = {}
global.wait = 'Tunggu sebentar…'
global.eror = 'Terjadi kesalahan. Coba lagi nanti.'

// ── Google Drive (fitur .uptodrive) ─────────────────────────────────────────
// Folder tujuan bawaan untuk .uptodrive (kosong = folder bawaan legacy).
// Kredensial dibaca dari folder src/integrations/gdrive-auth/ (credentials.json +
// token.json, JANGAN commit) atau folder lain lewat gdriveAuthDir.
global.gdriveFolderId = ''
global.gdriveAuthDir = ''
