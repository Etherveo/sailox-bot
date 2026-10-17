import path from 'node:path'
import { fork } from 'node:child_process'
export function launcherOptions({ root, sandbox, id, config, flags = process.allowedNodeEnvironmentFlags, platform = process.platform }) {
  const flag = flags.has('--permission') ? '--permission' : flags.has('--experimental-permission') ? '--experimental-permission' : null
  const execArgv = [`--max-old-space-size=${config.heapMB}`]
  if (flag) { execArgv.push(flag, ...[sandbox, path.join(root, 'lib'), path.join(root, 'handler.js'), path.join(root, 'package.json'), path.join(root, 'node_modules')].map(p => '--allow-fs-read=' + p), '--allow-fs-write=' + sandbox); if (flags.has('--allow-net')) execArgv.push('--allow-net=*') }
  const env = { SUBBOT_ID: id, TMPDIR: path.join(sandbox, 'tmp'), TMP: path.join(sandbox, 'tmp'), TEMP: path.join(sandbox, 'tmp'), TZ: config.timezone ?? 'Asia/Jakarta', NODE_ENV: 'production' }
  if (platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
  return { cwd: sandbox, env, execArgv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json', permission: !!flag, allowCustomPlugins: flag ? config.allowCustomPlugins : false }
}
export function launchWorker(options, spawn = fork) { const resolved = launcherOptions(options), { permission, allowCustomPlugins, ...forkOptions } = resolved; return { child: spawn(path.join(options.root, 'lib/subbot/runtime/worker.js'), [options.sandbox], forkOptions), permission, allowCustomPlugins } }
