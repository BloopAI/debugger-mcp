import * as NodeJS from 'events';
import { DebugProtocol } from '@vscode/debugprotocol';
import type { LoggerInterface } from '../logging';
import type {
  DAPSessionHandlerInterface,
  DebugScopeInterface,
} from './model.types';

/**
 * Events emitted by DebugVariable.
 */
export interface DebugVariableEvents {
  /** Emitted when children of this variable have been successfully fetched and `this.children` is updated. */
  childrenRefreshed: (children: DebugVariable[]) => void;
  /** Emitted when fetching children fails. */
  childrenFetchFailed: (error: Error) => void;
  /** Emitted when the variable's value has been successfully set and its properties updated. */
  valueChanged: (
    newValue: string,
    newType?: string,
    newVariablesReference?: number,
  ) => void;
  /** Emitted when setting the variable's value fails. */
  setValueFailed: (error: Error, attemptedValue: string) => void;
}

export declare interface DebugVariableEventEmitter {
  on<U extends keyof DebugVariableEvents>(
    event: U,
    listener: DebugVariableEvents[U],
  ): this;
  emit<U extends keyof DebugVariableEvents>(
    event: U,
    ...args: Parameters<DebugVariableEvents[U]>
  ): boolean;
}

export class DebugVariable
  extends NodeJS.EventEmitter
  implements DebugVariableEventEmitter
{
  public readonly name: string;
  public value: string;
  public type?: string;
  public variablesReference: number;
  public namedVariables?: number;
  public indexedVariables?: number;
  public evaluateName?: string;
  public presentationHint?: DebugProtocol.VariablePresentationHint;
  public memoryReference?: string;

  public children: DebugVariable[] = [];
  private _isFetchingChildren: boolean = false;
  private _fetchChildrenPromise: Promise<DebugVariable[]> | null = null;
  private _lastChildrenError?: Error;

  constructor(
    private readonly variableData: DebugProtocol.Variable,
    public readonly parentScopeOrVar: DebugScopeInterface | DebugVariable, // DebugScopeInterface now from model.types
    private readonly sessionHandler: DAPSessionHandlerInterface, // From model.types for sendRequest
    private readonly logger: LoggerInterface,
  ) {
    super();
    this.name = variableData.name;
    this.value = variableData.value;
    this.type = variableData.type;
    this.variablesReference = variableData.variablesReference;
    this.namedVariables = variableData.namedVariables;
    this.indexedVariables = variableData.indexedVariables;
    this.evaluateName = variableData.evaluateName;
    this.presentationHint = variableData.presentationHint;
    this.memoryReference = variableData.memoryReference;
  }

  public get id(): string {
    let parentIdString: string;
    if (this.parentScopeOrVar instanceof DebugVariable) {
      parentIdString = this.parentScopeOrVar.id;
    } else {
      // It's a DebugScopeInterface from model.types
      parentIdString = this.parentScopeOrVar.id; // Now type-safe
    }
    return `var:${parentIdString}:${this.name}:${this.variablesReference}`;
  }

  public async getChildren(): Promise<DebugVariable[]> {
    if (this.variablesReference === 0) {
      this.logger.debug(
        `[DebugVariable.getChildren] Variable '${this.name}' (ref: ${this.variablesReference}) has no children or children cannot be fetched.`,
      );
      return [];
    }

    if (this._isFetchingChildren && this._fetchChildrenPromise) {
      this.logger.debug(
        `[DebugVariable.getChildren] Deduplicating children fetch for variable '${this.name}' (ref: ${this.variablesReference})`,
      );
      return this._fetchChildrenPromise;
    }

    this.logger.info(
      `[DebugVariable.getChildren] Fetching children for variable '${this.name}' (ref: ${this.variablesReference})`,
    );
    this._isFetchingChildren = true;
    this._lastChildrenError = undefined;
    this._fetchChildrenPromise = this._doFetchChildren();

    try {
      const fetchedChildren = await this._fetchChildrenPromise;
      this.children = fetchedChildren;
      // Detach listeners from old children, if any were attached.
      this.children.forEach((child) => child.removeAllListeners());
      // Attach listeners to new children if this variable needs to bubble their events.

      this.logger.info(
        `[DebugVariable.getChildren] Successfully fetched ${this.children.length} children for variable '${this.name}' (ref: ${this.variablesReference})`,
      );
      this.emit('childrenRefreshed', this.children);
      return this.children;
    } catch (error) {
      this.logger.error(
        `[DebugVariable.getChildren] Failed to fetch children for variable '${this.name}' (ref: ${this.variablesReference})`,
        { error },
      );
      this.children = []; // Clear internal state on failure

      let processedError: Error;
      if (error instanceof Error) {
        processedError = error;
      } else {
        processedError = new Error(String(error));
      }
      this._lastChildrenError = processedError;
      this.emit('childrenFetchFailed', processedError);
      return [];
    } finally {
      this._isFetchingChildren = false;
      this._fetchChildrenPromise = null;
    }
  }

  private async _doFetchChildren(): Promise<DebugVariable[]> {
    // Detach listeners from current children before fetching new ones
    this.children.forEach((child) => child.removeAllListeners());
    const args: DebugProtocol.VariablesArguments = {
      variablesReference: this.variablesReference,
    };

    const response =
      await this.sessionHandler.sendRequest<DebugProtocol.VariablesResponse>(
        'variables',
        args,
        {
          // Children of variables are typically fetched when stopped.
          allowedStates: ['stopped', 'active'], // 'active' might be needed for logpoints or watch expressions
        },
      );

    if (response && response.body && Array.isArray(response.body.variables)) {
      return response.body.variables.map((v: DebugProtocol.Variable) => {
        const newChild = new DebugVariable(
          v,
          this,
          this.sessionHandler,
          this.logger,
        );
        // Attach listeners here if this parent variable needs to bubble events from children.
        return newChild;
      });
    } else {
      this.logger.warn(
        `[DebugVariable._doFetchChildren] Received no variables or invalid response for reference: ${this.variablesReference}`,
        { response },
      );
      throw new Error(
        `Failed to retrieve children for variable reference ${this.variablesReference}. Adapter returned no variables.`,
      );
    }
  }

  public async setValue(
    newValue: string,
  ): Promise<DebugProtocol.SetVariableResponse['body']> {
    if (!this.sessionHandler.capabilities?.supportsSetVariable) {
      this.logger.warn(
        `[DebugVariable.setValue] Adapter does not support setVariable for variable '${this.name}'.`,
      );
      const err = new Error(
        `Adapter does not support setting variable values.`,
      );
      this.emit('setValueFailed', err, newValue);
      throw err;
    }

    let containerVariablesReference: number;
    if ('variablesReference' in this.parentScopeOrVar) {
      // Both DebugScope and DebugVariable have variablesReference.
      containerVariablesReference = this.parentScopeOrVar.variablesReference;
    } else {
      // Should not happen if parent is always a scope or variable with a reference.
      this.logger.error(
        `[DebugVariable.setValue] Parent of variable '${this.name}' does not have a variablesReference.`,
      );
      const err = new Error(
        `Parent of variable '${this.name}' lacks a variablesReference.`,
      );
      this.emit('setValueFailed', err, newValue);
      throw err;
    }

    // The DAP spec for setVariable requires the container's variablesReference.
    // The current logic for `containerVariablesReference` correctly gets the parent's reference.
    // Checking for `containerVariablesReference === 0` is generally valid,
    // though adapters might theoretically allow setting variables in non-expandable containers.

    if (
      containerVariablesReference === 0 &&
      !(
        this.parentScopeOrVar instanceof DebugVariable &&
        this.parentScopeOrVar.variablesReference === 0
      )
    ) {
      // Allow if parent is a variable with varRef 0 (e.g. primitive that got expanded by mistake by client)
      // but not if parent is a scope with varRef 0.
      if (!(this.parentScopeOrVar instanceof DebugVariable)) {
        // if parent is a scope
        this.logger.error(
          `[DebugVariable.setValue] Cannot set variable '${this.name}' as its parent scope has a variablesReference of 0.`,
        );
        const err = new Error(
          `Cannot set variable '${this.name}' as its parent scope has no variablesReference.`,
        );
        this.emit('setValueFailed', err, newValue);
        throw err;
      }
    }

    const args: DebugProtocol.SetVariableArguments = {
      variablesReference: containerVariablesReference,
      name: this.name,
      value: newValue,
    };

    this.logger.info(
      `[DebugVariable.setValue] Setting value for variable '${this.name}' in container ref ${containerVariablesReference} to '${newValue}'`,
    );

    try {
      const response =
        await this.sessionHandler.sendRequest<DebugProtocol.SetVariableResponse>(
          'setVariable',
          args,
        );

      if (response && response.body) {
        const responseBody = response.body;
        this.logger.info(
          `[DebugVariable.setValue] Successfully set value for variable '${this.name}'. New value: '${responseBody.value}'`,
        );
        this.value = responseBody.value;
        this.type = responseBody.type; // Update type
        const oldVarRef = this.variablesReference;
        if (responseBody.variablesReference !== undefined) {
          this.variablesReference = responseBody.variablesReference;
        }
        this.namedVariables = responseBody.namedVariables;
        this.indexedVariables = responseBody.indexedVariables;

        this.emit(
          'valueChanged',
          this.value,
          this.type,
          this.variablesReference,
        );

        // If variablesReference changed, it implies children might be different or now exist/disappear.
        // We should clear existing children and let them be re-fetched if needed.
        if (this.variablesReference !== oldVarRef) {
          this.logger.info(
            `[DebugVariable.setValue] VariablesReference for '${this.name}' changed from ${oldVarRef} to ${this.variablesReference}. Clearing children.`,
          );
          this.children.forEach((child) => child.removeAllListeners());
          this.children = [];
          // 'valueChanged' signals the update; UI can re-fetch children if needed.
        }
        return responseBody;
      } else {
        this.logger.warn(
          `[DebugVariable.setValue] setVariable request for '${this.name}' returned no body or invalid response.`,
        );
        const err = new Error(
          `Adapter returned no response body for setVariable on '${this.name}'.`,
        );
        this.emit('setValueFailed', err, newValue);
        throw err;
      }
    } catch (error) {
      this.logger.error(
        `[DebugVariable.setValue] Failed to set value for variable '${this.name}'`,
        { error },
      );
      let processedError: Error;
      if (error instanceof Error) {
        processedError = error;
      } else {
        processedError = new Error(String(error));
      }
      this.emit('setValueFailed', processedError, newValue);
      throw processedError;
    }
  }

  /**
   * Disposes of the DebugVariable instance.
   * This includes clearing its children, recursively disposing of them,
   * and removing all event listeners attached to this instance.
   */
  public dispose(): void {
    this.logger.debug(
      `[DebugVariable.dispose] Disposing variable '${this.name}' (ref: ${this.variablesReference})`,
    );

    // Recursively dispose of children
    if (this.children && this.children.length > 0) {
      this.logger.trace(
        `[DebugVariable.dispose] Disposing ${this.children.length} children of variable '${this.name}'`,
      );
      this.children.forEach((child) => child.dispose());
    }
    this.children = []; // Clear the children array

    // Cancel any ongoing fetch for children.
    // This doesn't abort DAP requests but prevents stale updates.
    if (this._fetchChildrenPromise) {
      // The `finally` block in getChildren will clear _fetchChildrenPromise.
      this._isFetchingChildren = false;
      this._fetchChildrenPromise = null;
    }
    this._lastChildrenError = undefined;

    // Remove all event listeners attached to this DebugVariable instance
    this.removeAllListeners();
    this.logger.trace(
      `[DebugVariable.dispose] Removed all listeners for variable '${this.name}'`,
    );
  }
}
