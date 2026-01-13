import {
  IsString,
  IsOptional,
  IsNumber,
  IsIn,
  IsNotEmpty,
} from 'class-validator';

export class TradingViewWebhookDto {
  @IsNotEmpty({ message: 'Exchange Code is required (NSE/NFO/MCX/BSE)' })
  @IsString()
  exchange: string;

  @IsNotEmpty({ message: 'Symbol name is required (e.g RELIANCE / NIFTY)' })
  @IsString()
  symbol: string;

  @IsNotEmpty({ message: 'Token number is required' })
  @IsString()
  token: string;

  @IsNotEmpty({ message: 'Side to trade is required ( `BUY`,`SELL`)' })
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

  @IsNotEmpty({ message: 'Strategy name is required' })
  @IsString()
  strategy?: string;

  @IsString()
  secret: string;
}
