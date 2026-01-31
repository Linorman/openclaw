---
summary: "QQ messaging support via NapCatQQ - setup, configuration, and usage"
read_when:
  - Setting up QQ integration
  - Configuring NapCatQQ connection
---

# QQ (via NapCatQQ)

Status: production-ready for private chats and groups via NapCatQQ WebSocket API.

## Quick setup (beginner)

1) Install and configure NapCatQQ following the [NapCatQQ documentation](https://napneko.github.io/guide/start-install).
2) Note the HTTP API endpoint (default: `http://localhost:3000`) and WebSocket endpoint (default: `ws://localhost:3001`).
3) Configure OpenClaw:
   - Set `channels.qq.httpUrl` and `channels.qq.wsUrl`.
   - Optionally set `channels.qq.accessToken` if NapCatQQ requires authentication.
4) Start the gateway.
5) DM access is pairing by default; approve the pairing code on first contact.

Minimal config:
```json5
{
  channels: {
    qq: {
      enabled: true,
      httpUrl: "http://localhost:3000",
      wsUrl: "ws://localhost:3001",
      dmPolicy: "pairing"
    }
  }
}
```

## What it is

A QQ channel that connects to NapCatQQ (OneBot 11 compatible QQ bot framework).
- Deterministic routing: replies go back to QQ; the model never chooses channels.
- DMs share the agent's main session; groups stay isolated (`agent:<agentId>:qq:group:<groupId>`).

## Setup

### 1) Install NapCatQQ

