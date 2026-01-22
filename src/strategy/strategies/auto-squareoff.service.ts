import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrdersService } from 'src/orders/orders.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AutoSquareOffService {
  private readonly logger = new Logger(AutoSquareOffService.name);

  /**
   * ⏰ CONFIGURABLE IST TIMES
   * Format: HH:mm (24-hour)
   */
  private readonly SQUARE_OFF_START_TIME = '15:25';
  private readonly SQUARE_OFF_END_TIME?: string = '16:00'; // ⬅ optional (set undefined to disable)
  private activateAutoSquareOff = true;

  /*
private readonly SQUARE_OFF_START_TIME = '15:25';
private readonly SQUARE_OFF_END_TIME = undefined; // in case given undefined then will keep on checking

  */

  constructor(
    private readonly orderService: OrdersService,
    private readonly ConfigService: ConfigService,
  ) {
    this.activateAutoSquareOff =
      this.ConfigService.get<string>('ACTIVATE_AUTO_SQUARE_OFF', 'false') ===
      'true';
  }

  // =====================================================
  // 🔹 IST TIME HELPERS (SERVER SAFE)
  // =====================================================

  private getISTDate(): Date {
    return new Date(
      new Date().toLocaleString('en-US', {
        timeZone: 'Asia/Kolkata',
      }),
    );
  }

  private parseTime(time: string): { hour: number; minute: number } {
    const [hour, minute] = time.split(':').map(Number);
    return { hour, minute };
  }

  private isWithinSquareOffWindow(): boolean {
    const istNow = this.getISTDate();
    const h = istNow.getHours();
    const m = istNow.getMinutes();

    const start = this.parseTime(this.SQUARE_OFF_START_TIME);
    const end = this.SQUARE_OFF_END_TIME
      ? this.parseTime(this.SQUARE_OFF_END_TIME)
      : null;

    // ⛔ Before start time
    if (h < start.hour || (h === start.hour && m < start.minute)) {
      return false;
    }

    // ✅ No end time → keep checking after start
    if (!end) {
      return true;
    }

    // ⛔ After end time
    if (h > end.hour || (h === end.hour && m > end.minute)) {
      return false;
    }

    return true;
  }

  // =====================================================
  // 🔹 AUTO SQUARE-OFF (EVERY MINUTE)
  // =====================================================

  @Cron('0 */1 * * * *', { timeZone: 'Asia/Kolkata' })
  async autoSquareOff(): Promise<void> {
    if (!this.activateAutoSquareOff) {
      this.logger.log('Auto Square-Off is deactivated. Skipping check.');
      return;
    }
    if (!this.isWithinSquareOffWindow()) return;

    this.logger.log(
      `⏰ Auto Square-Off Window Active (${this.SQUARE_OFF_START_TIME} → ${
        this.SQUARE_OFF_END_TIME ?? '∞'
      } IST)`,
    );

    try {
      const netPositions = await this.orderService.getNetPositions();

      if (!netPositions?.data || !Array.isArray(netPositions.data)) {
        this.logger.warn('⚠️ No net positions found');
        return;
      }

      for (const pos of netPositions.data) {
        const netQty = Number(pos.netqty);

        if (!netQty || netQty === 0) continue;

        const closeSide = netQty > 0 ? 'SELL' : 'BUY';
        const closeQty = Math.abs(netQty);

        this.logger.log(
          `🔁 Square-Off → ${pos.symname} | ${closeSide} ${closeQty}`,
        );

        await this.orderService.placeOrder({
          buy_or_sell: closeSide === 'BUY' ? 'B' : 'S',
          product_type: 'I',
          exchange: pos.exch,
          tradingsymbol: pos.symname,
          quantity: closeQty,
          price_type: 'MKT',
          price: 0,
          trigger_price: 0,
          discloseqty: 0,
          retention: 'DAY',
          amo: 'NO',
          remarks: `AUTO SQUARE-OFF ${this.SQUARE_OFF_START_TIME}-${
            this.SQUARE_OFF_END_TIME ?? '∞'
          } IST`,
        });
      }

      this.logger.log('✅ Auto square-off cycle completed');
    } catch (err) {
      this.logger.error('❌ Auto square-off failed', err?.message || err);
    }
  }
}
