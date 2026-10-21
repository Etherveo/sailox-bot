// Override konfigurasi runtime yang diatur founder lewat perintah .config.
// Record tunggal berkunci 'global' menampung objek override (boleh bersarang, mis. bots.enabled);
// nilai dasarnya tetap dari config.js. Tersimpan sebagai JSON di databases/config.json oleh engine.
export default { name: 'config', version: 1, defaults: () => ({}) }
