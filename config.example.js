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
