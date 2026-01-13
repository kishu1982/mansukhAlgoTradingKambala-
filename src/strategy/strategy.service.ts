import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { TradingViewStrategy } from './strategies/tradingview.strategy';
import { TradingViewWebhookDto } from './dto/tradingview-webhook.dto';
import { TradingViewSignalService } from 'src/database/services/tradingview-signal.service';

@Injectable()
export class StrategyService {
  private readonly logger = new Logger(StrategyService.name);
  private readonly TRADINGVIEW_SECRET =
    process.env.TRADINGVIEW_SECRET || 'tv_secret_123';
  constructor(
    private readonly tradingViewStrategy: TradingViewStrategy,
    private readonly tradingViewSignalService: TradingViewSignalService,
  ) {}

  // to get data from webhook . pass it to trading view service also save it to database
  async handleTradingViewWebhook(payload: TradingViewWebhookDto) {
    if (payload.secret !== this.TRADINGVIEW_SECRET) {
      // throw new UnauthorizedException('Invalid TradingView secret');
      this.logger.log('Invalid TradingView secret');
      //throw new UnauthorizedException('invalid secret key recived from tradingview signal');
      return {
        success: false,
        message: 'invalid secret key received from TradingView signal',
      }; // Missing colon, inconsistent format
    }

    // 1️⃣ Save in DB (Database module)
    await this.tradingViewSignalService.saveSignal({
      exchange: payload.exchange,
      symbol: payload.symbol,
      token: payload.token,
      side: payload.side,
      price: Number(payload.price),
      interval: payload.interval,
      strategy: payload.strategy,
      rawPayload: payload,
    });
    // console.log('data recived for tv signal: ', payload);
    // 2️⃣ Run strategy logic
    this.tradingViewStrategy.execute(payload);
  }

  /**
   * Called for every tick coming from WebSocket
   */
  onTick(tickData: any): void {
    // Raw tick logging
    //this.logger.log(`Tick Received: ${JSON.stringify(tickData)}`);
    //tickData.tk==='2885'? this.logger.log(`Tick Received: ${JSON.stringify(tickData.lp)}`):"";
    // tickData.lp > 0 || tickData.bp1 > 0 || tickData.sp1 > 0
    //   ? console.log('tick data : ', tickData.ltp)
    //   : '';
    // Later you can route to strategies:
    // this.runScalpingStrategy(tickData);
    // this.runVWAPStrategy(tickData);
  }

  // Example placeholder strategy
  private runScalpingStrategy(tick: any) {
    // logic here
  }
}
