# mcp-tenant-lib

Generic tenant/session bookkeeping + MCP wiring, reusable across MCP servers that need to
track multiple browser-connected clients ("tenants") over HTTP + WebSocket.

## Usage

```ts
import { getOrCreateTenant, tenants, startIdleSweep, createHttpServer, attachWebSocketServer } from 'mcp-tenant-lib';
```

Browser-side helpers (types + WebSocket bridge) are available from the `client` subpath:

```ts
import type { ServerMessage, ClientMessage } from 'mcp-tenant-lib/client';
```
