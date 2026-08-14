import { Module } from '@nestjs/common';
import { GithubModule } from 'github/github.module';
import { ContractModule } from 'contract/contract.module';
import { JsonModule } from 'json/json.module';
import { NetworkModule } from 'network/network.module';
import { IndexerModule } from 'indexer/indexer.module';
import { MarkdownService } from './markdown.service';
import { GenerateMarkdownCommand } from './generate-markdown.command';
import { GenerateOwesV3Command } from './generate-owes-v3.command';
import { GenerateOwesV2Command } from './generate-owes-v2.command';
import { GenerateOwesMarkdown } from './generate-owes-md.command';
import { OwesExportService } from './owes-export.service';
import { HistoricalCallService } from './historical-call.service';
import { RangesService } from './ranges.service';
import { V2PeriodRewardsService } from './v2-period-rewards.service';
import { V3PeriodRewardsService } from './v3-period-rewards.service';
import { MerklAirdropExportService } from './merkl-airdrop-export.service';
import { GenerateRewardsV2MerklCommand } from './generate-rewards-v2-merkl.command';
import { GenerateRewardsV3MerklCommand } from './generate-rewards-v3-merkl.command';

@Module({
  imports: [
    GithubModule,
    ContractModule,
    JsonModule,
    NetworkModule,
    IndexerModule,
  ],
  providers: [
    MarkdownService,
    OwesExportService,
    GenerateMarkdownCommand,
    GenerateOwesV2Command,
    GenerateOwesV3Command,
    GenerateOwesMarkdown,
    HistoricalCallService,
    RangesService,
    V2PeriodRewardsService,
    V3PeriodRewardsService,
    MerklAirdropExportService,
    GenerateRewardsV2MerklCommand,
    GenerateRewardsV3MerklCommand,
  ],
  exports: [MarkdownService],
})
export class GenerationModule {}
