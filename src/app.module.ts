import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { NorenModule } from './noren/noren.module';
import { OrdersModule } from './orders/orders.module';
import { MarketModule } from './market/market.module';
import { ConfigModule } from '@nestjs/config';
import { TokenModule } from './token/token.module';
import { WebsocketModule } from './websocket/websocket.module';

@Module({
  imports: [AuthModule, NorenModule, OrdersModule, MarketModule, ConfigModule.forRoot({ isGlobal: true }), TokenModule, WebsocketModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
