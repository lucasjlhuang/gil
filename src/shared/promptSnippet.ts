/**
 * The "Prompt" output: a ready-to-paste instruction for any AI coding tool, with the spec and
 * the recreation, so the asset can be used even where the MCP server is not set up.
 */
export function promptSnippet(input: { name: string; specMarkdown: string | null; html: string | null }): string {
  const parts = [
    `Use the design reference "${input.name}" below. Match its look and motion as closely as possible: the tokens, layout, timings and easing are deliberate. Replace the placeholder content with this project's own, and adapt the code to this project's framework and conventions.`,
  ]
  if (input.specMarkdown) parts.push(`## Spec\n\n${input.specMarkdown.trim()}`)
  if (input.html) parts.push(`## Reference implementation\n\n\`\`\`html\n${input.html.trim()}\n\`\`\``)
  return `${parts.join('\n\n')}\n`
}
