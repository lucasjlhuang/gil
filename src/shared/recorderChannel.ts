/** Runtime-dependency-free and in its own file so each sandboxed preload bundles to a single script. */
export const RecorderChannel = {
  /** main -> recorder */
  stop: 'recorder:stop',
  /** recorder -> main */
  started: 'recorder:started',
  chunk: 'recorder:chunk',
  stopped: 'recorder:stopped',
  failed: 'recorder:failed',
} as const
