# Obsidian MCP Tools

A couple of tools to enable remote https access to an Obsidian MCP server.

## obsidian-mcp-bridge

A thin Node.js HTTP bridge that makes [`obsidian-mcp`](https://github.com/StevenStavrakis/obsidian-mcp)
accessible to remote MCP clients such as Claude Code and Claude Desktop.

## Why this bridge is needed

`obsidian-mcp` is a stdio-only MCP server — it reads and writes newline-delimited
JSON-RPC over standard input/output. That works fine for local clients that can
spawn a child process, but breaks down in two ways when you want to connect remotely:

### No HTTP transport

Remote MCP clients (Claude Code 2.x, Claude Desktop) connect over HTTP, not stdio.
The standard solution is [`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy),
which wraps a stdio server and exposes it over HTTP. However, mcp-proxy has a
session-management bug: when Claude Code opens its GET `/mcp` notification stream
at the same time as sending tool-list requests (which it always does), mcp-proxy's
response routing gets confused and `tools/list` silently times out. This bridge
owns the HTTP transport layer directly, which eliminates that class of bug.

### No OAuth 2.0 discovery\*\*

The [MCP 2025-03-26 spec](https://spec.modelcontextprotocol.io) requires every
non-localhost remote MCP server to expose OAuth 2.0 discovery endpoints
(`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`,
`/authorize`, `/token`, `/register`). `obsidian-mcp` has none of these, and neither
does `mcp-proxy`. Without them, Claude Code refuses to connect. This bridge serves
a public (no credentials required) OAuth flow so that Claude Code's auth handshake
completes without needing real credentials.

### What this bridge does

```text
Claude Code / Claude Desktop
        │  HTTPS (e.g. Tailscale)
        ▼
obsidian-mcp-bridge  :3002
  ├─ OAuth 2.0 discovery endpoints
  ├─ MCP Streamable HTTP transport (POST /mcp, GET /mcp)
  ├─ Path deny list (access control)
  └─ spawns obsidian-mcp over stdio
        │
        ▼
obsidian-mcp (child process, stdio)
        │
        ▼
Obsidian vault (filesystem)
```

---

### Prerequisites

- Node.js 18+
- [`obsidian-mcp`](https://www.npmjs.com/package/obsidian-mcp) installed (or
  accessible via `npx`)
- A way to expose the bridge over HTTPS to your remote client —
  [Tailscale Serve](https://tailscale.com/kb/1312/serve) is what I use, but any
  HTTPS reverse proxy works

---

### Installation

Install dependencies and build the packages:

```bash
npm install
```

The `obsidian-mcp-bridge` package can then be run directly from the workspace, or you can copy the built files to wherever you want to run them from. Then set it up as a persistent service.

### systemd (Linux)

Create `~/.config/systemd/user/obsidian-mcp.service`:

```ini
[Unit]
Description=Obsidian MCP Bridge
After=network.target

[Service]
ExecStart=node /path/to/obsidian-mcp-bridge/obsidian-mcp-bridge/obsidian-mcp-bridge.mjs
Environment=LISTEN_PORT=3002
Environment=MCP_BASE_URL=https://your-hostname:4001
Environment=VAULT=/path/to/your/obsidian/vault
Environment=DENY_PATHS=
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Then enable and start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now obsidian-mcp.service
```

### macOS (launchd)

Create `~/Library/LaunchAgents/com.obsidian-mcp-bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.obsidian-mcp-bridge</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/obsidian-mcp-bridge/obsidian-mcp-bridge/obsidian-mcp-bridge.mjs</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>LISTEN_PORT</key>
    <string>3002</string>
    <key>MCP_BASE_URL</key>
    <string>https://your-hostname:4001</string>
    <key>VAULT</key>
    <string>/path/to/your/obsidian/vault</string>
    <key>CHILD_BIN</key>
    <string>/usr/local/bin/obsidian-mcp</string>
    <key>DENY_PATHS</key>
    <string></string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/tmp/obsidian-mcp-bridge.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/obsidian-mcp-bridge.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.obsidian-mcp-bridge.plist
```

To restart after a config change:

```bash
launchctl unload ~/Library/LaunchAgents/com.obsidian-mcp-bridge.plist
launchctl load   ~/Library/LaunchAgents/com.obsidian-mcp-bridge.plist
```

### Tailscale Serve (HTTPS tunnel)

Point Tailscale at the bridge's local port:

```bash
sudo tailscale serve --bg --https 4001 http://localhost:3002
```

This exposes the bridge at `https://<your-tailscale-hostname>:4001`.

---

## Connecting Claude Code

Add the server to your Claude Code config (`~/.claude.json` or via `claude mcp add`):

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "http",
      "url": "https://your-hostname:4001/mcp"
    }
  }
}
```

Claude Code will prompt you to authenticate the first time — click through the
OAuth flow (it uses a public/no-credentials token, so no real account is needed).

---

## Configuration

All configuration is via environment variables.

| Variable       | Default   | Description                                                                           |
| -------------- | --------- | ------------------------------------------------------------------------------------- |
| `LISTEN_PORT`  | `3002`    | Local port the bridge listens on                                                      |
| `MCP_BASE_URL` | —         | Public HTTPS base URL of the bridge (used in OAuth responses and SSE endpoint events) |
| `VAULT`        | —         | Absolute path to the Obsidian vault directory. **Required.**                          |
| `CHILD_BIN`    | —         | Path to the `obsidian-mcp` binary. **Required.** See note below.                      |
| `DENY_PATHS`   | _(empty)_ | Comma-separated vault-relative paths to block. See below.                             |

### `CHILD_BIN` and keeping it stable

The default value of `CHILD_BIN` is whatever path `npx` cached `obsidian-mcp` to
the first time it ran. That path contains a content hash that changes every time
the package is updated, so after an `npx`-triggered update the default will point
at a stale binary.

The simplest fix is to install `obsidian-mcp` globally and point `CHILD_BIN` at
the global binary:

```bash
npm install -g obsidian-mcp
```

Then set in your service config:

```ini
Environment=CHILD_BIN=/usr/local/bin/obsidian-mcp
# or wherever `which obsidian-mcp` reports
```

Updates then just require `npm update -g obsidian-mcp` followed by a service
restart, with no path changes needed.

### Path deny list (`DENY_PATHS`)

`DENY_PATHS` lets you prevent the MCP client from reading or writing specific
folders in your vault. Paths are relative to the vault root and prefix-matched,
so denying `people` blocks `people/`, `people/alice/notes.md`, and so on.

```ini
# Block a single folder
Environment=DENY_PATHS=private

