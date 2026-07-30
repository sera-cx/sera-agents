# Template: slack-agent

A Slack bot assistant powered by the OpenAI Agents SDK and connected to the Sera MCP. Supports dynamic dual-transport setup (Socket Mode for low-friction local development and worker deployments, and HTTP Events API for traditional webhook architectures).

## Run

### 1. Setup Slack App
1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** (select **From scratch**).
2. Go to **OAuth & Permissions** and add the following **Bot Token Scopes**:
   - `app_mentions:read`
   - `channels:history`
   - `chat:write`
   - `im:history`
   - `im:read`
   - `groups:history`
3. Go to **Socket Mode** and toggle **Enable Socket Mode** to `On`. Generate an **App-Level Token** with the `connections:write` scope (copy this token; it starts with `xapp-`).
4. Go to **Event Subscriptions**:
   - Toggle **Enable Events** to `On`.
   - Under **Subscribe to bot events**, add `app_mention` and `message.im`.
5. Go to **Install App** and click **Install to Workspace** (copy the **Bot User OAuth Token**; it starts with `xoxb-`).

### 2. Run Locally (Socket Mode)

```bash
npm install
export OPENAI_API_KEY=sk-...
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...
export SLACK_SOCKET_MODE=true

npm start
```

Your bot is now connected to Slack and listening for messages. You can mention it in a channel (`@MyBot hello`) or send it a direct message!

### 3. Run in Production (HTTP Events API)

For serverless hosts or environments where WebSockets are not preferred, turn off Socket Mode:

```bash
export SLACK_SOCKET_MODE=false
export SLACK_SIGNING_SECRET=your-slack-signing-secret
export PORT=3000

npm start
```

Point your Slack App's Request URL in the developer portal to `https://your-domain.com/slack/events`.

## Built-in Safety

- **Boot verification**: Crashes immediately on startup if required credentials for the active mode are missing.
- **Request verification**: In HTTP mode, Bolt verifies signatures using `SLACK_SIGNING_SECRET` to prevent request spoofing.
- **Replay mitigation**: Rejects events older than 5 minutes.
- **Concurrency slots**: Caps active agent runs to a bounded concurrency pool (default: `4`) to prevent LLM rate limits and runaway API billing.
- **Background isolation**: Defers long agent tasks to execute asynchronously in the background. Bolt acknowledges message reception to Slack immediately (within 3 seconds), avoiding retries and event loops.
- **Subprocess reaping**: Registers process listener hooks to guarantee the spawned `sera-mcp` child process is terminated when the node server crashes or exits.

## What's in the box

- `server.ts` — The entrypoint containing Slack Bolt configurations, dynamic transport receivers, message history reconstruction, and OpenAI agent integration.

## Limitations

This starter template is designed to be lightweight and educational. It contains the following design constraints:
- **Stateless memory**: Retains conversation history by calling Slack's `conversations.replies` API on demand. No external database or persistent caching layers are utilized.
- **History cap**: Fetched history is limited to the last 20 messages to control token limits and avoid API rate limits.
- **No response streaming**: Responses are returned in full after the agent execution completes (streaming is omitted because repeated message updates can quickly trigger Slack's strict rate limits).
- **No slash commands or interactive blocks**: The app operates entirely through channel mentions and direct messages (IMs).

## Customize

- **Agent instructions** — Customize the `SYSTEM_PROMPT` in `server.ts` to change instructions or tone.
- **Command patterns** — Extend Bolt listeners to support slash commands (`app.command()`) or custom message parsing.
- **Signer and tools** — Swap `sera-mcp` signer settings or add non-Sera MCP servers by extending the `mcpServers` array.
