import { IsEnum, IsNumber, IsString, Min } from 'class-validator';

export class TradeLegDto {
  @IsString()
  tokenNumber: string;

  @IsString()
  exchange: string;

  @IsNumber()
  @Min(1)
  quantityLots: number;

  @IsEnum(['BUY', 'SELL'])
  side: 'BUY' | 'SELL';
}
