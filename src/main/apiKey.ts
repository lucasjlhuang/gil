import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { writeFileAtomic } from './storage'

/**
 * The user's Anthropic API key, encrypted with Electron's safeStorage (the macOS keychain) in
 * the app's settings folder. It never goes to a renderer, the library folder or a log. The
 * library window can only set it, clear it, and ask whether one is saved.
 */

const KEY_FILE = 'anthropic-key.bin'

function keyPath(settingsDir = app.getPath('userData')): string {
  return join(settingsDir, KEY_FILE)
}

/** `settingsDir` is for the benchmark runner, which keeps its own settings folder. */
export async function loadApiKey(settingsDir?: string): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) return null
  const encrypted = await readFile(keyPath(settingsDir)).catch(() => null)
  if (!encrypted) return null
  try {
    return safeStorage.decryptString(encrypted)
  } catch {
    return null
  }
}

export async function hasApiKey(): Promise<boolean> {
  return (await loadApiKey()) !== null
}

export async function saveApiKey(key: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('macOS did not allow gil to encrypt the key')
  }
  await writeFileAtomic(keyPath(), safeStorage.encryptString(key))
}

export async function clearApiKey(): Promise<void> {
  await rm(keyPath(), { force: true })
}
