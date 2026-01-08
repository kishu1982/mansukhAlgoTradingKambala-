import { Module } from '@nestjs/common';
import { WebsocketService } from './websocket.service';
import { TokenModule } from 'src/token/token.module';

@Module({
  imports: [TokenModule],
  providers: [WebsocketService],
  exports: [WebsocketService],
})
export class WebsocketModule {}
