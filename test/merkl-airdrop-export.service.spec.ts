import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';

import { CompoundVersion } from '../src/common/types/compound-version';
import { MerklAirdropExportService } from '../src/generation/merkl-airdrop-export.service';
import { ResolvedRewardRange } from '../src/generation/period-rewards.types';

describe('MerklAirdropExportService', () => {
  it('writes full remaining debt by default', () => {
    const temp = mkdtempSync(join(tmpdir(), 'compound-merkl-'));
    const originalCwd = process.cwd();
    process.chdir(temp);
    try {
      const range = {
        network: 'mainnet',
        chainId: 1,
        config: {} as any,
        startBoundary: { number: 99, hash: '0x01', timestamp: 999 },
        start: { number: 100, hash: '0x02', timestamp: 1000 },
        end: { number: 200, hash: '0x03', timestamp: 2000 },
        markets: [],
      } satisfies ResolvedRewardRange;
      const service = new MerklAirdropExportService();
      const user = ethers.getAddress(
        '0x00000000000000000000000000000000000000c3',
      );
      const [file] = service.export({
        version: CompoundVersion.V2,
        ranges: [range],
        userTotals: [
          {
            version: CompoundVersion.V2,
            network: 'mainnet',
            chainId: 1,
            range,
            rewardToken: '0x00000000000000000000000000000000000000b2',
            rewardTokenSymbol: 'COMP',
            rewardTokenDecimals: 18,
            user,
            earnedRaw: 15n,
            claimedRaw: 5n,
            remainingRaw: 100n,
            remainingForPeriodRaw: 15n,
          },
        ],
        rows: [
          {
            version: CompoundVersion.V2,
            network: 'mainnet',
            chainId: 1,
            range,
            market: '0x00000000000000000000000000000000000000a1',
            marketSymbol: 'cTEST',
            rewardToken: '0x00000000000000000000000000000000000000b2',
            rewardTokenSymbol: 'COMP',
            rewardTokenDecimals: 18,
            user,
            supplyRewardRaw: 10n,
            borrowRewardRaw: 5n,
            totalRewardRaw: 15n,
          },
        ],
      });

      expect(file).toBeDefined();
      expect(file!.merklPath).toContain(join(temp, 'result'));
      expect(file!.auditPath).toContain(join(temp, 'result'));
      const merkl = JSON.parse(readFileSync(file!.merklPath, 'utf8'));
      const token = ethers.getAddress(
        '0x00000000000000000000000000000000000000b2',
      );
      const market = ethers.getAddress(
        '0x00000000000000000000000000000000000000a1',
      );
      expect(merkl.rewardToken).toBe(token);
      expect(merkl.rewards).toEqual({
        [user]: {
          'compound-v2': '100',
        },
      });

      const audit = JSON.parse(readFileSync(file!.auditPath, 'utf8'));
      expect(audit.allocationMode).toBe('remaining');
      expect(audit.allocationTotalRaw).toBe('100');
      expect(audit.marketTotals[0].earnedRaw).toBe('15');
      expect(audit.marketTotals[0].range.start.blockNumber).toBe(100);
      expect(audit.total).toEqual({
        earnedRaw: '15',
        earned: '0.000000000000000015',
        claimedRaw: '5',
        claimed: '0.000000000000000005',
        remainingRaw: '100',
        remaining: '0.0000000000000001',
        remainingForPeriodRaw: '15',
        remainingForPeriod: '0.000000000000000015',
      });
      expect(audit.fundingRequiredRaw).toBe('101');
      expect(audit).not.toHaveProperty('schemaVersion');
      expect(audit).not.toHaveProperty('merklFeeRate');
      expect(audit).not.toHaveProperty('merklFeeRaw');
    } finally {
      process.chdir(originalCwd);
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('writes the effective V3 start range for each market to the audit', () => {
    const temp = mkdtempSync(join(tmpdir(), 'compound-merkl-'));
    const originalCwd = process.cwd();
    process.chdir(temp);
    try {
      const market = ethers.getAddress(
        '0x00000000000000000000000000000000000000a1',
      );
      const marketRange = {
        symbol: 'cTESTv3',
        address: market,
        startBoundary: { number: 99, hash: '0x11', timestamp: 999 },
        start: { number: 100, hash: '0x12', timestamp: 1000 },
        end: { number: 200, hash: '0x13', timestamp: 2000 },
      };
      const range = {
        network: 'base',
        chainId: 8453,
        config: {} as any,
        startBoundary: { number: 49, hash: '0x01', timestamp: 499 },
        start: { number: 50, hash: '0x02', timestamp: 500 },
        end: marketRange.end,
        markets: [marketRange],
      } satisfies ResolvedRewardRange;
      const service = new MerklAirdropExportService();
      const user = ethers.getAddress(
        '0x00000000000000000000000000000000000000c3',
      );
      const rewardToken = ethers.getAddress(
        '0x00000000000000000000000000000000000000b2',
      );
      const [file] = service.export(
        {
          version: CompoundVersion.V3,
          ranges: [range],
          userTotals: [
            {
              version: CompoundVersion.V3,
              network: 'base',
              chainId: 8453,
              range,
              rewardToken,
              rewardTokenSymbol: 'COMP',
              rewardTokenDecimals: 18,
              user,
              earnedRaw: 7n,
              claimedRaw: 2n,
              remainingRaw: 10n,
              remainingForPeriodRaw: 7n,
            },
          ],
          rows: [
            {
              version: CompoundVersion.V3,
              network: 'base',
              chainId: 8453,
              range,
              marketRange,
              market,
              marketSymbol: 'cTESTv3',
              rewardToken,
              rewardTokenSymbol: 'COMP',
              rewardTokenDecimals: 18,
              user,
              totalRewardRaw: 7n,
              claimedRaw: 2n,
              remainingRaw: 10n,
              remainingForPeriodRaw: 7n,
            },
          ],
        },
        { period: true },
      );

      const merkl = JSON.parse(readFileSync(file!.merklPath, 'utf8'));
      expect(merkl.rewards).toEqual({
        [user]: {
          [`compound-v3:${market}`]: '7',
        },
      });
      const audit = JSON.parse(readFileSync(file!.auditPath, 'utf8'));
      expect(audit.allocationMode).toBe('period');
      expect(audit.range.start.blockNumber).toBe(50);
      expect(audit.marketTotals[0].range.start.blockNumber).toBe(100);
      expect(audit.marketTotals[0].earnedRaw).toBe('7');
      expect(audit.marketTotals[0].remainingForPeriodRaw).toBe('7');
      expect(audit.marketTotals[0]).not.toHaveProperty('totalRewardRaw');
      expect(audit.recipients[0].markets[0].range.start.blockNumber).toBe(100);
      expect(audit.total).toEqual({
        earnedRaw: '7',
        earned: '0.000000000000000007',
        claimedRaw: '2',
        claimed: '0.000000000000000002',
        remainingRaw: '10',
        remaining: '0.00000000000000001',
        remainingForPeriodRaw: '7',
        remainingForPeriod: '0.000000000000000007',
      });
      expect(audit.recipients[0]).toEqual(
        expect.objectContaining({
          earnedRaw: '7',
          claimedRaw: '2',
          remainingRaw: '10',
          remainingForPeriodRaw: '7',
        }),
      );
      expect(audit.allocationTotalRaw).toBe('7');
    } finally {
      process.chdir(originalCwd);
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('marks a filtered V2 market export as partial', () => {
    const temp = mkdtempSync(join(tmpdir(), 'compound-merkl-'));
    const originalCwd = process.cwd();
    process.chdir(temp);
    try {
      const market = ethers.getAddress(
        '0x00000000000000000000000000000000000000a1',
      );
      const marketRange = {
        symbol: 'cTEST',
        address: market,
        startBoundary: { number: 99, hash: '0x01', timestamp: 999 },
        start: { number: 100, hash: '0x02', timestamp: 1000 },
        end: { number: 200, hash: '0x03', timestamp: 2000 },
      };
      const range = {
        network: 'mainnet',
        chainId: 1,
        config: {} as any,
        startBoundary: marketRange.startBoundary,
        start: marketRange.start,
        end: marketRange.end,
        markets: [marketRange],
      } satisfies ResolvedRewardRange;
      const service = new MerklAirdropExportService();
      const user = ethers.getAddress(
        '0x00000000000000000000000000000000000000c3',
      );
      const [file] = service.export({
        version: CompoundVersion.V2,
        ranges: [range],
        userTotals: [
          {
            version: CompoundVersion.V2,
            network: 'mainnet',
            chainId: 1,
            range,
            rewardToken: '0x00000000000000000000000000000000000000b2',
            rewardTokenSymbol: 'COMP',
            rewardTokenDecimals: 18,
            user,
            earnedRaw: 1n,
            claimedRaw: null,
            remainingRaw: 1n,
            remainingForPeriodRaw: 1n,
          },
        ],
        rows: [
          {
            version: CompoundVersion.V2,
            network: 'mainnet',
            chainId: 1,
            range,
            marketRange,
            market,
            marketSymbol: 'cTEST',
            rewardToken: '0x00000000000000000000000000000000000000b2',
            rewardTokenSymbol: 'COMP',
            rewardTokenDecimals: 18,
            user,
            supplyRewardRaw: 1n,
            borrowRewardRaw: 0n,
            totalRewardRaw: 1n,
          },
        ],
      });

      expect(file!.merklPath).toContain('.partial.merkl.json');
      const merkl = JSON.parse(readFileSync(file!.merklPath, 'utf8'));
      expect(Object.keys(merkl)).toEqual(['rewardToken', 'rewards']);
      const audit = JSON.parse(readFileSync(file!.auditPath, 'utf8'));
      expect(audit.partial).toBe(true);
      expect(audit.total.claimedRaw).toBeNull();
      expect(audit.selectedMarkets).toEqual([
        { symbol: 'cTEST', address: market },
      ]);
    } finally {
      process.chdir(originalCwd);
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
