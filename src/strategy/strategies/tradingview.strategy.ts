import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TradingViewWebhookDto } from '../dto/tradingview-webhook.dto';

@Injectable() // 🔴 REQUIRED
export class TradingViewStrategy {
  private readonly logger = new Logger(TradingViewStrategy.name);

  execute(payload: TradingViewWebhookDto): void {
    this.logger.log(`TradingView Signal Received: ${JSON.stringify(payload)}`);

    if (!payload.token) {
      this.logger.log('Token number of Symbol is missing for placing trade');
    }
    //signal must have token number for symbol to place exact trade in

    // logic to do. once signal recived from trading view

    // get symbol information (token and symbol to be traded on )

    // check if symbol already has position (from net position)

    // place trade. as per received signal
    // if if position opened and order id status changed to closed/complete (if not save error)

    // if signal is close position signal
    // check net position of selected symbol.
    // close OR exit trade logic

    /**
     * ✅ Typical next steps:
     * - Validate symbol/token
     * - Check market hours
     * - Check open positions
     * - Place order
     */
  }
}
