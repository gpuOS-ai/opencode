import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ToolRegistry } from "../opencode/src/tool/registry"
import { Instance } from "../opencode/src/project/instance"
import type { Tool } from "../opencode/src/tool/tool"

const MCP_PORT = Number(Bun.env.MCP_PORT ?? "8000")
const MCP_PATH = Bun.env.MCP_PATH ?? "/mcp"
const PROVIDER_ID = Bun.env.OPENCODE_PROVIDER_ID ?? "opencode"
const INSTANCE_DIRECTORY = Bun.env.OPENCODE_DIRECTORY ?? process.cwd()

async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  return Instance.provide({ directory: INSTANCE_DIRECTORY, fn })
}

const toolsPromise = withInstance(() => ToolRegistry.tools(PROVIDER_ID))

async function buildServer(): Promise<McpServer> {
  const server = new McpServer(
    {
      name: "opencode-tool-registry",
      version: "0.1.0",
    },
    { capabilities: { logging: {} } },
  )

  const tools = await toolsPromise
  for (const tool of tools) {
    server.registerTool(
      tool.id,
      {
        description: tool.description,
        inputSchema: tool.parameters,
      },
      async (args, extra) => {
        const abortController = new AbortController()
        const ctx: Tool.Context = {
          sessionID: String(extra?.sessionId ?? "mcp-session"),
          messageID: String(extra?.requestId ?? "mcp-message"),
          agent: "mcp-server",
          abort: abortController.signal,
          metadata: () => {},
          ask: async () => {},
        }

        const result = await withInstance(() => tool.execute(args as never, ctx))
        let text = result.output

        if (result.attachments?.length) {
          const attachmentLines = result.attachments.map((attachment) => {
            return `${attachment.type}:${attachment.mime ?? "unknown"}:${attachment.url}`
          })
          text += `\n\n<attachments>\n${attachmentLines.join("\n")}\n</attachments>`
        }

        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
        }
      },
    )
  }

  return server
}

const server = Bun.serve({
  port: MCP_PORT,
  fetch: async (req) => {
    const url = new URL(req.url)
    if (url.pathname !== MCP_PATH) {
      return new Response("Not Found", { status: 404 })
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    const mcpServer = await buildServer()

    try {
      await mcpServer.connect(transport)
      return await transport.handleRequest(req)
    } catch (error) {
      console.error("MCP request failed", error)
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
          },
        },
      )
    } finally {
      await transport.close().catch(() => {})
      await mcpServer.close().catch(() => {})
    }
  },
})

console.log(`MCP server listening on http://localhost:${server.port}${MCP_PATH}`)

let shuttingDown = false
const shutdown = (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`Received ${signal}, shutting down...`)
  server.stop(true)
  process.exit(0)
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
