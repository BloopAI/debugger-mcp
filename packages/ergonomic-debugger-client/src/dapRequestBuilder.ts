import { DebugProtocol } from '@vscode/debugprotocol';
import { DAPSessionHandler, SessionStatus } from './dapSessionHandler';
import { IDAPProtocolClient } from './dapProtocolClient';
import { LoggerInterface } from './logging';
import { CancellationToken, CancellationError } from './common/cancellation';

export interface DAPRequestBuilderOptions {
  successStateUpdate?: SessionStatus;
  isTerminatingFailure?: boolean;
  failureReasonPrefix?: string;
  allowedStates?: SessionStatus[];
}

export class DAPRequestBuilder<TResponse extends DebugProtocol.Response> {
  private _command?: string;
  private _args?: unknown;
  private _allowedStates?: SessionStatus[];
  private _cancellationToken?: CancellationToken;
  private _callerOptions: DAPRequestBuilderOptions = {};

  private readonly sessionHandler: DAPSessionHandler;
  private readonly protocolClient: IDAPProtocolClient;
  private readonly logger: LoggerInterface;

  constructor(
    sessionHandler: DAPSessionHandler,
    protocolClient: IDAPProtocolClient,
    logger: LoggerInterface,
  ) {
    this.sessionHandler = sessionHandler;
    this.protocolClient = protocolClient;
    this.logger = logger;
  }

  public command(command: string): this {
    this._command = command;
    return this;
  }

  public args(args: unknown): this {
    this._args = args;
    return this;
  }

  public allowedStates(states: SessionStatus[]): this {
    this._allowedStates = states;
    return this;
  }

  /**
   * Stores options for the caller to use when handling the response.
   * The send() method itself will not use these to modify session state directly.
   */
  public callerOptions(options: DAPRequestBuilderOptions): this {
    this._callerOptions = { ...this._callerOptions, ...options };
    return this;
  }

  /**
   * Gets the configured caller options. Useful for the DAPSessionHandler method
   * to retrieve how it configured the builder for handling the response.
   */
  public getCallerOptions(): DAPRequestBuilderOptions {
    // Ensure failureReasonPrefix defaults to command if not set by caller
    return {
      ...this._callerOptions,
      failureReasonPrefix:
        this._callerOptions.failureReasonPrefix || this._command,
    };
  }

  public withCancellationToken(token: CancellationToken): this {
    this._cancellationToken = token;
    return this;
  }

  public async send(): Promise<TResponse> {
    if (!this._command) {
      this.logger.error(
        "[DAPRequestBuilder] 'command' not set before calling send().",
      );
      throw new Error('DAPRequestBuilder: command is required.');
    }
    if (!this._allowedStates || this._allowedStates.length === 0) {
      this.logger.error(
        `[DAPRequestBuilder] 'allowedStates' not set for command '${this._command}' before calling send().`,
      );
      throw new Error(
        'DAPRequestBuilder: allowedStates are required for command ' +
          this._command,
      );
    }

    if (this._cancellationToken?.isCancellationRequested) {
      this.logger.warn(
        `[DAPRequestBuilder] Request "${this._command}" was cancelled before sending.`,
      );
      throw new CancellationError(`Request "${this._command}" was cancelled.`);
    }

    const command = this._command!;
    const args = this._args;
    const allowedStates = this._allowedStates!;

    this.logger.info(
      `[DAPSessionHandler] Attempting to send "${command}" request via builder`,
      args,
    );

    if (!allowedStates.includes(this.sessionHandler.status)) {
      const errorMsg = `[DAPSessionHandler] "${command}" called in invalid state: ${this.sessionHandler.status}. Expected one of: ${allowedStates.join(', ')}.`;
      this.logger.error(errorMsg);
      const err = new Error(errorMsg);
      this.sessionHandler.emit('error', {
        sessionId: this.sessionHandler.sessionId,
        error: err,
      });
      throw err;
    }

    try {
      const response = await this.protocolClient.sendRequest<TResponse>(
        command,
        args,
      );

      // Log success or DAP failure
      if (response.success) {
        this.logger.info(
          `[DAPSessionHandler] "${command}" DAP request successful.`,
          response.body,
        );
      } else {
        const dapErrorMessage =
          response.message || 'No error message provided by adapter.';
        const errorMsg = `[DAPSessionHandler] "${command}" DAP request failed: ${dapErrorMessage}`;
        this.logger.error(errorMsg, response);
        this.sessionHandler.emit('error', {
          sessionId: this.sessionHandler.sessionId,
          error: new Error(dapErrorMessage),
        });
      }
      return response; // Return the raw response
    } catch (error: unknown) {
      // Handle network/protocol level errors
      // The calling method in DAPSessionHandler will use its own getErrorMessage.
      this.logger.error(
        `[DAPSessionHandler] Network/protocol error during "${command}" request: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );

      const err = error instanceof Error ? error : new Error(String(error));
      this.sessionHandler.emit('error', {
        sessionId: this.sessionHandler.sessionId,
        error: err,
      });
      throw err; // Re-throw to be caught by the caller in DAPSessionHandler
    }
  }
}
