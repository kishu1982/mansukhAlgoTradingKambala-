import { Type } from 'class-transformer';
import {
  IsEnum,
  isNotEmpty,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { TradeLegDto } from './tarde-leg.dto';

export class CreateTradeConfigDto {
  @IsString()
  @IsNotEmpty()
  strategyName: string;

  @IsString()
  @IsNotEmpty()
  tokenNumber: string;

  @IsString()
  @IsNotEmpty()
  exchange: string;

  // ✅ NEW
  @IsString()
  @IsNotEmpty()
  symbolName: string;

  @IsNumber()
  @IsNotEmpty()
  quantityLots: number;

  @IsEnum(['BUY', 'SELL'])
  @IsNotEmpty()
  side: 'BUY' | 'SELL';

  @IsEnum(['INTRADAY', 'NORMAL', 'DELIVERY'])
  @IsNotEmpty()
  productType: 'INTRADAY' | 'NORMAL' | 'DELIVERY';

  @IsNumber()
  @Min(1)
  @IsNotEmpty()
  legs: number;

  @IsEnum(['ACTIVE', 'INACTIVE'])
  signalStatus: 'ACTIVE' | 'INACTIVE';

  // ✅ ONLY REQUIRED WHEN legs > 1
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => TradeLegDto)
  toBeTradedOn?: TradeLegDto[];
}
