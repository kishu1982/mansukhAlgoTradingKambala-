import { IsString, IsOptional, IsNumber, IsIn } from 'class-validator';

export class TradingViewWebhookDto {
  @IsString()
  exchange: string;

  @IsString()
  symbol: string;

  @IsOptional()
  @IsString()
  token?: string;

  @IsIn(['BUY', 'SELL'])
  side: 'BUY' | 'SELL';

  @IsOptional()
  @IsNumber()
  price?: number;

  @IsOptional()
  @IsString()
  time?: string;

  @IsOptional()
  @IsString()
  interval?: string;

  @IsOptional()
  @IsString()
  strategy?: string;

  @IsString()
  secret: string;
}
