import { z } from 'zod'

/**
 * The small part of the Model Context Protocol gil's server needs: JSON-RPC 2.0 messages over
 * stdio, one per line, with initialize, ping, tools and prompts. Written here rather than pulled
 * in as the SDK, which brings a web server along; this server only ever talks over stdio.
 * Pure: `handleMessage` takes a parsed message and returns the reply, if any.
 */

/** Newest first. The server answers with the client's version if it knows it, else its newest. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const

export interface TextContent {
  type: 'text'
  text: string
}
export interface ImageContent {
  type: 'image'
  data: string
  mimeType: string
}
export type Content = TextContent | ImageContent

export interface ToolResult {
  content: Content[]
  isError?: boolean
}

export interface Tool {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<ToolResult>
}

export interface Prompt {
  name: string
  title: string
  description: string
  arguments: { name: string; description: string; required: boolean }[]
  get: (args: Record<string, string>) => Promise<{ description: string; messages: { role: 'user'; content: Content }[] }>
}

export interface Server {
  name: string
  version: string
  instructions: string
  tools: Tool[]
  prompts: Prompt[]
}

const messageSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
})

type Id = string | number

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602

function reply(id: Id, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result }
}
function failure(id: Id | null, code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } }
}

export type Reply = ReturnType<typeof reply> | ReturnType<typeof failure>

/** Handles one line from the client. Notifications and replies to us get no answer (null). */
export async function handleLine(server: Server, line: string): Promise<Reply | null> {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return failure(null, PARSE_ERROR, 'Not valid JSON')
  }
  return handleMessage(server, json)
}

export async function handleMessage(server: Server, json: unknown): Promise<Reply | null> {
  const parsed = messageSchema.safeParse(json)
  if (!parsed.success) return failure(null, INVALID_REQUEST, 'Not a JSON-RPC 2.0 message')
  const { id, method, params = {} } = parsed.data
  // A notification (no id), or a response to something we sent (no method): nothing to answer.
  if (id === undefined || method === undefined) return null

  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      const version = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0]
      return reply(id, {
        protocolVersion: version,
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: server.name, version: server.version },
        instructions: server.instructions,
      })
    }
    case 'ping':
      return reply(id, {})
    case 'tools/list':
      return reply(id, {
        tools: server.tools.map(({ name, title, description, inputSchema }) => ({
          name,
          title,
          description,
          inputSchema,
          annotations: { readOnlyHint: true, openWorldHint: false },
        })),
      })
    case 'tools/call': {
      const tool = server.tools.find((candidate) => candidate.name === params.name)
      if (!tool) return failure(id, INVALID_PARAMS, `Unknown tool: ${String(params.name)}`)
      const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {}
      try {
        return reply(id, await tool.run(args))
      } catch (error) {
        // Tool failures are results the model can read, not protocol errors.
        return reply(id, { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true })
      }
    }
    case 'prompts/list':
      return reply(id, {
        prompts: server.prompts.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args })),
      })
    case 'prompts/get': {
      const prompt = server.prompts.find((candidate) => candidate.name === params.name)
      if (!prompt) return failure(id, INVALID_PARAMS, `Unknown prompt: ${String(params.name)}`)
      const args: Record<string, string> = {}
      if (params.arguments && typeof params.arguments === 'object') {
        for (const [key, value] of Object.entries(params.arguments)) if (typeof value === 'string') args[key] = value
      }
      try {
        return reply(id, await prompt.get(args))
      } catch (error) {
        return failure(id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))
      }
    }
    default:
      return failure(id, METHOD_NOT_FOUND, `Method not supported: ${method}`)
  }
}
