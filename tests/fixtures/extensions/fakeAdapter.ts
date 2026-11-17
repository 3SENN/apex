import type { Session } from 'electron'
import type { ExtensionsAdapter, LoadedExtension } from '../../../src/main/extensions/adapter'
import { NATIVE_APIS } from '../../../src/main/extensions/compat'
import { unpackedId } from '../../../src/main/extensions/host'
import { readManifest } from '../../../src/main/extensions/manifest'

// A fake extensions runtime for host tests: loading records the
// folder and nothing touches Electron.
export function fakeAdapter(): ExtensionsAdapter & { loaded: Map<string, LoadedExtension> } {
  const loaded = new Map<string, LoadedExtension>()
  return {
    name: 'fake',
    apis: NATIVE_APIS,
    loaded,
    async load(_s, dir) {
      const m = readManifest(dir)
      if (!m) throw new Error('no manifest')
      const ext = { id: unpackedId(dir, m), name: String(m.name), version: String(m.version), path: dir, url: '', manifest: m }
      loaded.set(ext.id, ext)
      return ext
    },
    unload: (_s, id) => void loaded.delete(id),
    get: (_s, id) => loaded.get(id) ?? null,
    all: () => [...loaded.values()],
    onUnloaded: () => () => {},
    installPreloads: () => {},
  }
}

/** Just enough of a Session for ExtensionsHost.attach and remove. */
export const fakeSession = (): Session => ({ serviceWorkers: { on: () => {} }, clearStorageData: async () => {} }) as unknown as Session
