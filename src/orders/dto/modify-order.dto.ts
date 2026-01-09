import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  ValidateIf,
} from 'class-validator';

export class ModifyOrderDto {
  @IsString()
  orderno: string;

  @IsString()
  exchange: string;

  @IsString()
  tradingsymbol: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  newquantity?: number;

  @IsOptional()
  @IsEnum(['LMT', 'MKT', 'SL-LMT', 'SL-MKT'])
  newprice_type?: 'LMT' | 'MKT' | 'SL-LMT' | 'SL-MKT';

  @ValidateIf((o) => o.newprice_type === 'LMT' || o.newprice_type === 'SL-LMT')
  @IsNumber()
  @IsPositive()
  newprice?: number;

  @ValidateIf(
    (o) => o.newprice_type === 'SL-LMT' || o.newprice_type === 'SL-MKT',
  )
  @IsNumber()
  @IsPositive()
  newtrigger_price?: number;

  @IsOptional()
  @IsEnum(['YES', 'NO'])
  amo?: 'YES' | 'NO';
}
