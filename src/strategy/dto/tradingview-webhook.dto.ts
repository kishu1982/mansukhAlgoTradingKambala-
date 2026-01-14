import {
  IsString,
  IsOptional,
  IsNumber,
  IsIn,
  IsNotEmpty,
} from 'class-validator';

export class TradingViewWebhookDto {
  @IsNotEmpty()
  @IsString()
  exchange: string;

  @IsNotEmpty()
  @IsString()
  symbol: string;

  @IsNotEmpty()
  @IsString()
  token: string;

  @IsNotEmpty()
  @IsIn(['BUY', 'SELL'])
  side: 'BUY' | 'SELL';

  @IsOptional()
  @IsNumber()
  price?: number;

  @IsOptional()
  @IsNumber()
  volume?: number; // ✅ NEW

  @IsOptional()
  @IsString()
  time?: string;

  @IsOptional()
  @IsString()
  interval?: string;

  @IsNotEmpty()
  @IsString()
  strategy?: string;

  @IsString()
  secret: string;
}
