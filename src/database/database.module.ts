import { Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { databaseConfig } from 'src/config/database.config';
import { SubscribedSymbolEntity } from './entities/subscribed-symbol.entity';
import { SubscribedSymbolsService } from './subscribedSymbols.service';
import { DatabaseController } from './database.controller';

@Module({
  imports: [
    TypeOrmModule.forRoot(databaseConfig),
    TypeOrmModule.forFeature([SubscribedSymbolEntity]),
  ],
  providers: [DatabaseService, SubscribedSymbolsService],
  exports: [SubscribedSymbolsService],
  controllers: [DatabaseController],
})
export class DatabaseModule {}
