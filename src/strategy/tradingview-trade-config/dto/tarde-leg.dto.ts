import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class TradeLegDto {
  @IsString()
  tokenNumber: string;

  @IsString()
  exchange: string;

  @IsNumber()
  @Min(0, { message: 'quantityLots cannot be negative' })
  quantityLots: number;

  @IsString()
  @IsOptional()
  symbolName?: string;

  @IsEnum(['BUY', 'SELL'])
  side: 'BUY' | 'SELL';
}
