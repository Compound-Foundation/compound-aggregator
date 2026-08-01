import { ethers } from 'ethers';

import { HistoricalCallService } from '../src/generation/historical-call.service';

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

describe('HistoricalCallService', () => {
  const calls = [
    { target: ethers.ZeroAddress, callData: '0x12345678' },
    {
      target: '0x0000000000000000000000000000000000000001',
      callData: '0x90abcdef',
    },
  ];

  it('falls back to direct historical calls when no Multicall existed', async () => {
    const provider = {
      getCode: jest.fn().mockResolvedValue('0x'),
      call: jest.fn().mockResolvedValue('0x').mockResolvedValueOnce('0x1234'),
    };
    const providers = { get: jest.fn().mockReturnValue(provider) };
    const service = new HistoricalCallService(providers as never);

    await expect(
      service.callMany({ network: 'mainnet', blockTag: 100, calls }),
    ).resolves.toEqual([
      { success: true, returnData: '0x1234' },
      { success: false, returnData: '0x', error: 'empty return data' },
    ]);
    expect(provider.getCode).toHaveBeenCalledWith(MULTICALL3_ADDRESS, 100);
    expect(provider.getCode).toHaveBeenCalledWith(MULTICALL2_ADDRESS, 100);
    expect(provider.getCode).toHaveBeenCalledWith(MULTICALL1_ADDRESS, 100);
    expect(provider.call).toHaveBeenCalledTimes(2);
    expect(provider.call).toHaveBeenCalledWith(
      expect.objectContaining({ blockTag: 100 }),
    );
  });

  it('uses Multicall1 when newer Multicall versions did not exist', async () => {
    const multicallInterface = new ethers.Interface(MULTICALL1_ABI);
    const aggregateResult = multicallInterface.encodeFunctionResult(
      'aggregate',
      [150, ['0x1234', '0x5678']],
    );
    const provider = {
      getCode: jest
        .fn()
        .mockResolvedValueOnce('0x')
        .mockResolvedValueOnce('0x')
        .mockResolvedValueOnce('0x6000'),
      call: jest.fn().mockResolvedValue(aggregateResult),
    };
    const providers = { get: jest.fn().mockReturnValue(provider) };
    const service = new HistoricalCallService(providers as never);

    await expect(
      service.callMany({ network: 'mainnet', blockTag: 150, calls }),
    ).resolves.toEqual([
      { success: true, returnData: '0x1234' },
      { success: true, returnData: '0x5678' },
    ]);
    expect(provider.getCode).toHaveBeenNthCalledWith(
      1,
      MULTICALL3_ADDRESS,
      150,
    );
    expect(provider.getCode).toHaveBeenNthCalledWith(
      2,
      MULTICALL2_ADDRESS,
      150,
    );
    expect(provider.getCode).toHaveBeenNthCalledWith(
      3,
      MULTICALL1_ADDRESS,
      150,
    );
    expect(provider.call).toHaveBeenCalledTimes(1);
    expect(provider.call).toHaveBeenCalledWith(
      expect.objectContaining({
        to: MULTICALL1_ADDRESS,
        blockTag: 150,
      }),
    );
  });

  it('uses Multicall2 when Multicall3 did not exist at the historical block', async () => {
    const multicallInterface = new ethers.Interface(MULTICALL2_ABI);
    const aggregateResult = multicallInterface.encodeFunctionResult(
      'tryAggregate',
      [
        [
          { success: true, returnData: '0x1234' },
          { success: false, returnData: '0x' },
        ],
      ],
    );
    const provider = {
      getCode: jest
        .fn()
        .mockResolvedValueOnce('0x')
        .mockResolvedValueOnce('0x6000'),
      call: jest.fn().mockResolvedValue(aggregateResult),
    };
    const providers = { get: jest.fn().mockReturnValue(provider) };
    const service = new HistoricalCallService(providers as never);

    await expect(
      service.callMany({ network: 'mainnet', blockTag: 150, calls }),
    ).resolves.toEqual([
      { success: true, returnData: '0x1234' },
      { success: false, returnData: '0x' },
    ]);
    expect(provider.getCode).toHaveBeenNthCalledWith(
      1,
      MULTICALL3_ADDRESS,
      150,
    );
    expect(provider.getCode).toHaveBeenNthCalledWith(
      2,
      MULTICALL2_ADDRESS,
      150,
    );
    expect(provider.call).toHaveBeenCalledTimes(1);
    expect(provider.call).toHaveBeenCalledWith(
      expect.objectContaining({
        to: MULTICALL2_ADDRESS,
        blockTag: 150,
      }),
    );
  });

  it('splits a timed-out Multicall and reuses the smaller chunk size', async () => {
    const multicallInterface = new ethers.Interface(MULTICALL2_ABI);
    const seenChunkSizes: number[] = [];
    const provider = {
      getCode: jest
        .fn()
        .mockResolvedValueOnce('0x')
        .mockResolvedValueOnce('0x6000'),
      call: jest
        .fn()
        .mockImplementation(
          async (request: { data: string }): Promise<string> => {
            const decoded = multicallInterface.decodeFunctionData(
              'tryAggregate',
              request.data,
            );
            const batch = decoded[1] as Array<unknown>;
            seenChunkSizes.push(batch.length);
            if (batch.length === 200) {
              throw Object.assign(new Error('request timeout'), {
                code: 'TIMEOUT',
              });
            }
            return multicallInterface.encodeFunctionResult('tryAggregate', [
              Array.from({ length: batch.length }, () => ({
                success: true,
                returnData: '0x1234',
              })),
            ]);
          },
        ),
    };
    const providers = { get: jest.fn().mockReturnValue(provider) };
    const service = new HistoricalCallService(providers as never);
    const manyCalls = Array.from(
      { length: 1200 },
      (_, index) => calls[index % calls.length]!,
    );

    const results = await service.callMany({
      network: 'mainnet',
      blockTag: 175,
      calls: manyCalls,
    });

    expect(results).toHaveLength(1200);
    expect(results.every((result) => result.success)).toBe(true);
    expect(seenChunkSizes.filter((size) => size === 200)).toHaveLength(5);
    expect(seenChunkSizes.filter((size) => size === 100)).toHaveLength(12);
  });

  it('runs at most five Multicall chunks concurrently and preserves order', async () => {
    const multicallInterface = new ethers.Interface(MULTICALL2_ABI);
    let active = 0;
    let maxActive = 0;
    const provider = {
      getCode: jest
        .fn()
        .mockResolvedValueOnce('0x')
        .mockResolvedValueOnce('0x6000'),
      call: jest
        .fn()
        .mockImplementation(
          async (request: { data: string }): Promise<string> => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise<void>((resolve) => setImmediate(resolve));
            const decoded = multicallInterface.decodeFunctionData(
              'tryAggregate',
              request.data,
            );
            const batch = decoded[1] as Array<{ callData: string }>;
            active -= 1;
            return multicallInterface.encodeFunctionResult('tryAggregate', [
              batch.map((call) => ({
                success: true,
                returnData: String(call.callData),
              })),
            ]);
          },
        ),
    };
    const providers = { get: jest.fn().mockReturnValue(provider) };
    const service = new HistoricalCallService(providers as never);
    const manyCalls = Array.from({ length: 1200 }, (_, index) => ({
      target: ethers.ZeroAddress,
      callData: `0x${index.toString(16).padStart(8, '0')}`,
    }));

    const results = await service.callMany({
      network: 'mainnet',
      blockTag: 176,
      calls: manyCalls,
    });

    expect(maxActive).toBe(5);
    expect(results.map((result) => result.returnData)).toEqual(
      manyCalls.map((call) => call.callData),
    );
  });

  it('uses one aggregate3 call at the requested historical block', async () => {
    const multicallInterface = new ethers.Interface(MULTICALL3_ABI);
    const aggregateResult = multicallInterface.encodeFunctionResult(
      'aggregate3',
      [
        [
          { success: true, returnData: '0x1234' },
          { success: false, returnData: '0x' },
        ],
      ],
    );
    const provider = {
      getCode: jest.fn().mockResolvedValue('0x6000'),
      call: jest.fn().mockResolvedValue(aggregateResult),
    };
    const providers = { get: jest.fn().mockReturnValue(provider) };
    const service = new HistoricalCallService(providers as never);

    await expect(
      service.callMany({ network: 'base', blockTag: 200, calls }),
    ).resolves.toEqual([
      { success: true, returnData: '0x1234' },
      { success: false, returnData: '0x' },
    ]);
    expect(provider.getCode).toHaveBeenCalledWith(MULTICALL3_ADDRESS, 200);
    expect(provider.call).toHaveBeenCalledTimes(1);
    expect(provider.call).toHaveBeenCalledWith(
      expect.objectContaining({
        to: MULTICALL3_ADDRESS,
        blockTag: 200,
      }),
    );
  });

  it('deduplicates concurrent Multicall3 availability checks', async () => {
    const provider = {
      getCode: jest.fn().mockResolvedValue('0x'),
      call: jest.fn().mockResolvedValue('0x1234'),
    };
    const providers = { get: jest.fn().mockReturnValue(provider) };
    const service = new HistoricalCallService(providers as never);

    await Promise.all([
      service.callMany({
        network: 'mainnet',
        blockTag: 300,
        calls: calls.slice(0, 1),
      }),
      service.callMany({
        network: 'mainnet',
        blockTag: 300,
        calls: calls.slice(0, 1),
      }),
    ]);

    expect(provider.getCode).toHaveBeenCalledTimes(3);
    expect(provider.getCode).toHaveBeenCalledWith(MULTICALL3_ADDRESS, 300);
    expect(provider.getCode).toHaveBeenCalledWith(MULTICALL2_ADDRESS, 300);
    expect(provider.getCode).toHaveBeenCalledWith(MULTICALL1_ADDRESS, 300);
    expect(provider.call).toHaveBeenCalledTimes(2);
  });

  it('retries a failed direct call once more after the concurrent pass', async () => {
    const provider = {
      getCode: jest.fn().mockResolvedValue('0x'),
      call: jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('missing batch response'), {
            code: 'BAD_DATA',
          }),
        )
        .mockResolvedValue('0x1234'),
    };
    const providers = { get: jest.fn().mockReturnValue(provider) };
    const service = new HistoricalCallService(providers as never);

    await expect(
      service.callMany({
        network: 'mainnet',
        blockTag: 400,
        calls: calls.slice(0, 1),
      }),
    ).resolves.toEqual([{ success: true, returnData: '0x1234' }]);
    expect(provider.call).toHaveBeenCalledTimes(2);
  });
});
