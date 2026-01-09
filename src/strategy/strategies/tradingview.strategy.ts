import { Injectable, Logger } from '@nestjs/common';
import { TradingViewWebhookDto } from '../dto/tradingview-webhook.dto';

@Injectable() // 🔴 REQUIRED
export class TradingViewStrategy {
  private readonly logger = new Logger(TradingViewStrategy.name);

  execute(payload: TradingViewWebhookDto): void {
    this.logger.log(`TradingView Signal Received: ${JSON.stringify(payload)}`);

    /**
     * ✅ Typical next steps:
     * - Validate symbol/token
     * - Check market hours
     * - Check open positions
     * - Place order
     */
  }
}
