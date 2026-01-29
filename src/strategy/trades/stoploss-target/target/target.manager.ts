import { OrdersService } from 'src/orders/orders.service';
import { ConfigService } from '@nestjs/config';
import {
  appendTargetTrack,
  readTargetTrack,
  isTradeAlreadyClosed,
} from './target.helpers';

export class TargetManager {
  private readonly TARGET_PERCENT: number;

  constructor(
    private readonly ordersService: OrdersService,
    private readonly config: ConfigService,
  ) {
    const raw = this.config.get<string>('TARGET_FIRST_PERCENT', '0.25');
    const value = Number(raw);
    this.TARGET_PERCENT = value > 1 ? value / 100 : value;
  }

  async checkAndProcessTarget({
    tick,
    netPosition,
    tradeBook,
    instrument,
  }: {
    tick: { tk: string; e: string; lp: number };
    netPosition: any;
    tradeBook: any[];
    instrument: any;
  }) {
    const token = tick.tk;
    const ltp = tick.lp;

    const track = readTargetTrack(token);
    if (isTradeAlreadyClosed(track)) {
      appendTargetTrack(token, {
        action: 'SKIPPED',
        reason: 'TRADE_ALREADY_CLOSED',
      });
      return;
    }

    // latest trade by exch_tm
    const trades = tradeBook
      .filter((t) => t.token === token && t.exch === tick.e)
      .sort(
        (a, b) => new Date(b.exch_tm).getTime() - new Date(a.exch_tm).getTime(),
      );

    if (!trades.length) return;

    const lastTrade = trades[0];
    const entryPrice = Number(lastTrade.price);

    const netQty = Math.abs(Number(netPosition.netqty));
    if (netQty <= 0) return;

    const side = Number(netPosition.netqty) > 0 ? 'BUY' : 'SELL';

    const targetPrice =
      side === 'BUY'
        ? entryPrice * (1 + this.TARGET_PERCENT)
        : entryPrice * (1 - this.TARGET_PERCENT);

    const targetHit = side === 'BUY' ? ltp >= targetPrice : ltp <= targetPrice;

    if (!targetHit) return;

    // 🛑 quantity rule
    if (netQty <= instrument.lotSize) {
      appendTargetTrack(token, {
        action: 'TARGET_HIT_NOT_CLOSED',
        reason: 'NET_QTY_NOT_MORE_THAN_1_LOT',
        entryPrice,
        targetPrice,
        netQty,
      });
      return;
    }

    // ✅ close 50% only
    const closeQty = Math.floor(netQty / 2);

    await this.ordersService.placeOrder({
      buy_or_sell: side === 'BUY' ? 'S' : 'B',
      product_type: netPosition.prd,
      exchange: tick.e,
      tradingsymbol: instrument.tradingSymbol,
      quantity: closeQty,
      price_type: 'MKT',
      retention: 'DAY',
      remarks: 'AUTO_TARGET_50_PERCENT',
    });

    appendTargetTrack(token, {
      action: 'TARGET_BOOKED_50_PERCENT',
      entryPrice,
      targetPrice,
      netQty,
      closeQty,
    });
  }
}
