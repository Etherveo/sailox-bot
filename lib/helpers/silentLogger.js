const noop = () => {}
export const silentLogger = { level: 'silent', child() { return this }, trace: noop, debug: noop, info: noop, warn: noop, error: noop }
