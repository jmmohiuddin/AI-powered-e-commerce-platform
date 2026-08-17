#!/usr/bin/env node
/**
 * MCP server exposing the noon Partner API.
 *
 * This is the *operator* surface: an assistant answering "what did noon sell
 * today", "is this SKU actually live", "mark that order shipped". It is not
 * how the shop stays in sync — that is the sync engine in @voltix/noon/sync,
 * which runs in the worker and needs no assistant in the loop.
 *
 * The distinction matters because the failure modes differ. A missed tool call
 * here is a question that went unanswered. A missed sync is a listing selling
 * stock that does not exist.
 *
 *   npx tsx packages/noon-mcp/src/index.ts     # development
 *   node packages/noon-mcp/dist/index.js       # after npm run build
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NoonClient, isProductionTarget, loadNoonConfig } from '@voltix/noon';
import { registerTools } from './tools.js';

async function main(): Promise<void> {
  const config = loadNoonConfig();
  const client = new NoonClient(config);

  const server = new McpServer({ name: 'noon-partner-api', version: '0.2.0' });
  registerTools(server, client);

  // stdout carries the MCP protocol; anything logged there corrupts the stream.
  await server.connect(new StdioServerTransport());

  process.stderr.write(
    `[noon-mcp] ready — project ${config.credentials.projectCode} at ${config.baseUrl}` +
      `${isProductionTarget(config) ? ' (PRODUCTION — writes affect live listings)' : ' (sandbox)'}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[noon-mcp] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
