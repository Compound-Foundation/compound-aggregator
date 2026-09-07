import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';

import { withRetries } from 'common/helpers/with-retries';
import { ProviderFactory } from 'network/provider.factory';
import { HistoricalCallService } from './historical-call.service';
import {
  pendingBorrow,
  pendingSupply,
  projectBorrowIndex,
  projectSupplyIndex,
} from './period-rewards.math';

const COMPTROLLER_ABI = [
  'function compSupplyState(address) view returns (uint224 index, uint32 blockNumber)',
  'function compBorrowState(address) view returns (uint224 index, uint32 blockNumber)',
  'function compSupplySpeeds(address) view returns (uint256)',
  'function compBorrowSpeeds(address) view returns (uint256)',
  'function compSpeeds(address) view returns (uint256)',
  'function compSupplierIndex(address,address) view returns (uint256)',
  'function compBorrowerIndex(address,address) view returns (uint256)',
];
const CTOKEN_ABI = [
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function totalBorrows() view returns (uint256)',
  'function borrowIndex() view returns (uint256)',
  'function borrowBalanceStored(address) view returns (uint256)',
];

export interface V2MarketRewardBoundary {
  projectedSupplyIndex: bigint;
  projectedBorrowIndex: bigint;
  marketBorrowIndex: bigint;
}

@Injectable()
export class V2CompStateService {
  private readonly logger = new Logger(V2CompStateService.name);
  private readonly comptrollerInterface = new ethers.Interface(COMPTROLLER_ABI);
  private readonly cTokenInterface = new ethers.Interface(CTOKEN_ABI);

  constructor(
    private readonly providers: ProviderFactory,
    private readonly historical: HistoricalCallService,
  ) {}

  public async latestBlock(network: string): Promise<number> {
    const provider = this.providers.get(network);
    return withRetries(() => provider.getBlockNumber(), {
      attempts: 3,
      baseDelayMs: 250,
    });
  }

  public async readMarketBoundary(params: {
    network: string;
    comptroller: string;
    market: string;
    blockTag: number;
  }): Promise<V2MarketRewardBoundary | null> {
    const { network, comptroller, market, blockTag } = params;
    const calls = [
      {
        target: comptroller,
        callData: this.comptrollerInterface.encodeFunctionData(
          'compSupplyState',
          [market],
        ),
      },
      {
        target: comptroller,
        callData: this.comptrollerInterface.encodeFunctionData(
          'compBorrowState',
          [market],
        ),
      },
      {
        target: comptroller,
        callData: this.comptrollerInterface.encodeFunctionData(
          'compSupplySpeeds',
          [market],
        ),
      },
      {
        target: comptroller,
        callData: this.comptrollerInterface.encodeFunctionData(
          'compBorrowSpeeds',
          [market],
        ),
      },
      {
        target: comptroller,
        callData: this.comptrollerInterface.encodeFunctionData('compSpeeds', [
          market,
        ]),
      },
      {
        target: market,
        callData: this.cTokenInterface.encodeFunctionData('totalSupply'),
      },
      {
        target: market,
        callData: this.cTokenInterface.encodeFunctionData('totalBorrows'),
      },
      {
        target: market,
        callData: this.cTokenInterface.encodeFunctionData('borrowIndex'),
      },
    ];
    const results = await this.historical.callMany({
      network,
      blockTag,
      calls,
    });
    if (!results[0]?.success || !results[1]?.success) return null;
    if (!results[5]?.success || !results[6]?.success || !results[7]?.success) {
      this.logger.warn(
        `[V2][${network}][${blockTag}] cToken state failed market=${market}`,
      );
      return null;
    }
    if (
      (!results[2]?.success && !results[4]?.success) ||
      (!results[3]?.success && !results[4]?.success)
    ) {
      this.logger.warn(
        `[V2][${network}][${blockTag}] reward speed state failed market=${market}`,
      );
      return null;
    }

    const supplyState = this.comptrollerInterface.decodeFunctionResult(
      'compSupplyState',
      results[0].returnData,
    );
    const borrowState = this.comptrollerInterface.decodeFunctionResult(
      'compBorrowState',
      results[1].returnData,
    );
    const legacySpeed = results[4]?.success
      ? this.decodeUint(
          this.comptrollerInterface,
          'compSpeeds',
          results[4].returnData,
        )
      : 0n;
    const supplySpeed = results[2]?.success
      ? this.decodeUint(
          this.comptrollerInterface,
          'compSupplySpeeds',
          results[2].returnData,
        )
      : legacySpeed;
    const borrowSpeed = results[3]?.success
      ? this.decodeUint(
          this.comptrollerInterface,
          'compBorrowSpeeds',
          results[3].returnData,
        )
      : legacySpeed;
    const totalSupply = this.decodeUint(
      this.cTokenInterface,
      'totalSupply',
      results[5].returnData,
    );
    const totalBorrows = this.decodeUint(
      this.cTokenInterface,
      'totalBorrows',
      results[6].returnData,
    );
    const marketBorrowIndex = this.decodeUint(
      this.cTokenInterface,
      'borrowIndex',
      results[7].returnData,
    );

    return {
      projectedSupplyIndex: projectSupplyIndex({
        storedIndex: BigInt(supplyState[0]),
        stateBlock: BigInt(supplyState[1]),
        boundaryBlock: BigInt(blockTag),
        speed: supplySpeed,
        totalSupply,
      }),
      projectedBorrowIndex: projectBorrowIndex({
        storedIndex: BigInt(borrowState[0]),
        stateBlock: BigInt(borrowState[1]),
        boundaryBlock: BigInt(blockTag),
        speed: borrowSpeed,
        totalBorrows,
        marketBorrowIndex,
      }),
      marketBorrowIndex,
    };
  }

