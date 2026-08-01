import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';

import { isRetryableRpcError } from 'common/helpers/is-retryable-rpc-error';
import { withRetries } from 'common/helpers/with-retries';
import { ProviderFactory } from 'network/provider.factory';

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
];
const MULTICALL2_ADDRESS = '0x5BA1e12693Dc8F9c48aAD8770482f4739bEeD696';
const MULTICALL2_ABI = [
  'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
];
const MULTICALL1_ADDRESS = '0xeefBa1e63905eF1D7ACbA5a8513c70307C1cE441';
const MULTICALL1_ABI = [
  'function aggregate(tuple(address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)',
];

type MulticallVersion = 'v3' | 'v2' | 'v1' | null;

export interface HistoricalCall {
  target: string;
  callData: string;
}

export interface HistoricalCallResult {
  success: boolean;
  returnData: string;
  error?: string;
}

@Injectable()
export class HistoricalCallService {
  private readonly logger = new Logger(HistoricalCallService.name);
  private readonly multicall3Interface = new ethers.Interface(MULTICALL3_ABI);
  private readonly multicall2Interface = new ethers.Interface(MULTICALL2_ABI);
  private readonly multicall1Interface = new ethers.Interface(MULTICALL1_ABI);
  private readonly multicallAvailability = new Map<
    string,
    Promise<MulticallVersion>
  >();
  private readonly multicallChunkLimits = new Map<string, number>();
  private readonly chunkSize = 200;
  private readonly minMulticallChunkSize = 25;
  private readonly multicallConcurrency = 5;
  private readonly directConcurrency = 20;
  private directActive = 0;
  private readonly directWaiters: Array<() => void> = [];

  constructor(private readonly providers: ProviderFactory) {}

  public async callMany(params: {
    network: string;
    blockTag: number;
    calls: HistoricalCall[];
  }): Promise<HistoricalCallResult[]> {
    const { network, blockTag, calls } = params;
    if (calls.length === 0) return [];

    const multicallVersion = await this.getMulticallVersion(network, blockTag);
    if (!multicallVersion) {
      return this.callDirectInChunks(network, blockTag, calls);
    }

    return this.callMulticallConcurrently(
      multicallVersion,
      network,
      blockTag,
      calls,
    );
  }

