import * as sinon from 'sinon';
import { DebugProtocol } from '@vscode/debugprotocol';
import { DAPSessionHandlerInterface } from '../../../src/model/model.types';
import { LoggerInterface } from '../../../src/logging';
import {
  CancellationToken,
  CancellationTokenSource,
} from '../../../src/common/cancellation';

export const createMockLogger = (): LoggerInterface => {
  const stub = () => sinon.stub() as sinon.SinonStub;
  return {
    trace: stub(),
    debug: stub(),
    info: stub(),
    warn: stub(),
    error: stub(),
    child: sinon.stub().callsFake(() => createMockLogger()),
  };
};

import { SessionStatus } from '../../../src/dapSessionHandler';

export class MockDAPSessionHandler implements DAPSessionHandlerInterface {
  public sessionId: string =
    'mock-session-id-' + Math.random().toString(36).substring(7);
  public status: SessionStatus = 'active';
  public capabilities: DebugProtocol.Capabilities = {
    supportsConfigurationDoneRequest: true,
    supportsSetVariable: true,
  };

  public sendRequest = sinon.stub();
  public registerCancellableOperation: sinon.SinonStub<
    [CancellationTokenSource, number?],
    () => void
  >;

  public notifyCallStackChanged: sinon.SinonStub;
  public notifyScopesChanged: sinon.SinonStub;
  public notifyVariablesChanged: sinon.SinonStub;
  public notifySourceContentChanged: sinon.SinonStub;
  public notifyFetchError: sinon.SinonStub;

  public getCapabilities(): DebugProtocol.Capabilities {
    return this.capabilities;
  }

  public _handleNotifyStateFetchError: sinon.SinonStub;

  constructor() {
    this.sendRequest.callsFake(
      <TResponse extends DebugProtocol.Response>(
        command: string,
        args?: unknown,
        options?: unknown,
        cancellationToken?: CancellationToken,
      ): Promise<TResponse> => {
        console.log(
          `[MockDAPSessionHandler.sendRequest DEFAULT FAKED CALL] command: ${command}, args: ${JSON.stringify(args)}, options: ${JSON.stringify(options)}, tokenCancelled: ${cancellationToken?.isCancellationRequested}`,
        );
        return Promise.resolve({
          success: true,
          seq: 1,
          request_seq: 1,
          type: 'response',
          command: command || 'mockSuccess',
          body: {},
        } as TResponse);
      },
    );

    this.registerCancellableOperation = sinon
      .stub<[CancellationTokenSource, number?], () => void>()
      .returns(() => {});

    this.notifyCallStackChanged = sinon.stub();
    this.notifyScopesChanged = sinon.stub();
    this.notifyVariablesChanged = sinon.stub();
    this.notifySourceContentChanged = sinon.stub();
    this.notifyFetchError = sinon.stub();

    this._handleNotifyStateFetchError = sinon
      .stub()
      .callsFake((payload: object) => {
        this.notifyFetchError(payload);
      });
  }

  public reset(): void {
    this.sendRequest.reset();
    this.sendRequest.resolves({
      success: true,
      seq: 1,
      request_seq: 1,
      type: 'response',
      command: 'mockSuccess',
      body: {},
    } as DebugProtocol.Response);
    this.registerCancellableOperation.resetHistory();
    this.registerCancellableOperation.returns(() => {});

    this.notifyCallStackChanged.resetHistory();
    this.notifyScopesChanged.resetHistory();
    this.notifyVariablesChanged.resetHistory();
    this.notifySourceContentChanged.resetHistory();
    this.notifyFetchError.resetHistory();
    this._handleNotifyStateFetchError.resetHistory();
    this.capabilities = {
      supportsConfigurationDoneRequest: true,
      supportsSetVariable: true,
    };
  }
}
