import { EventEmitter } from 'events';
import { DebugProtocol } from '@vscode/debugprotocol';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import { IDAPProtocolClient } from '../src/dapProtocolClient';
import { LoggerInterface } from '../src/logging';

/**
 * Adapter class that wraps DebugClient from @vscode/debugadapter-testsupport
 * and implements the DAPProtocolClient interface expected by our DAPSessionHandler.
 */
export class DebugClientAdapter
  extends EventEmitter
  implements IDAPProtocolClient
{
  private connected: boolean = false;

  constructor(
    private readonly debugClient: DebugClient,
    private readonly logger: LoggerInterface,
  ) {
    super();

    // Forward events from debugClient to this adapter
    this.debugClient.on('output', (event) => this.emit('output', event));
    this.debugClient.on('stopped', (event) => this.emit('stopped', event));
    this.debugClient.on('continued', (event) => this.emit('continued', event));
    this.debugClient.on('thread', (event) => this.emit('thread', event));
    this.debugClient.on('terminated', (event) =>
      this.emit('terminated', event),
    );
    this.debugClient.on('exited', (event) => this.emit('exited', event));
    this.debugClient.on('initialized', (event) =>
      this.emit('initialized', event),
    );
    this.debugClient.on('breakpoint', (event) =>
      this.emit('breakpoint', event),
    );
    this.debugClient.on('module', (event) => this.emit('module', event));
    this.debugClient.on('loadedSource', (event) =>
      this.emit('loadedSource', event),
    );
    this.debugClient.on('process', (event) => this.emit('process', event));
    this.debugClient.on('capabilities', (event) =>
      this.emit('capabilities', event),
    );
    this.debugClient.on('invalidated', (event) =>
      this.emit('invalidated', event),
    );
    this.debugClient.on('memory', (event) => this.emit('memory', event));
    this.debugClient.on('progressStart', (event) =>
      this.emit('progressStart', event),
    );
    this.debugClient.on('progressUpdate', (event) =>
      this.emit('progressUpdate', event),
    );
    this.debugClient.on('progressEnd', (event) =>
      this.emit('progressEnd', event),
    );

    // Forward error events
    this.debugClient.on('error', (error) => {
      this.logger.error('DebugClient error:', error);
      this.emit('error', error);
    });

    // Forward close events
    this.debugClient.on('close', () => {
      this.logger.info('DebugClient closed');
      this.connected = false;
      this.emit('close');
    });

    this.connected = true;
  }

  /**
   * Implements the sendRequest method required by IDAPProtocolClient interface
   * by delegating to the DebugClient's send method.
   */
  public async sendRequest<R extends DebugProtocol.Response>(
    command: string,
    args?: unknown,
    _timeoutMs?: number,
  ): Promise<R> {
    this.logger.debug(`Sending command: ${command}`, args);
    try {
      const response = await this.debugClient.send(command, args);
      return response as R;
    } catch (error) {
      this.logger.error(`Error sending command ${command}:`, error);
      throw error;
    }
  }

  /**
   * Connect method required by DAPProtocolClient interface.
   * Not needed for DebugClient which handles its own connection.
   */
  public connect(): void {
    // DebugClient handles its own connection in start()
    this.connected = true;
    this.emit('connected');
  }

  /**
   * Dispose method required by DAPProtocolClient interface.
   * Delegates to DebugClient.stop()
   */
  public dispose(): void {
    this.logger.info('Disposing DebugClientAdapter');
    this.connected = false;
    // We don't await this because dispose() is synchronous
    this.debugClient.stop().catch((err) => {
      this.logger.error('Error stopping debug client:', err);
    });
    this.removeAllListeners();
  }

  /**
   * isConnected method required by DAPProtocolClient interface.
   */
  public isConnected(): boolean {
    return this.connected;
  }
}
