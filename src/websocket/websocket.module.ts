import { Module } from '@nestjs/common';
import { WebsocketService } from './websocket.service';
import { TokenModule } from 'src/token/token.module';
import { StrategyModule } from 'src/strategy/strategy.module';
import { TradingviewTradeConfigModule } from 'src/strategy/tradingview-trade-config/tradingview-trade-config.module';

@Module({
  imports: [TokenModule, StrategyModule, TradingviewTradeConfigModule],
  providers: [WebsocketService],
  exports: [WebsocketService],
})
export class WebsocketModule {}
