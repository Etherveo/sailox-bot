import { ownerFileCommands } from '#lib/helpers/fileCommands.js'
let handler = async (m, ctx) => ownerFileCommands(m, ctx)
handler.help = ['getfile <path|nomor>'];
handler.tags = ['owner'];
handler.command = /^getfile$/i;
handler.owner = true
handler.bigSend = true // opt-in Penjaga Kirim Besar: .getfile boleh mengirim file >150 MB dengan reservasi (fase 2)
export default handler
