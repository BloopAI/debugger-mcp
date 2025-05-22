#!/usr/bin/env node
import { InteractiveDebuggerMcpServer } from '../src/index';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * This is a dedicated server script for running the InteractiveDebuggerMcpServer
 * in STDIN/STDOUT mode, specifically for integration testing.
 * It bypasses the HTTP transport complexities.
 */
async function main() {
  let mcpServerInstance: InteractiveDebuggerMcpServer | null = null;

  console.error(
    '[INFO] STDIO Test Server: InteractiveDebuggerMcpServer will attempt to load default and CLI-specified adapter configs.',
  );

  try {
    mcpServerInstance = new InteractiveDebuggerMcpServer();
    const sdkServer = mcpServerInstance.getServerInstance();
    const logger = mcpServerInstance.getLogger();
    logger.info('STDIO Test Server: Initialized InteractiveDebuggerMcpServer.');

    const transport = new StdioServerTransport();

    await sdkServer.connect(transport);
    logger.info(
      'STDIO Test Server: InteractiveDebuggerMcpServer connected to StdioServerTransport.',
    );
    logger.info(
      'STDIO Test Server: Running and waiting for requests via STDIN/STDOUT.',
    );
  } catch (error) {
    console.error(
      '[CRITICAL] STDIO Test Server: Failed to start or connect server:',
      error,
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(
    '[CRITICAL] STDIO Test Server: Unhandled error in main:',
    error,
  );
  process.exit(1);
});
