import { Module } from '@nestjs/common';
import { StrategyService } from './strategy.service';

@Module({
  providers: [StrategyService],
   exports: [StrategyService], // 👈 IMPORTANT (used by WebSocket module)
})
export class StrategyModule {}
