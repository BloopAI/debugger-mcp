import { EventEmitter } from 'events';
import * as stream from 'stream';
import { DebugProtocol } from '@vscode/debugprotocol';
import { LoggerInterface } from './logging';

const TWO_CRLF = '\r\n\r\n';

interface PendingRequest {
  resolve: (response: DebugProtocol.Response) => void;
  reject: (error: DAPRequestError | Error) => void;
  request: DebugProtocol.Request;
  timeoutTimer?: NodeJS.Timeout;
}

export class DAPRequestError extends Error {
  public body?: DebugProtocol.ErrorResponse['body'];
  public request?: DebugProtocol.Request;
  public response?: DebugProtocol.Response;

  constructor(
    message: string,
    request?: DebugProtocol.Request,
    response?: DebugProtocol.Response,
  ) {
    super(message);
    this.name = 'DAPRequestError';
    if (request) this.request = request;
    if (response) {
      this.response = response;
      if (response.body) this.body = response.body;
    }
  }
}

export interface IDAPProtocolClient extends EventEmitter {
  sendRequest<R extends DebugProtocol.Response>(
    command: string,
    args?: unknown,
    timeoutMs?: number,
  ): Promise<R>;
  connect(readable: stream.Readable, writable: stream.Writable): void;
  dispose(): void;
  isConnected(): boolean;
}

