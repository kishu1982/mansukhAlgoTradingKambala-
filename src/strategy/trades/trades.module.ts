import { Module } from '@nestjs/common';
import { TradesService } from './trades.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FinalTradeToBePlacedEntity } from './entities/final-trade-to-be-placed.entity';
import { TradesController } from './trades.controller';
import { TradesExecutionService } from './trades-execution.service';
import { MarketModule } from 'src/market/market.module';
import { OrdersModule } from 'src/orders/orders.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([FinalTradeToBePlacedEntity]),
    MarketModule, // ✅ ADD THIS
    OrdersModule, // ✅ ADD THIS
  ],
  providers: [TradesService, TradesExecutionService],
  exports: [TradesService, TradesExecutionService],
  controllers: [TradesController],
})
export class TradesModule {}