  private async callMulticallConcurrently(
    version: Exclude<MulticallVersion, null>,
    network: string,
    blockTag: number,
    calls: HistoricalCall[],
  ): Promise<HistoricalCallResult[]> {
    const out: HistoricalCallResult[] = [];
    let nextOffset = 0;
    const initialChunkSize =
      this.multicallChunkLimits.get(
        this.multicallChunkKey(network, blockTag, version),
      ) ?? this.chunkSize;
    const workerCount = Math.min(
      this.multicallConcurrency,
      Math.ceil(calls.length / initialChunkSize),
    );

    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const chunkSize =
          this.multicallChunkLimits.get(
            this.multicallChunkKey(network, blockTag, version),
          ) ?? this.chunkSize;
        const offset = nextOffset;
        if (offset >= calls.length) return;
        const end = Math.min(offset + chunkSize, calls.length);
        nextOffset = end;
        const chunk = calls.slice(offset, end);
        const results = await this.callMulticallByVersion(
          version,
          network,
          blockTag,
          chunk,
        );
        if (results.length !== chunk.length) {
          throw new Error(
            `[historical][${network}][${blockTag}] Multicall result length mismatch: expected=${chunk.length} actual=${results.length}`,
          );
        }
        for (let i = 0; i < results.length; i++) {
          out[offset + i] = results[i]!;
        }
      }
    });
    await Promise.all(workers);

    return out;
  }

  private async callDirectInChunks(
    network: string,
    blockTag: number,
    calls: HistoricalCall[],
  ): Promise<HistoricalCallResult[]> {
    const out: HistoricalCallResult[] = [];
    for (let offset = 0; offset < calls.length; offset += this.chunkSize) {
      out.push(
        ...(await this.callDirect(
          network,
          blockTag,
          calls.slice(offset, offset + this.chunkSize),
        )),
      );
    }
    return out;
  }

  private async getMulticallVersion(
    network: string,
    blockTag: number,
  ): Promise<MulticallVersion> {
    const key = `${network}:${blockTag}`;
    const cached = this.multicallAvailability.get(key);
    if (cached) return cached;

    const request = (async (): Promise<MulticallVersion> => {
      const provider = this.providers.get(network);
      const multicall3Code = await withRetries(
        () => provider.getCode(MULTICALL3_ADDRESS, blockTag),
        { attempts: 3, baseDelayMs: 250 },
      );
      if (multicall3Code !== '0x') {
        this.logger.verbose(
          `[historical][${network}][${blockTag}] multicall=v3`,
        );
        return 'v3';
      }

      const multicall2Code = await withRetries(
        () => provider.getCode(MULTICALL2_ADDRESS, blockTag),
        { attempts: 3, baseDelayMs: 250 },
      );
      if (multicall2Code !== '0x') {
        this.logger.verbose(
          `[historical][${network}][${blockTag}] multicall=v2`,
        );
        return 'v2';
      }

      const multicall1Code = await withRetries(
        () => provider.getCode(MULTICALL1_ADDRESS, blockTag),
        { attempts: 3, baseDelayMs: 250 },
      );
      const version: MulticallVersion = multicall1Code === '0x' ? null : 'v1';
      this.logger.verbose(
        `[historical][${network}][${blockTag}] multicall=${version ?? 'none'}`,
      );
      return version;
    })();
    this.multicallAvailability.set(key, request);

    try {
      return await request;
    } catch (error) {
      if (this.multicallAvailability.get(key) === request) {
        this.multicallAvailability.delete(key);
      }
      throw error;
    }
  }

  private async callMulticall3WithFallback(
    network: string,
    blockTag: number,
    calls: HistoricalCall[],
  ): Promise<HistoricalCallResult[]> {
    const provider = this.providers.get(network);
    const payload = calls.map((call) => ({
      target: call.target,
      allowFailure: true,
      callData: call.callData,
    }));
    const data = this.multicall3Interface.encodeFunctionData('aggregate3', [
      payload,
    ]);

    try {
      const returnData = await this.callMulticallRpc(() =>
        provider.call({
          to: MULTICALL3_ADDRESS,
          data,
          blockTag,
        }),
      );
      const decoded = this.multicall3Interface.decodeFunctionResult(
        'aggregate3',
        returnData,
      )[0] as Array<{ success: boolean; returnData: string }>;
      return decoded.map((result) => ({
        success: Boolean(result.success) && String(result.returnData) !== '0x',
        returnData: String(result.returnData),
      }));
    } catch (error) {
      return this.handleMulticallFailure('v3', network, blockTag, calls, error);
    }
  }

  private async callMulticall2WithFallback(
    network: string,
    blockTag: number,
    calls: HistoricalCall[],
  ): Promise<HistoricalCallResult[]> {
    const provider = this.providers.get(network);
    const payload = calls.map((call) => ({
      target: call.target,
      callData: call.callData,
    }));
    const data = this.multicall2Interface.encodeFunctionData('tryAggregate', [
      false,
      payload,
    ]);

    try {
      const returnData = await this.callMulticallRpc(() =>
        provider.call({
          to: MULTICALL2_ADDRESS,
          data,
          blockTag,
        }),
      );
      const decoded = this.multicall2Interface.decodeFunctionResult(
        'tryAggregate',
        returnData,
      )[0] as Array<{ success: boolean; returnData: string }>;
      return decoded.map((result) => ({
        success: Boolean(result.success) && String(result.returnData) !== '0x',
        returnData: String(result.returnData),
      }));
    } catch (error) {
      return this.handleMulticallFailure('v2', network, blockTag, calls, error);
    }
  }

  private async callMulticall1WithFallback(
    network: string,
    blockTag: number,
    calls: HistoricalCall[],
  ): Promise<HistoricalCallResult[]> {
    const provider = this.providers.get(network);
    const payload = calls.map((call) => ({
      target: call.target,
      callData: call.callData,
    }));
    const data = this.multicall1Interface.encodeFunctionData('aggregate', [
      payload,
    ]);

    try {
      const encodedResult = await this.callMulticallRpc(() =>
        provider.call({
          to: MULTICALL1_ADDRESS,
          data,
          blockTag,
        }),
      );
      const returnData = this.multicall1Interface.decodeFunctionResult(
        'aggregate',
        encodedResult,
      )[1] as string[];
      return returnData.map((result) => ({
        success: String(result) !== '0x',
        returnData: String(result),
      }));
    } catch (error) {
      return this.handleMulticallFailure('v1', network, blockTag, calls, error);
    }
  }

  private async handleMulticallFailure(
    version: Exclude<MulticallVersion, null>,
    network: string,
    blockTag: number,
    calls: HistoricalCall[],
    error: unknown,
  ): Promise<HistoricalCallResult[]> {
    const message = this.errorMessage(error);
    if (
      this.isSplittableMulticallError(error) &&
      calls.length > this.minMulticallChunkSize
    ) {
      const middle = Math.ceil(calls.length / 2);
      this.rememberSmallerMulticallChunk(network, blockTag, version, middle);
      this.logger.warn(
        `[historical][${network}][${blockTag}] Multicall${version.slice(
          1,
        )} failed for ${calls.length} calls, splitting into ${middle}+${
          calls.length - middle
        }: ${message}`,
      );
      const left = await this.callMulticallByVersion(
        version,
        network,
        blockTag,
        calls.slice(0, middle),
      );
      const right = await this.callMulticallByVersion(
        version,
        network,
        blockTag,
        calls.slice(middle),
      );
      return [...left, ...right];
    }

    this.logger.warn(
      `[historical][${network}][${blockTag}] Multicall${version.slice(
        1,
      )} failed for ${
        calls.length
      } calls, falling back to direct eth_call: ${message}`,
    );
    return this.callDirect(network, blockTag, calls);
  }

  private callMulticallByVersion(
    version: Exclude<MulticallVersion, null>,
    network: string,
    blockTag: number,
    calls: HistoricalCall[],
  ): Promise<HistoricalCallResult[]> {
    if (version === 'v3') {
      return this.callMulticall3WithFallback(network, blockTag, calls);
    }
    if (version === 'v2') {
      return this.callMulticall2WithFallback(network, blockTag, calls);
    }
    return this.callMulticall1WithFallback(network, blockTag, calls);
  }

  private callMulticallRpc<T>(fn: () => Promise<T>): Promise<T> {
    return withRetries(fn, {
      attempts: 3,
      baseDelayMs: 250,
      isRetryable: (error) =>
        !this.isSplittableMulticallError(error) && isRetryableRpcError(error),
    });
  }

  private isSplittableMulticallError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const value = error as {
      code?: unknown;
      shortMessage?: unknown;
      message?: unknown;
    };
    const message = String(value.shortMessage ?? value.message ?? '');
    return (
      value.code === 'TIMEOUT' ||
      /timeout|timed out|response size exceeded|max response size|request entity too large|out of gas|gas required exceeds allowance/i.test(
        message,
      )
    );
  }

  private rememberSmallerMulticallChunk(
    network: string,
    blockTag: number,
    version: Exclude<MulticallVersion, null>,
    chunkSize: number,
  ): void {
    const key = this.multicallChunkKey(network, blockTag, version);
    const current = this.multicallChunkLimits.get(key) ?? this.chunkSize;
    this.multicallChunkLimits.set(key, Math.min(current, chunkSize));
  }

  private multicallChunkKey(
    network: string,
    blockTag: number,
    version: Exclude<MulticallVersion, null>,
  ): string {
    return `${network}:${blockTag}:${version}`;
  }

  private async callDirect(
    network: string,
    blockTag: number,
    calls: HistoricalCall[],
  ): Promise<HistoricalCallResult[]> {
    const provider = this.providers.get(network);
    const results = new Array<HistoricalCallResult>(calls.length);
    let nextIndex = 0;
    const workerCount = Math.min(this.directConcurrency, calls.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= calls.length) return;
        results[index] = await this.callDirectOne(
          provider,
          blockTag,
          calls[index]!,
        );
      }
    });
    await Promise.all(workers);

    const failedIndexes = results.flatMap((result, index) =>
      result.success || result.error === 'empty return data' ? [] : [index],
    );
    if (failedIndexes.length > 0) {
      this.logger.warn(
        `[historical][${network}][${blockTag}] retrying ${failedIndexes.length}/${calls.length} failed direct calls sequentially`,
      );
      for (const index of failedIndexes) {
        results[index] = await this.callDirectOne(
          provider,
          blockTag,
          calls[index]!,
        );
      }
    }

    return results;
  }

  private async callDirectOne(
    provider: ethers.JsonRpcProvider,
    blockTag: number,
    call: HistoricalCall,
  ): Promise<HistoricalCallResult> {
    return this.withDirectPermit(async () => {
      try {
        const returnData = await withRetries(
          () =>
            provider.call({
              to: call.target,
              data: call.callData,
              blockTag,
            }),
          { attempts: 3, baseDelayMs: 250 },
        );
        return returnData === '0x'
          ? { success: false, returnData, error: 'empty return data' }
          : { success: true, returnData };
      } catch (error) {
        return {
          success: false,
          returnData: '0x',
          error: this.errorMessage(error),
        };
      }
    });
  }

  private async withDirectPermit<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireDirectPermit();
    try {
      return await fn();
    } finally {
      this.releaseDirectPermit();
    }
  }

  private acquireDirectPermit(): Promise<void> {
    if (this.directActive < this.directConcurrency) {
      this.directActive += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.directWaiters.push(resolve));
  }

  private releaseDirectPermit(): void {
    const next = this.directWaiters.shift();
    if (next) {
      next();
      return;
    }
    this.directActive -= 1;
  }

  private errorMessage(error: unknown): string {
    if (!error || typeof error !== 'object') return String(error);
    const value = error as { shortMessage?: unknown; message?: unknown };
    return String(value.shortMessage ?? value.message ?? error);
  }
}
