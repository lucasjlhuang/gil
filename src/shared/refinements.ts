import { z } from 'zod'

/**
 * The changes the user asked for with Refine, kept in `recreation/refinements.json` so later
 * verify rounds know they are deliberate. Without them, a check against the original frames
 * sees the requested change as a difference and undoes it.
 *
 * Pure: the schema and the text that tells the model about them.
 */

export const REFINEMENTS_VERSION = 1
export const MAX_REQUEST_LENGTH = 2000
const MAX_REQUESTS = 50

export const refinementsSchema = z.object({
  version: z.literal(REFINEMENTS_VERSION),
  requests: z.array(z.string().trim().min(1).max(MAX_REQUEST_LENGTH)).max(MAX_REQUESTS),
})

export type Refinements = z.infer<typeof refinementsSchema>

export const NO_REFINEMENTS: Refinements = { version: REFINEMENTS_VERSION, requests: [] }

/** The list with one more request, dropping the oldest past the limit. */
export function addRequest(refinements: Refinements, request: string): Refinements {
  const requests = [...refinements.requests, request.trim().slice(0, MAX_REQUEST_LENGTH)]
  return { version: REFINEMENTS_VERSION, requests: requests.slice(-MAX_REQUESTS) }
}

/**
 * What a verify round is told about the user's changes: the ones already applied, which must be
 * kept, and the one to apply now, if any. Empty when there are none.
 */
export function changesNote(applied: readonly string[], request: string | null): string {
  const parts: string[] = []
  if (applied.length > 0) {
    parts.push(
      [
        'The user asked for these changes earlier. They are deliberate departures from the original: where the recreation differs from the original because of one, it is correct, so keep it and do not list it as a difference.',
        ...applied.map((change) => `- ${change}`),
      ].join('\n'),
    )
  }
  if (request) {
    parts.push(`The change the user is asking for now. Apply it; where it conflicts with the original, it wins:\n${request}`)
  }
  return parts.join('\n\n')
}
