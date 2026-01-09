import { Module } from '@nestjs/common';
import { WebsocketService } from './websocket.service';
import { TokenModule } from 'src/token/token.module';
import { StrategyModule } from 'src/strategy/strategy.module';

@Module({
  imports: [TokenModule, StrategyModule],
  providers: [WebsocketService],
  exports: [WebsocketService],
})
export class WebsocketModule {}
