import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TradingViewWebhookDto } from '../dto/tradingview-webhook.dto';
import { MarketService } from './../../market/market.service';
import { OrdersService } from 'src/orders/orders.service';
import { StrategyResult } from '../interfaces/strategy-result.interface';

@Injectable() // 🔴 REQUIRED
export class TradingViewStrategy {
  private readonly logger = new Logger(TradingViewStrategy.name);
  private tradeVolume = 1;

  constructor(
    private readonly marketService: MarketService,
    private readonly orderService: OrdersService,
  ) {}
  async execute(payload: TradingViewWebhookDto): Promise<void> {
    this.logger.log(
      `📩 TradingView Signal Received: ${JSON.stringify(payload)}`,
    );

    try {
      // ===============================
      // 1️⃣ Get Security Info
      // ===============================
      const securityInfo = await this.marketService
        .getSecurityInfo({
          exchange: payload.exchange,
          token: payload.token,
        })
        .catch((err) => {
          this.logger.error('❌ getSecurityInfo failed', err?.message || err);
          return null; // ⛔ do not stop strategy
        });

      if (!securityInfo) {
        this.logger.warn(
          `⚠️ Security not found: ${payload.exchange}:${payload.token}`,
        );
        return; // stop strategy execution safely
      }

      this.logger.log(
        `✅ Security validated: ${securityInfo.symbol ?? payload.symbol}`,
      );

      // ===============================
      // 2️⃣ Get Latest Quote
      // ===============================
      const quotes = await this.marketService
        .getQuotes({
          exch: payload.exchange,
          token: payload.token,
        })
        .catch((err) => {
          this.logger.error('❌ getQuotes failed', err?.message || err);
          return null;
        });

      if (!quotes) {
        this.logger.warn('⚠️ Quotes not available');
        return;
      }

      // ===============================
      // 3️⃣ Get Net Positions (SAFE)
      // ===============================
      const netPositions = await this.orderService
        .getNetPositions()
        .catch((err) => {
          const safeMessage =
            typeof err === 'string'
              ? err
              : err?.message || 'Net position fetch failed';

          this.logger.error('❌ getNetPositions failed', safeMessage);

          return null; // ⛔ do not crash strategy
        });

      if (!netPositions) {
        this.logger.warn('⚠️ Net positions unavailable, skipping trade logic');
        return;
      }

      this.logger.debug(`📊 Net Positions: ${JSON.stringify(netPositions)}`);

      // ===============================
      // 🔮 4️⃣ Trading Logic (placeholder)
      // ===============================
      // - check existing position
      // - decide BUY / SELL / EXIT
      // - place order
      // - track order

      this.logger.log('🚀 Strategy execution completed successfully');
    } catch (err) {
      // 🔒 Absolute safety net (should never hit)
      const safeMessage =
        typeof err === 'string'
          ? err
          : err?.message || 'Unknown strategy error';

      this.logger.error(
        '🔥 Strategy execution failed unexpectedly',
        safeMessage,
      );
    }
  }
}