export class DAPProtocolClient
  extends EventEmitter
  implements IDAPProtocolClient
{
  private static readonly DEFAULT_TIMEOUT = 10000; // 10 seconds
  public static readonly MAX_CONTENT_LENGTH = 50 * 1024 * 1024; // 50 MB
  public static readonly MAX_BUFFER_SIZE = 60 * 1024 * 1024; // 60 MB

  private connected: boolean = false;
  private sequence: number = 1;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private buffer: Buffer = Buffer.alloc(0);
  private readableStream: stream.Readable | null = null;
  private writableStream: stream.Writable | null = null;
  private consecutiveParseFailures: number = 0;
  private static readonly MAX_CONSECUTIVE_PARSE_FAILURES = 10;

  constructor(private readonly logger: LoggerInterface) {
    super();
    if (logger.child) {
      this.logger = logger.child({ component: 'DAPProtocolClient' });
    }
    this.logger.info('DAPProtocolClient initialized');
  }

  public connect(readable: stream.Readable, writable: stream.Writable): void {
    if (this.connected) {
      this.logger.warn('Already connected. Ignoring connect call.');
      return;
    }

    if (!readable || !writable) {
      const errorMsg = 'Connect called with null readable or writable stream.';
      this.logger.error(errorMsg);
      this.emit('error', new Error(errorMsg));
      return;
    }

    this.logger.info('Connecting to DAP server...');
    this.readableStream = readable;
    this.writableStream = writable;

    this.readableStream.on('data', (data: Buffer) => {
      this.handleData(data);
    });

    this.readableStream.on('close', () => {
      this.logger.info('Readable stream closed.');
      this.handleDisconnect('Readable stream closed');
    });

    this.readableStream.on('error', (error: Error) => {
      this.logger.error({ err: error }, 'Readable stream error.');
      this.emit('error', error);
      this.handleDisconnect(`Readable stream error: ${error.message}`);
    });

    this.writableStream.on('close', () => {
      this.logger.info('Writable stream closed.');
    });

    this.writableStream.on('error', (error: Error) => {
      this.logger.error({ err: error }, 'Writable stream error.');
      this.emit('error', error);
      this.handleDisconnect(`Writable stream error: ${error.message}`);
    });

    this.connected = true;
    this.logger.info('Successfully connected to DAP server.');
    this.emit('connected');
  }

  private handleData(data: Buffer): void {
    this.logger.trace(
      `DAPProtocolClient.handleData ENTERED with new data length: ${data.length}. RAW DATA (UTF-8): >>>${data.toString('utf8')}<<<`,
    );
    this.buffer = Buffer.concat([this.buffer, data]);
    this.logger.trace(
      `Received data chunk, new buffer length: ${this.buffer.length}`,
    );

    if (this.buffer.length > DAPProtocolClient.MAX_BUFFER_SIZE) {
      this.logger.error(
        `Buffer size ${this.buffer.length} exceeds maximum ${DAPProtocolClient.MAX_BUFFER_SIZE}. Disconnecting.`,
      );
      this.emit('error', new Error(`Buffer size limit exceeded.`));
      this.handleDisconnect('Buffer size limit exceeded');
      return;
    }

    let loopCount = 0;
    while (this.connected) {
      loopCount++;
      this.logger.trace(
        `DAPProtocolClient.handleData: _processBufferOnce loop iteration: ${loopCount}, buffer length: ${this.buffer.length}`,
      );
      const processedSomething = this._processBufferOnce();
      if (!processedSomething) {
        this.logger.trace(
          `DAPProtocolClient.handleData: _processBufferOnce returned false, breaking loop. Iteration: ${loopCount}`,
        );
        break;
      }
      if (loopCount > 100) {
        this.logger.error(
          'DAPProtocolClient.handleData: _processBufferOnce loop iterated over 100 times. Breaking to prevent infinite loop.',
        );
        this.handleDisconnect('Internal processing loop limit exceeded');
        break;
      }
      this.logger.trace(
        `DAPProtocolClient.handleData: _processBufferOnce returned true, continuing loop. Iteration: ${loopCount}`,
      );
    }
    this.logger.trace(
      `DAPProtocolClient.handleData EXITED loop. Iterations: ${loopCount}`,
    );
  }

  /**
   * Tries to parse and handle a single DAP message from the buffer.
   * @returns True if a message was processed or if an error occurred that allows further processing,
   *          false if more data is needed or a fatal error that led to disconnect occurred.
   */
  private _processBufferOnce(): boolean {
    this.logger.trace(
      `DAPProtocolClient._processBufferOnce ENTERED. Buffer length: ${this.buffer.length}`,
    );
    const headerIndex = this.buffer.indexOf(TWO_CRLF);
    if (headerIndex === -1) {
      this.logger.trace(
        `Buffer does not contain full headers yet. Buffer content (first 100 bytes): ${this.buffer.toString('utf8', 0, 100)}`,
      );
      return false;
    }

    const headerString = this.buffer.toString('utf8', 0, headerIndex);
    const headers = this.parseHeaders(headerString);
    const contentLength = headers['Content-Length'];

    if (!contentLength) {
      this.logger.error('Missing Content-Length header.');
      this.emit('error', new Error('Missing Content-Length header'));
      this.buffer = this.buffer.subarray(headerIndex + TWO_CRLF.length); // Attempt to skip
      this.consecutiveParseFailures++;
      if (
        this.consecutiveParseFailures >
        DAPProtocolClient.MAX_CONSECUTIVE_PARSE_FAILURES
      ) {
        this.logger.error(
          'Too many consecutive parse failures (missing Content-Length). Disconnecting.',
        );
        this.handleDisconnect('Too many consecutive parse failures');
        return false;
      }
      return true;
    }

    const messageLength = parseInt(contentLength, 10);
    if (isNaN(messageLength) || messageLength < 0) {
      this.logger.error(`Invalid Content-Length: ${contentLength}`);
      this.emit('error', new Error(`Invalid Content-Length: ${contentLength}`));
      this.buffer = this.buffer.subarray(headerIndex + TWO_CRLF.length); // Attempt to skip
      this.consecutiveParseFailures++;
      if (
        this.consecutiveParseFailures >
        DAPProtocolClient.MAX_CONSECUTIVE_PARSE_FAILURES
      ) {
        this.logger.error(
          'Too many consecutive parse failures (invalid Content-Length). Disconnecting.',
        );
        this.handleDisconnect('Too many consecutive parse failures');
        return false;
      }
      return true;
    }

    if (messageLength > DAPProtocolClient.MAX_CONTENT_LENGTH) {
      this.logger.error(
        `Content-Length ${messageLength} exceeds maximum ${DAPProtocolClient.MAX_CONTENT_LENGTH}. Disconnecting.`,
      );
      this.emit('error', new Error(`Content-Length limit exceeded.`));
      this.handleDisconnect('Content-Length limit exceeded');
      return false;
    }

    const messageStartIndex = headerIndex + TWO_CRLF.length;
    if (this.buffer.length < messageStartIndex + messageLength) {
      this.logger.trace(
        `Buffer does not contain full message body yet. Need ${messageLength}, have ${this.buffer.length - messageStartIndex}`,
      );
      return false;
    }

    const messageBuffer = this.buffer.subarray(
      messageStartIndex,
      messageStartIndex + messageLength,
    );
    this.buffer = this.buffer.subarray(messageStartIndex + messageLength);

    try {
      const messageString = messageBuffer.toString('utf8');
      const message: DebugProtocol.ProtocolMessage = JSON.parse(messageString);
      this.logger.debug({ dapMessage: message }, 'Received DAP message');
      this.handleMessage(message);
      this.consecutiveParseFailures = 0;
    } catch (e) {
      let errMsg = 'Unknown error parsing DAP message JSON.';
      if (e instanceof Error) {
        errMsg = e.message;
      }
      this.logger.error(
        { error: e, rawMessage: messageBuffer.toString('utf8') },
        `Error parsing DAP message JSON: ${errMsg}`,
      );
      this.emit(
        'error',
        new Error(`Error parsing DAP message JSON: ${errMsg}`),
      );
    }
    return true;
  }

  private parseHeaders(headerString: string): Record<string, string> {
    const headers: Record<string, string> = {};
    const lines = headerString.split('\r\n');
    for (const line of lines) {
      const [name, value] = line.split(': ');
      if (name && value) {
        headers[name] = value;
      }
    }
    return headers;
  }

  private handleMessage(message: DebugProtocol.ProtocolMessage): void {
    this.logger.trace(
      { dapMessage: message },
      `DAPProtocolClient.handleMessage ENTERED for type: ${message?.type}, event: ${(message as DebugProtocol.Event)?.event}`,
    );
    if (!message || typeof message.type !== 'string') {
      this.logger.error(
        { dapMessage: message },
        'Received malformed DAP message: missing or invalid type.',
      );
      this.emit(
        'error',
        new Error('Received malformed DAP message: missing or invalid type.'),
      );
      return;
    }

    if (message.type === 'response') {
      const response = message as DebugProtocol.Response;
      if (typeof response.request_seq !== 'number') {
        this.logger.error(
          { dapResponse: response },
          'Received malformed DAP response: missing or invalid request_seq.',
        );
        this.emit(
          'error',
          new Error(
            'Received malformed DAP response: missing or invalid request_seq.',
          ),
        );
        return;
      }
      const pending = this.pendingRequests.get(response.request_seq);
      if (pending) {
        if (pending.timeoutTimer) {
          clearTimeout(pending.timeoutTimer);
        }
        this.pendingRequests.delete(response.request_seq);
        if (response.success) {
          this.logger.trace(
            { dapResponse: response },
            `Resolving request seq: ${response.request_seq}`,
          );
          pending.resolve(response);
        } else {
          const errorMessage =
            response.message ||
            `Request ${response.request_seq} (${pending.request.command}) failed.`;
          this.logger.warn(
            { dapResponse: response, request: pending.request },
            `Rejecting request seq: ${response.request_seq} - ${errorMessage}`,
          );
          const dapError = new DAPRequestError(
            errorMessage,
            pending.request,
            response,
          );
          pending.reject(dapError);
        }
      } else {
        this.logger.warn(
          { dapResponse: response },
          `Received response for unknown request_seq: ${response.request_seq}`,
        );
      }
    } else if (message.type === 'event') {
      const event = message as DebugProtocol.Event;
      if (typeof event.event !== 'string') {
        this.logger.error(
          { dapEvent: event },
          'Received malformed DAP event: missing or invalid event type string.',
        );
        this.emit(
          'error',
          new Error(
            'Received malformed DAP event: missing or invalid event type string.',
          ),
        );
        return;
      }
      this.logger.trace(
        { dapEvent: event },
        `Emitting DAP event: ${event.event}`,
      );
      this.emit(event.event, event);
      this.logger.trace(
        { dapEvent: event },
        `DONE Emitting specific DAP event: ${event.event}`,
      );
      this.emit('dapEvent', event);
      this.logger.trace(
        { dapEvent: event },
        `DONE Emitting generic DAP event: dapEvent`,
      );
    } else {
      this.logger.warn(
        { dapMessage: message },
        `Received unhandled DAP message type: ${message.type}`,
      );
    }
  }

  private _rejectPendingRequest(seq: number, error: Error): void {
    const pending = this.pendingRequests.get(seq);
    if (pending) {
      if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
      pending.reject(error);
      this.pendingRequests.delete(seq);
    }
  }

  private _canSendMessage(messageType: string, details: object): boolean {
    if (
      !this.connected ||
      !this.writableStream ||
      this.writableStream.destroyed
    ) {
      const errorMsg = `Cannot send ${messageType}: not connected or writable stream destroyed.`;
      this.logger.error(details, errorMsg);
      this.emit('error', new Error(errorMsg));
      return false;
    }
    return true;
  }

  private sendMessage(message: DebugProtocol.ProtocolMessage): void {
    let messageTypeForLog = message.type;
    if (message.type === 'request') {
      messageTypeForLog = `request '${(message as DebugProtocol.Request).command}'`;
    }

    if (!this._canSendMessage(messageTypeForLog, { dapMessage: message })) {
      if (message.type === 'request') {
        // If _canSendMessage was false, it already emitted an error.
        // We still need to reject the promise associated with this request.
        this._rejectPendingRequest(
          message.seq,
          new Error(
            `Cannot send ${messageTypeForLog}: not connected or writable stream destroyed.`,
          ),
        );
      }
      return;
    }

    if (!this.writableStream) {
      const internalErrorMsg =
        'Internal error: writableStream is null before write operation.';
      this.logger.error({ dapMessage: message }, internalErrorMsg);
      this.emit('error', new Error(internalErrorMsg));
      if (message.type === 'request') {
        this._rejectPendingRequest(message.seq, new Error(internalErrorMsg));
      }
      return;
    }

    message.seq = this.sequence++;
    let jsonPayloadString: string;
    try {
      jsonPayloadString = JSON.stringify(message);
    } catch (e) {
      const errorMsg = `Failed to stringify DAP message for ${messageTypeForLog}`;
      this.logger.error({ error: e, dapMessage: message }, errorMsg);
      this.emit(
        'error',
        new Error(errorMsg + (e instanceof Error ? `: ${e.message}` : '')),
      );
      if (message.type === 'request') {
        this._rejectPendingRequest(message.seq, new Error(errorMsg));
      }
      return;
    }
    const payload = Buffer.from(jsonPayloadString, 'utf8');
    const header = `Content-Length: ${payload.length}${TWO_CRLF}`;

    this.logger.debug({ dapMessage: message, header }, 'Sending DAP message');
    try {
      this.writableStream.write(header);
      this.writableStream.write(payload);
    } catch (e) {
      let errorMessage = 'Unknown error writing to writable stream.';
      let errorToEmit: Error;
      if (e instanceof Error) {
        errorMessage = e.message;
        errorToEmit = e;
      } else {
        errorToEmit = new Error(String(e));
      }
      this.logger.error(
        { error: e, dapMessage: message },
        `Error writing to writable stream: ${errorMessage}`,
      );
      this.emit('error', errorToEmit);
      this.handleDisconnect(`Error writing to stream: ${errorMessage}`);
      if (message.type === 'request') {
        const requestMessage = message as DebugProtocol.Request;
        this._rejectPendingRequest(
          requestMessage.seq,
          new Error(
            `Stream error while sending request '${requestMessage.command}': ${errorMessage}`,
          ),
        );
      }
    }
  }

  public sendRequest<R extends DebugProtocol.Response>(
    command: string,
    args?: unknown,
    timeoutMs: number = DAPProtocolClient.DEFAULT_TIMEOUT,
  ): Promise<R> {
    const request: DebugProtocol.Request = {
      type: 'request',
      seq: this.sequence, // Pre-assign sequence for pendingRequests map key consistency
      command: command,
      arguments: args,
    };

    this.logger.trace(
      { dapRequest: request, timeoutMs },
      `Queueing request: ${command}`,
    );

    if (!this._canSendMessage(`request '${command}'`, { command, args })) {
      return Promise.reject(
        new Error(
          `Cannot send request "${command}": not connected or stream destroyed.`,
        ),
      );
    }

    return new Promise<R>((resolve, reject) => {
      // request.seq is already set
      const pendingRequest: PendingRequest = {
        resolve: resolve as (response: DebugProtocol.Response) => void,
        reject,
        request,
      };

      if (timeoutMs > 0) {
        pendingRequest.timeoutTimer = setTimeout(() => {
          this.pendingRequests.delete(request.seq);
          const timeoutError = new Error(
            `Request ${command} (seq: ${request.seq}) timed out after ${timeoutMs}ms.`,
          );
          this.logger.warn(
            { command, args, seq: request.seq, timeoutMs },
            timeoutError.message,
          );
          this.emit('error', timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      }

      this.pendingRequests.set(request.seq, pendingRequest);
      this.sendMessage(request); // sendMessage will use request.seq and then increment this.sequence
      // If sendMessage failed synchronously (e.g. stream destroyed before write)
      // it would have already rejected the promise via the error handler in sendMessage.
    });
  }

  public sendEvent(event: DebugProtocol.Event): void {
    if (!this._canSendMessage(`event "${event.event}"`, { dapEvent: event })) {
      return;
    }
    this.logger.trace({ dapEvent: event }, `Sending event: ${event.event}`);
    this.sendMessage(event);
  }

  public sendResponse(response: DebugProtocol.Response): void {
    if (
      !this._canSendMessage(
        `response for request_seq ${response.request_seq}`,
        { dapResponse: response },
      )
    ) {
      return;
    }
    this.logger.trace(
      { dapResponse: response },
      `Sending response for request_seq: ${response.request_seq}`,
    );
    this.sendMessage(response);
  }

  private _disposeStream(
    streamInstance: stream.Readable | stream.Writable | null,
    streamName: string,
  ): void {
    if (streamInstance) {
      this.logger.trace(`Cleaning up ${streamName} listeners.`);
      // Check if it's a Readable stream before removing 'data' listener specifically
      if (
        'read' in streamInstance &&
        typeof streamInstance.read === 'function'
      ) {
        streamInstance.removeAllListeners('data');
      }
      streamInstance.removeAllListeners('close');
      streamInstance.removeAllListeners('error');
      if (typeof streamInstance.destroy === 'function') {
        this.logger.trace(`Destroying ${streamName}.`);
        streamInstance.destroy();
      }
    }
  }

  private handleDisconnect(reason: string): void {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.logger.info(`Disconnected from DAP server. Reason: ${reason}`);

    // Clean up readable stream listeners
    this._disposeStream(this.readableStream, 'readableStream');
    this.readableStream = null;

    // Clean up writable stream listeners
    this._disposeStream(this.writableStream, 'writableStream');
    this.writableStream = null;

    // Reject all pending requests
    this.pendingRequests.forEach((pending, seq) => {
      const disconnectError = new Error(
        `Disconnected: ${reason}. Request ${pending.request.command} (seq: ${seq}) aborted.`,
      );
      this.logger.warn(
        { request: pending.request, seq },
        disconnectError.message,
      );
      // _rejectPendingRequest clears timeout and removes from map
      this._rejectPendingRequest(seq, disconnectError);
    });
    // Ensure map is clear if forEach had issues or was empty (though _rejectPendingRequest should handle it)
    this.pendingRequests.clear(); // _rejectPendingRequest already deletes, but clear() is a final guarantee.
    this.buffer = Buffer.alloc(0); // Clear buffer
    this.sequence = 1; // Reset sequence
    this.consecutiveParseFailures = 0; // Reset parse failure counter

    this.emit('disconnected', reason);
    this.removeAllListeners(); // Clean up EventEmitter listeners on this client
  }

  public dispose(): void {
    this.logger.info('Disposing DAPProtocolClient...');
    this.handleDisconnect('Client disposed');
  }

  public isConnected(): boolean {
    return this.connected;
  }
}
