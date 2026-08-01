import { Logger } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';

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

  public async run(): Promise<void> {
    this.logger.log('Generating strict V3 Merkl airdrop files...');
    await this.db.assemble();
    try {
      const ranges = await this.ranges.load(CompoundVersion.V3);
      const result = await this.rewards.calculate(ranges);
      this.merkl.export(result);
      this.logger.log('V3 Merkl generation completed.');
    } finally {
      this.db.closeRuntime();
    }
  }
}
