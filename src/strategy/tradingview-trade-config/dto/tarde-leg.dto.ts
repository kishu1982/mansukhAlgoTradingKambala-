import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class TradeLegDto {
  @IsString()
  tokenNumber: string;

  @IsString()
  exchange: string;

  @IsNumber()
  quantityLots: number;

  @IsString()
  @IsOptional()
  symbolName?: string;

  @IsEnum(['BUY', 'SELL'])
  side: 'BUY' | 'SELL';
}
