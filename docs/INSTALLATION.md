# Installation

## Requirements

- Node.js **22.13 or newer**. Check with `node --version`.
- No database, Redis or other service is needed.

## Option 1: npm, from the release tarball (recommended)

```sh
npm install -g https://github.com/devlomingo/toolsmith-mcp/releases/download/v0.1.0/toolsmith-mcp-0.1.0.tgz
toolsmith-mcp --version
```

The tarball is attached to each [GitHub release](https://github.com/devlomingo/toolsmith-mcp/releases)
and contains the built package, so nothing is compiled on your machine. For
a newer release, use that release's tarball URL.

> The package is not on the npm registry yet, so `npx toolsmith-mcp` does
> not work. Installing straight from git (`npm install -g github:…`) does
> not work either, because npm cannot build a TypeScript package during a
> global git install. Use the tarball.

## Option 2: Docker

```sh
git clone https://github.com/devlomingo/toolsmith-mcp && cd toolsmith-mcp
docker build -t toolsmith-mcp .
mkdir ~/toolsmith && cd ~/toolsmith
docker run --rm -v "$PWD:/work" toolsmith-mcp init
docker run -d --name toolsmith -p 127.0.0.1:7420:7420 -v "$PWD:/work" --env-file .env toolsmith-mcp
```

Inside the container the gateway binds `0.0.0.0`. It refuses to start
without `server.mcpToken`, which `init` generates. Publish the port on
`127.0.0.1` unless you mean to expose it.

There is also `compose.yaml`: run `docker compose run --rm toolsmith init`,
then `docker compose up -d`.

## Option 3: from source

```sh
git clone https://github.com/devlomingo/toolsmith-mcp && cd toolsmith-mcp
npm ci && npm run build
node dist/cli/index.js demo
```

## First run

```sh
toolsmith-mcp demo
```

The demo starts a bundled demo shop API, then:

1. imports its spec;
2. approves it read-only;
3. simulates an agent;
4. discovers a workflow and proposes a composite tool;
5. evaluates and publishes the composite;
6. starts the gateway with the dashboard.

Nothing is written outside a temporary directory.

Then set up your own:

```sh
mkdir my-tools && cd my-tools
toolsmith-mcp init      # writes toolsmith.config.json and .env (with fresh tokens)
toolsmith-mcp import https://petstore3.swagger.io/api/v3/openapi.json --name petstore
toolsmith-mcp approve petstore
toolsmith-mcp start
```

Next: [connect a client](MCP-INTEGRATION.md).
