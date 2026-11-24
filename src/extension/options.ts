import { ping } from './upload'

/** Pairing: the user pastes the code shown in gil's library window. */

const form = document.querySelector('form') as HTMLFormElement
const input = document.querySelector('input') as HTMLInputElement
const status = document.querySelector('.status') as HTMLElement

function show(text: string, ok: boolean): void {
  status.textContent = text
  status.className = ok ? 'status ok' : 'status error'
}

void chrome.storage.local.get('pairingCode').then(({ pairingCode }) => {
  if (typeof pairingCode !== 'string' || !pairingCode) return
  input.value = pairingCode
  void ping(pairingCode).then((result) =>
    result.ok ? show('Connected to gil.', true) : show(result.error, false),
  )
})

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const code = input.value.trim()
  if (!code) return show('Paste the pairing code from gil.', false)
  show('Checking…', true)
  void ping(code).then(async (result) => {
    if (!result.ok) return show(result.error, false)
    await chrome.storage.local.set({ pairingCode: code })
    show('Paired. Click the gil icon on any page to capture it.', true)
  })
})
