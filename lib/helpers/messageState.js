const states = new WeakMap()
export function messageState(m) { if (!states.has(m)) states.set(m, {}); return states.get(m) }
