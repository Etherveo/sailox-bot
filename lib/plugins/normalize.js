export function normalizePlugin(mod, { legacyAliases = global.legacyAliases !== false, warn = () => {} } = {}) {
  const original = mod.default ?? mod
  if (typeof original !== 'function' && !['all', 'before', 'after'].some(k => typeof original[k] === 'function')) return null
  const plugin = typeof original === 'function' ? original : { ...original }
  if (!legacyAliases && (plugin.rowner || plugin.customPrefix)) throw new Error('Plugin legacy dinonaktifkan; migrasikan metadata sebelum mematikan alias')
  if (legacyAliases && (plugin.customPrefix || plugin.rowner)) { if (plugin.customPrefix && !plugin.prefixless) plugin.prefixless = plugin.customPrefix; if (plugin.rowner) plugin.founder = true; warn('Alias legacy: gunakan prefixless/founder') }
  if (plugin.prefixless && plugin.command == null) plugin.command = new RegExp()
  plugin.help = (Array.isArray(plugin.help) ? plugin.help : typeof plugin.help === 'string' ? [plugin.help] : []).filter(x => typeof x === 'string')
  plugin.tags = (Array.isArray(plugin.tags) ? plugin.tags : []).filter(x => typeof x === 'string').map(x => x.toLowerCase())
  return plugin
}
