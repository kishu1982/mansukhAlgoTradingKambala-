export class TradingViewWebhookDto {
  exchange: string;
  symbol: string;
  token?: string;

  side: 'BUY' | 'SELL';
  price?: number;

  time?: string;
  interval?: string;
  strategy?: string;

  secret: string;

  // Allow extra TradingView variables
  [key: string]: any;
}
