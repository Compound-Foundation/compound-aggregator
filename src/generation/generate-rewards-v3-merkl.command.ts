import { Logger } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';

import { CompoundVersion } from 'common/types/compound-version';
import { RuntimeDbService } from 'indexer/runtime-db.service';
import { MerklAirdropExportService } from './merkl-airdrop-export.service';
import { RangesService } from './ranges.service';
import { V3PeriodRewardsService } from './v3-period-rewards.service';

@Command({
  name: 'rewards:generate-v3-merkl',
  description: 'Generate strict Compound V3 period rewards for Merkl',
})
export class GenerateRewardsV3MerklCommand extends CommandRunner {
  private readonly logger = new Logger(GenerateRewardsV3MerklCommand.name);

  constructor(
    private readonly ranges: RangesService,
    private readonly db: RuntimeDbService,
    private readonly rewards: V3PeriodRewardsService,
    private readonly merkl: MerklAirdropExportService,
  ) {
    super();
  }

  public async run(
    _passedParams: string[],
    options?: Record<string, unknown>,
  ): Promise<void> {
    const useTestRanges = options?.test === true;
    const periodOnly = options?.period === true;
    this.logger.log(
      `Generating strict V3 Merkl airdrop files using ${
        useTestRanges ? 'ranges-test.json' : 'ranges.json'
      }, allocation=${periodOnly ? 'remainingForPeriod' : 'remaining'}...`,
    );
    await this.db.assemble();
    try {
      const ranges = await this.ranges.load(CompoundVersion.V3, useTestRanges);
      const result = await this.rewards.calculate(ranges);
      await this.merkl.export(result, { period: periodOnly });
      this.logger.log('V3 Merkl generation completed.');
    } finally {
      this.db.closeRuntime();
    }
  }

  @Option({
    flags: '--test',
    description: 'Use ./ranges-test.json instead of ./ranges.json',
  })
  public parseTestOption(): boolean {
    return true;
  }

  @Option({
    flags: '--period',
    description: 'Allocate remainingForPeriod instead of full remaining',
  })
  public parsePeriodOption(): boolean {
    return true;
  }
}