# Block multiple folders
Environment=DENY_PATHS=private,people,journal/personal
```

The deny list is enforced in the bridge before any request reaches `obsidian-mcp`.
Blocked requests receive a structured MCP error (`isError: true`) rather than a
transport-level failure, so the client can report the reason clearly.

Affected tools: `read-note`, `create-note`, `edit-note`, `delete-note`, `move-note`
(source and destination), `add-tags`, `remove-tags`, `create-directory`, `search-vault`
(when a `path` scope is given).

Tools that operate vault-wide without a path argument (`list-available-vaults`,
`rename-tag`) are not affected.

---

## How the obsidian-mcp-bridge works

The bridge implements the [MCP Streamable HTTP transport (2024-11-05)](https://spec.modelcontextprotocol.io/specification/2024-11-05/basic/transports/#streamable-http):

- **`POST /mcp`** — receives JSON-RPC requests from the client. `initialize` creates
  a session and returns capabilities from the child process. Notifications return
  202 code. All other requests are forwarded to the `obsidian-mcp` child over stdin
  and the response is returned as an inline SSE event.

- **`GET /mcp`** — keeps a long-lived SSE stream open per session for server-to-client
  notifications (e.g. `tools/list_changed`).

The child process is initialised once at startup and shared across all HTTP sessions.
Request IDs are remapped to UUIDs before being forwarded so that concurrent requests
from multiple sessions don't collide. If the child hangs (15 s timeout), it is killed
and restarted automatically.

`resources/list` and `prompts/list` are short-circuited to return empty results
immediately — `obsidian-mcp` scans the entire vault to build the resource list,
which on large vaults can take long enough to block the shared stdio pipe and cause
all subsequent requests to time out.

---

## Security

The OAuth flow is intentionally public — there are no real credentials. Access control
relies on the network layer (Tailscale node authentication in the reference setup).
The `DENY_PATHS` feature provides coarse-grained control over which parts of the
vault the MCP client can touch, but it is not a substitute for network-level access
control.

## mcp-shim

A lightweight shim that connects Claude Desktop to a remote MCP server over HTTPS
(Streamable HTTP transport). It bridges Claude Desktop's stdio JSON-RPC protocol to
the remote server's HTTP+SSE interface.

### Requirements

Node.js 18 or later (no npm install needed — no dependencies).

### Configuration for Claude Desktop

Edit `claude_desktop_config.json` (find it via **Claude Desktop → Settings →
Developer → Edit Config**) and add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-shim.mjs"],
      "env": {
        "MCP_URL": "https://my-server.example.com/mcp"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

### Environment Variables

| Variable      | Required | Default | Description                                                                                               |
| ------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `MCP_URL`     | Yes      | -       | Full URL of the remote MCP endpoint. Can also be passed as a positional argument: `node mcp-shim.mjs URL` |
| `MCP_TOKEN`   | No       | -       | Bearer token added to every request as `Authorization: Bearer TOKEN`                                      |
| `MCP_TIMEOUT` | No       | `60000` | Request timeout in milliseconds (POST and DELETE only — the SSE stream has no timeout)                    |

### Examples

#### Server with no auth

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/Users/alice/obsidian-mcp-bridge/mcp-shim/mcp-shim.mjs"],
      "env": {
        "MCP_URL": "https://obsidian-mcp.example.com/mcp"
      }
    }
  }
}
```

#### Server with a bearer token

```json
{
  "mcpServers": {
    "my-api": {
      "command": "node",
      "args": ["/Users/alice/obsidian-mcp-bridge/mcp-shim/mcp-shim.mjs"],
      "env": {
        "MCP_URL": "https://api.example.com/mcp",
        "MCP_TOKEN": "sk-..."
      }
    }
  }
}
```

#### Custom timeout

```json
{
  "mcpServers": {
    "slow-server": {
      "command": "node",
      "args": ["/Users/alice/obsidian-mcp-bridge/mcp-shim/mcp-shim.mjs"],
      "env": {
        "MCP_URL": "https://slow.example.com/mcp",
        "MCP_TIMEOUT": "30000"
      }
    }
  }
}
```

### How the mcp-shim works

1. Claude Desktop launches the shim as a subprocess and communicates over stdio.
2. The shim forwards each JSON-RPC message from Claude Desktop as an HTTPS POST
   to `MCP_URL`.
3. On the first response, it opens a persistent SSE GET stream on the same URL to
   receive server-initiated messages.
4. The SSE stream reconnects automatically with exponential backoff if it drops.
5. When Claude Desktop exits, the shim sends an HTTP DELETE to cleanly end the session.
