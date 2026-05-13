# Sera ↔ NanoClaw integration

[NanoClaw](https://github.com/nanocoai/nanoclaw) is a lightweight agent runtime that orchestrates per-session agents inside Docker containers. It uses Claude as the primary model via the Claude Agent SDK and supports MCP via a `.mcp.json` file.

## Setup

1. **Build the Sera MCP** (one-time):

   ```bash
   git clone https://github.com/Josh-sera/sera-mcp
   cd sera-mcp && npm install && npm run build
   ```

2. **Add Sera to your NanoClaw `.mcp.json`** (in the NanoClaw workspace root):

   ```json
   {
     "mcpServers": {
       "sera": {
         "command": "node",
         "args": ["/absolute/path/to/sera-mcp/dist/index.js"],
         "env": {
           "SERA_NETWORK": "mainnet",
           "POLICY_PRESET": "standard"
         }
       }
     }
   }
   ```

   See `.mcp.example.json` in this folder for a copy-pasteable starting point.

3. **Restart your NanoClaw agent.** Sera tools surface as `sera.*` for any session that calls them.

## Container considerations

NanoClaw runs each agent session inside its own Docker container for isolation. Two implications for the Sera MCP:

- **Path mounting**: the MCP lives on the host filesystem; the container needs to be able to spawn `node` and access the `dist/index.js` path. NanoClaw handles this via its standard Docker volume mounts; if you've heavily customized your container setup, mount the path explicitly.

- **Network access**: the container needs outbound HTTPS to `api.sera.cx` (and to Frankfurter / open.er-api / exchangerate.host if you use the multi-source FX tools). NanoClaw's default container has internet enabled; restricted setups may need an allowlist update.

## API key handling

If you enable Sera's auth-gated tools (treasury, balances, settlement_status), the API key + secret need to be available *inside* the container. Two options:

- **Per-session env**: pass `SERA_API_KEY` + `SERA_API_SECRET` through the NanoClaw session-spawn config.
- **Container .env file**: bake them into the container image (not recommended for shared images — secrets baked in).

## Verify

Inside any NanoClaw agent session:

```
Call sera.doctor
```

Should return `overall_ok: true` with all six checks green.
