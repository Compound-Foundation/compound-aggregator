import { Logger } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';

import { DEFAULT_BLOCK_STEP, IndexerService } from 'indexer/indexer.service';

@Command({ name: 'index', description: 'Index networks' })
export class IndexCommand extends CommandRunner {
  private readonly logger = new Logger(IndexCommand.name);

  constructor(private readonly indexer: IndexerService) {
    super();
  }

  async run(_passedParams: string[], options?: Record<string, unknown>) {
    const blockStep = options?.BLOCK_STEP as number | undefined;
    try {
      this.logger.log(
        `Start indexing... (blockStep=${blockStep ?? DEFAULT_BLOCK_STEP})`,
      );
      await this.indexer.run({ blockStep });
      this.logger.log('Indexing completed.');
      return;
    } catch (error) {
      this.logger.error('An error occurred while indexing:', error);
      return;
    }
  }

  @Option({
    flags: '--BLOCK_STEP <blocks>',
    description: `Blocks per indexing step (default: ${DEFAULT_BLOCK_STEP})`,
  })
  public parseBlockStepOption(value: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `--BLOCK_STEP must be a positive integer, got "${value}"`,
      );
    }
    return parsed;
  }
}
