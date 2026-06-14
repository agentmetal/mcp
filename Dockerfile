# AgentMetal MCP server (stdio transport). Node 24 runs the TypeScript entrypoint
# natively (type stripping), so there's no build step. Glama uses this image to start
# the server and confirm it answers MCP introspection (tools/list) over stdio.
FROM node:24-slim

WORKDIR /app

# Install runtime deps only (no devDeps; nothing to compile).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Server sources + metadata.
COPY src ./src
COPY README.md LICENSE ./

# stdout is the JSON-RPC channel; stderr carries logs. No env is required to start —
# paid tools simply error clearly until WALLET_PRIVATE_KEY is provided, so introspection
# (tools/list) works out of the box.
ENTRYPOINT ["node", "src/index.ts"]
