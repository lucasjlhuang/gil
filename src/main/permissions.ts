import { desktopCapturer, shell, systemPreferences } from 'electron'
import type { ScreenPermission } from '../shared/channels'

const SCREEN_RECORDING_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

export function screenPermission(): ScreenPermission {
  if (process.platform !== 'darwin') return 'granted'
  return systemPreferences.getMediaAccessStatus('screen')
}

/**
 * There is no API to ask for Screen Recording access (`askForMediaAccess` covers only camera
 * and microphone). Attempting a capture is what makes macOS show its prompt and add the app to
 * the list in System Settings.
 */
export async function requestScreenPermission(): Promise<ScreenPermission> {
  try {
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
  } catch {
    // Expected when access is denied; the status below is what matters.
  }
  return screenPermission()
}

export function openScreenRecordingSettings(): Promise<void> {
  return shell.openExternal(SCREEN_RECORDING_SETTINGS)
}
