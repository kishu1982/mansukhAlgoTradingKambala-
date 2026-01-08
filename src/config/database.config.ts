import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import * as dotenv from 'dotenv';

dotenv.config();

export const databaseConfig: TypeOrmModuleOptions = {
  type: 'mongodb',
  url: process.env.MONGO_URI,
  database: process.env.MONGO_DB_NAME,

  autoLoadEntities: true,
  synchronize: false,

  logging: ['error'],
};
