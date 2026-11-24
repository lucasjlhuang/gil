/** Runtime-dependency-free and in its own file so each sandboxed preload bundles to a single script. */
export const OverlayChannel = {
  /** main -> overlay */
  state: 'overlay:state',
  /** overlay -> main */
  /** invoke: which window a selection belongs to */
  resolveTarget: 'overlay:resolve-target',
  record: 'overlay:record',
  screenshot: 'overlay:screenshot',
  cancel: 'overlay:cancel',
  painted: 'overlay:painted',
  focus: 'overlay:focus',
  setInteractive: 'overlay:set-interactive',
  stop: 'overlay:stop',
} as const

/** Longest context note the overlay accepts. */
export const MAX_CONTEXT_LENGTH = 2000