  public async readPendingByUser(params: {
    network: string;
    comptroller: string;
    market: string;
    users: string[];
    blockTag: number;
    boundary: V2MarketRewardBoundary;
  }): Promise<Map<string, bigint>> {
    const { network, comptroller, market, users, blockTag, boundary } = params;
    const out = new Map<string, bigint>();
    if (users.length === 0) return out;

    const calls = users.flatMap((user) => [
      {
        target: comptroller,
        callData: this.comptrollerInterface.encodeFunctionData(
          'compSupplierIndex',
          [market, user],
        ),
      },
      {
        target: market,
        callData: this.cTokenInterface.encodeFunctionData('balanceOf', [user]),
      },
      {
        target: comptroller,
        callData: this.comptrollerInterface.encodeFunctionData(
          'compBorrowerIndex',
          [market, user],
        ),
      },
      {
        target: market,
        callData: this.cTokenInterface.encodeFunctionData(
          'borrowBalanceStored',
          [user],
        ),
      },
    ]);
    const results = await this.historical.callMany({
      network,
      blockTag,
      calls,
    });

    for (let i = 0; i < users.length; i++) {
      const user = users[i]!;
      const chunk = results.slice(i * 4, i * 4 + 4);
      if (chunk.some((result) => !result?.success)) {
        this.logger.warn(
          `[V2][${network}][${blockTag}] pending state failed market=${market} user=${user}`,
        );
        continue;
      }

      try {
        const supplierIndex = this.decodeUint(
          this.comptrollerInterface,
          'compSupplierIndex',
          chunk[0]!.returnData,
        );
        const balance = this.decodeUint(
          this.cTokenInterface,
          'balanceOf',
          chunk[1]!.returnData,
        );
        const borrowerIndex = this.decodeUint(
          this.comptrollerInterface,
          'compBorrowerIndex',
          chunk[2]!.returnData,
        );
        const borrowBalance = this.decodeUint(
          this.cTokenInterface,
          'borrowBalanceStored',
          chunk[3]!.returnData,
        );
        const pending =
          pendingSupply({
            projectedIndex: boundary.projectedSupplyIndex,
            userIndex: supplierIndex,
            userBalance: balance,
          }) +
          pendingBorrow({
            projectedIndex: boundary.projectedBorrowIndex,
            userIndex: borrowerIndex,
            borrowBalanceStored: borrowBalance,
            marketBorrowIndex: boundary.marketBorrowIndex,
          });
        if (pending !== 0n) out.set(user.toLowerCase(), pending);
      } catch (error) {
        this.logger.warn(
          `[V2][${network}][${blockTag}] pending decode failed market=${market} user=${user}: ${
            (error as Error).message
          }`,
        );
      }
    }

    return out;
  }

  private decodeUint(
    iface: ethers.Interface,
    functionName: string,
    data: string,
  ): bigint {
    return BigInt(iface.decodeFunctionResult(functionName, data)[0]);
  }
}
