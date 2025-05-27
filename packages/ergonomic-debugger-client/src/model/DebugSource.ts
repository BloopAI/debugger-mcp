import { DebugProtocol } from '@vscode/debugprotocol';
import type { LoggerInterface } from '../logging';
import type { DAPSessionHandlerInterface } from './model.types';
import {
  StateFetchErrorNotifier,
  DAPSessionHandler,
} from '../dapSessionHandler';

export class DebugSource {
  public readonly name?: string;
  public readonly path?: string;
  public readonly sourceReference?: number;
  public readonly presentationHint?: DebugProtocol.Source['presentationHint'];
  public readonly origin?: string;
  public readonly adapterData?: unknown;

  private _content: string | undefined;
  private _fetchContentPromise: Promise<string> | null = null;

  constructor(
    private readonly sourceData: DebugProtocol.Source,
    private readonly sessionHandler: DAPSessionHandlerInterface,
    private readonly logger: LoggerInterface,
  ) {
    this.name = sourceData.name;
    this.path = sourceData.path;
    this.sourceReference = sourceData.sourceReference;
    this.presentationHint = sourceData.presentationHint;
    this.origin = sourceData.origin;
    this.adapterData = sourceData.adapterData;
  }

  private _isValidSourceReference(): boolean {
    return !(!this.sourceReference || this.sourceReference === 0);
  }

  public async getContent(): Promise<string> {
    if (!this._isValidSourceReference()) {
      this.logger.warn(
        `[DebugSource.getContent] Attempted to fetch content for source without a valid sourceReference. Name: ${this.name}, Path: ${this.path}`,
      );
      return this.path
        ? `Content for ${this.path} (reference: ${this.sourceReference}) is not available from adapter.`
        : 'Source content unavailable (no path or reference).';
    }

    if (this._fetchContentPromise) {
      this.logger.debug(
        `[DebugSource.getContent] Deduplicating content fetch for sourceReference: ${this.sourceReference}`,
      );
      return this._fetchContentPromise;
    }

    this.logger.info(
      `[DebugSource.getContent] Fetching content for sourceReference: ${this.sourceReference}`,
    );
    this._fetchContentPromise = this._doFetchContent();

    try {
      this._content = await this._fetchContentPromise;
      this.logger.info(
        `[DebugSource.getContent] Successfully fetched content for sourceReference: ${this.sourceReference}`,
      );
      return this._content;
    } catch (error) {
      this.logger.error(
        `[DebugSource.getContent] Failed to fetch content for sourceReference: ${this.sourceReference}`,
        { error },
      );
      const err = error as Error;
      new StateFetchErrorNotifier(this.sessionHandler as DAPSessionHandler)
        .command('source')
        .resourceType('sourceContent')
        .details({ sourceReference: this.sourceReference })
        .error(err)
        .message(err.message)
        .notify();
      throw error;
    } finally {
      this._fetchContentPromise = null;
    }
  }

  private async _doFetchContent(): Promise<string> {
    if (!this._isValidSourceReference()) {
      return 'Source content unavailable (no valid reference).';
    }
    const args: DebugProtocol.SourceArguments = {
      // Ensured by _isValidSourceReference that this.sourceReference is a number > 0
      sourceReference: this.sourceReference!,
    };

    const response =
      await this.sessionHandler.sendRequest<DebugProtocol.SourceResponse>(
        'source',
        args,
      );

    if (
      response &&
      response.body &&
      typeof response.body.content === 'string'
    ) {
      return response.body.content;
    } else {
      this.logger.warn(
        `[DebugSource._doFetchContent] Received no content or invalid response for sourceReference: ${this.sourceReference}`,
        { response },
      );
      throw new Error(
        `Failed to retrieve source content for reference ${this.sourceReference}. Adapter returned no content.`,
      );
    }
  }

  public get id(): string {
    if (this.sourceReference && this.sourceReference > 0) {
      return `ref:${this.sourceReference}`;
    }
    if (this.path) {
      return `path:${this.path}`;
    }
    if (this.name) {
      return `name:${this.name}`;
    }
    return `unknownSource:${Date.now()}`;
  }
}