Follow the [NapCatQQ installation guide](https://napneko.github.io/guide/start-install) to set up NapCatQQ with your QQ account.

Key points:
- NapCatQQ acts as a bridge between QQ and OpenClaw.
- It provides HTTP API and WebSocket for receiving and sending messages.
- Default ports: HTTP on 3000, WebSocket on 3001.

### 2) Configure OpenClaw

Example configuration:

```json5
{
  channels: {
    qq: {
      enabled: true,
      httpUrl: "http://localhost:3000",
      wsUrl: "ws://localhost:3001",
      accessToken: "your-token-if-required",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom: [],
      groupAllowFrom: []
    }
  }
}
```

Multi-account support: use `channels.qq.accounts` with per-account configuration:

```json5
{
  channels: {
    qq: {
      accounts: {
        main: {
          enabled: true,
          httpUrl: "http://localhost:3000",
          wsUrl: "ws://localhost:3001",
          name: "Main QQ"
        },
        secondary: {
          enabled: true,
          httpUrl: "http://localhost:3002",
          wsUrl: "ws://localhost:3003",
          name: "Secondary QQ"
        }
      }
    }
  }
}
```

### 3) Start the gateway

QQ channel starts automatically when `httpUrl` is configured.

### 4) DM access

DM access defaults to pairing. When someone messages your QQ bot:
1. They receive a pairing code.
2. You approve the pairing code via CLI: `openclaw pairing approve qq <CODE>`.
3. Once approved, they can chat with the agent.

## How it works (behavior)

- Inbound messages are received via WebSocket from NapCatQQ.
- Outbound messages are sent via HTTP API to NapCatQQ.
- Group messages require mention by default (configurable per group).
- Replies always route back to the same QQ chat (private or group).
- WebSocket connection auto-reconnects on disconnect.

## Access control

### DM access

- Default: `channels.qq.dmPolicy = "pairing"`. Unknown senders receive a pairing code; messages are ignored until approved.
- Approve via:
  - `openclaw pairing list qq`
  - `openclaw pairing approve qq <CODE>`
- `channels.qq.allowFrom` accepts QQ numbers (recommended). Add "*" for open access (not recommended).

### Group access

Two independent controls:

**1. Which groups are allowed** (group allowlist via `channels.qq.groups`):
- No `groups` config = all groups allowed
- With `groups` config = only listed groups or `"*"` are allowed

**2. Which senders are allowed** (sender filtering via `channels.qq.groupPolicy`):
- `"open"` = all senders in allowed groups can message
- `"allowlist"` = only senders in `channels.qq.groupAllowFrom` can message
- `"disabled"` = no group messages accepted at all

Default is `groupPolicy: "allowlist"` (blocked unless you add `groupAllowFrom`).

### Group configuration

```json5
{
  channels: {
    qq: {
      groups: {
        "123456789": {
          requireMention: false,
          allowFrom: ["987654321"]
        },
        "*": {
          requireMention: true
        }
      }
    }
  }
}
```

## Message format

QQ messages support:
- Plain text
- Images (via URL)
- At mentions
- Reply references

Text is sent as-is to NapCatQQ (no special formatting required).

## Connection settings

- `httpUrl`: NapCatQQ HTTP API endpoint (required for sending messages).
- `wsUrl`: NapCatQQ WebSocket endpoint (required for receiving messages).
- `accessToken`: Authentication token if NapCatQQ is configured with access control.
- `connectionTimeoutMs`: Connection timeout in milliseconds (default: 30000).
- `reconnectIntervalMs`: WebSocket reconnect interval in milliseconds (default: 5000).

## Limits

- Outbound text is chunked to `channels.qq.textChunkLimit` (default 4000).
- Optional newline chunking: set `channels.qq.chunkMode="newline"` to split on blank lines.
- Group history context uses `channels.qq.historyLimit` (default 50). Set `0` to disable.
- DM history can be limited with `channels.qq.dmHistoryLimit`.

## Reply threading

QQ supports reply references:
- `[[reply_to_current]]` -- reply to the triggering message.
- `[[reply_to:<id>]]` -- reply to a specific message id.

Controlled by `channels.qq.replyToMode`:
- `first` (default), `all`, `off`.

## Delivery targets (CLI)

- Use a QQ number (`123456789`) for private messages.
- Use `group:<groupId>` (e.g., `group:123456789`) for group messages.
- Example: `openclaw message send --channel qq --target 123456789 --message "hi"`.

## Troubleshooting

**Bot doesn't respond:**
- Check NapCatQQ is running and accessible at the configured `httpUrl` and `wsUrl`.
- Check gateway logs: `openclaw logs --follow`.
- Verify `accessToken` if NapCatQQ requires authentication.

**WebSocket connection fails:**
- Ensure `wsUrl` points to the correct NapCatQQ WebSocket endpoint.
- Check firewall settings - port 3001 (or your configured port) must be accessible.
- Check NapCatQQ logs for connection errors.

**Cannot send messages:**
- Verify `httpUrl` is correct and NapCatQQ HTTP API is accessible.
- Check if `accessToken` is required and correctly configured.

**Bot not receiving messages:**
- Ensure WebSocket is connected (check gateway logs).
- NapCatQQ must be properly logged in to QQ.
- Check NapCatQQ configuration for event reporting.

## Configuration reference

Provider options:
- `channels.qq.enabled`: enable/disable channel startup.
- `channels.qq.httpUrl`: NapCatQQ HTTP API endpoint (default: `http://localhost:3000`).
- `channels.qq.wsUrl`: NapCatQQ WebSocket endpoint (default: `ws://localhost:3001`).
- `channels.qq.accessToken`: authentication token (optional).
- `channels.qq.tokenFile`: read token from file path (optional).
- `channels.qq.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing).
- `channels.qq.allowFrom`: DM allowlist (QQ numbers). `open` requires `"*"`.
- `channels.qq.groupPolicy`: `open | allowlist | disabled` (default: allowlist).
- `channels.qq.groupAllowFrom`: group sender allowlist (QQ numbers).
- `channels.qq.groups`: per-group configuration.
- `channels.qq.textChunkLimit`: outbound chunk size (default: 4000).
- `channels.qq.chunkMode`: `length` (default) or `newline`.
- `channels.qq.historyLimit`: group message history limit (default: 50).
- `channels.qq.dmHistoryLimit`: DM message history limit.
- `channels.qq.replyToMode`: `off | first | all` (default: `first`).
- `channels.qq.connectionTimeoutMs`: connection timeout (default: 30000).
- `channels.qq.reconnectIntervalMs`: reconnect interval (default: 5000).

Multi-account options:
- `channels.qq.accounts.<account>.enabled`
- `channels.qq.accounts.<account>.httpUrl`
- `channels.qq.accounts.<account>.wsUrl`
- `channels.qq.accounts.<account>.accessToken`
- `channels.qq.accounts.<account>.name`
- All other options from base config

Related global options:
- `agents.list[].groupChat.mentionPatterns` (mention gating patterns).
- `messages.groupChat.mentionPatterns` (global fallback).
