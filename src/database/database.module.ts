import { Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { databaseConfig } from 'src/config/database.config';

@Module({
  imports: [TypeOrmModule.forRoot(databaseConfig)],
  providers: [DatabaseService],
})
export class DatabaseModule {}
