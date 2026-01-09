import { Module } from '@nestjs/common';
import { StrategyService } from './strategy.service';
import { TradingViewController } from './controllers/tradingview.controller';
import { TradingViewStrategy } from './strategies/tradingview.strategy';
import { DatabaseModule } from 'src/database/database.module';

@Module({
  imports:[DatabaseModule],
  controllers: [TradingViewController],
  providers: [StrategyService,  TradingViewStrategy] ,// 🔴 REQUIRED],
  exports: [StrategyService], // 👈 IMPORTANT (used by WebSocket module)
})
export class StrategyModule {}
