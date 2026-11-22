# Installing yueser-mcp (Qiku MCP Directory)

A **remote** MCP server. There is nothing to install locally and no API key is required.

- **Transport:** Streamable HTTP
- **URL:** `https://ai.yueser.com/mcp`
- **Auth:** none (public, read-only data)
- **Health check:** `https://ai.yueser.com/health`

## Cline

Add this to `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "yueser": {
      "type": "streamableHttp",
      "url": "https://ai.yueser.com/mcp"
    }
  }
}
```

The `"type": "streamableHttp"` field is required — without it Cline treats the entry as a stdio server and the connection fails.

## Verify the install

After saving the config, ask the agent:

> Use yueser to search MCP servers for "gitlab"

A working install returns a list of matching servers. If it fails, check that the client can reach `https://ai.yueser.com/health` (should return JSON with `"status":"ok"`).

## What the server exposes

| Tool | Purpose |
|---|---|
| `search_mcp_servers` | Search 756 MCP servers by keyword, category or declared permission |
| `get_mcp_server` | Full profile of one server: exposed tools and parameters, permissions, version, license, probe date |
| `get_config` | Generate a paste-ready client config with env placeholders and credential instructions |
| `search_tools` | Search Qiku's browser-local utility tools |
| `list_categories` | List categories with server counts |

## Notes

- All data is public and read-only; nothing you send is stored.
- Permission labels come from each service's own declarations — the server states facts and draws no security conclusion.
- Every result carries the data cutoff date, so stale probe data is visible rather than hidden.

More detail: <https://yueser.com/agent/>
