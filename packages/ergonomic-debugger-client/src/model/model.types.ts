import { DebugProtocol } from '@vscode/debugprotocol';
import {
  CancellationToken,
  CancellationTokenSource,
} from '../common/cancellation';

/**
 * Interface for the DAPSessionHandler, defining the contract
 * for model classes to interact with the session.
 */
export interface DAPSessionHandlerInterface {
  readonly sessionId: string;
  readonly capabilities?: DebugProtocol.Capabilities; // Added for capability checks

  sendRequest<TResponse extends DebugProtocol.Response>(
    command: string,
    args?: unknown,
    options?: unknown, // Corresponds to DAPRequestBuilderOptions
    cancellationToken?: CancellationToken,
  ): Promise<TResponse>; // Returns full TResponse

  registerCancellableOperation(
    source: CancellationTokenSource,
    threadId?: number,
  ): () => void;
}

/**
 * Minimal interface for a DebugThread, used by DebugStackFrame.
 */
export interface DebugThreadInterface {
  readonly id: number;
  readonly name: string;
  // Add other methods/properties if DebugStackFrame needs to call back to its thread.
}

/**
 * Minimal interface for a DebugStackFrame, used by DebugScope.
 */
export interface DebugStackFrameInterface {
  readonly id: number;
  // Add other methods/properties if DebugScope needs to call back to its frame.
}

/**
 * Minimal interface for a DebugScope, used by DebugVariable.
 */
export interface DebugScopeInterface {
  readonly id: string;
  readonly name: string;
  readonly variablesReference: number;
  // Add other methods/properties if DebugVariable needs to call back to its scope.
}

/**
 * Minimal interface for a DebugVariable.
 */
export interface DebugVariableInterface {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly type?: string;
  readonly variablesReference: number;
  readonly namedVariables?: number;
  readonly indexedVariables?: number;
  readonly evaluateName?: string;
  readonly presentationHint?: DebugProtocol.VariablePresentationHint;
  readonly memoryReference?: string;
  // Children are typically fetched; not listed directly in interface unless guaranteed.
}
