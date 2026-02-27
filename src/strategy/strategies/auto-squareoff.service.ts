import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrdersService } from 'src/orders/orders.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AutoSquareOffService {
  private readonly logger = new Logger(AutoSquareOffService.name);

  private isRunning = false;
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * ⏰ CONFIGURABLE IST TIMES
   * Format: HH:mm (24-hour)
   */

  /**
   * ⏰ MULTIPLE AUTO SQUARE-OFF WINDOWS (IST)
   * - end optional → if undefined, keeps checking after start
   */
  private readonly SQUARE_OFF_WINDOWS: Array<{
    start: string;
    end?: string;
  }> = [
    { start: '13:25', end: '14:15' },
    { start: '14:55', end: '14:59' },
    { start: '15:14', end: '16:20' },
    // { start: '10:45', end: '10:55' }, // testing
    // { start: '15:25' }, // no end → infinite after start
  ];

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

  private isWithinSquareOffWindow(): {
    active: boolean;
    window?: { start: string; end?: string };
  } {
    const istNow = this.getISTDate();
    const h = istNow.getHours();
    const m = istNow.getMinutes();

    for (const window of this.SQUARE_OFF_WINDOWS) {
      const start = this.parseTime(window.start);
      const end = window.end ? this.parseTime(window.end) : null;

      // ⛔ before start
      if (h < start.hour || (h === start.hour && m < start.minute)) {
        continue;
      }

      // ✅ no end → valid forever after start
      if (!end) {
        return { active: true, window };
      }

      // ⛔ after end
      if (h > end.hour || (h === end.hour && m > end.minute)) {
        continue;
      }

      // ✅ inside window
      return { active: true, window };
    }

    return { active: false };
  }

  // =====================================================
  // 🔹 AUTO SQUARE-OFF (EVERY MINUTE)
  // =====================================================

  @Cron('0 */1 * * * *', { timeZone: 'Asia/Kolkata' })
  async autoSquareOff(): Promise<void> {
    if (!this.activateAutoSquareOff) {
      return;
    }

    // 🚫 Prevent overlapping executions
    if (this.isRunning) {
      this.logger.warn('Auto Square-Off already running. Skipping...');
      return;
    }

    const windowCheck = this.isWithinSquareOffWindow();
    if (!windowCheck.active) return;

    this.isRunning = true;

    this.logger.log(
      `⏰ Auto Square-Off Window Active (${windowCheck.window!.start} → ${
        windowCheck.window!.end ?? '∞'
      } IST)`,
    );

    try {
      let hasOpenPositions = true;

      while (hasOpenPositions) {
        const netPositions = await this.orderService.getNetPositions();

        if (!netPositions?.data || !Array.isArray(netPositions.data)) {
          this.logger.warn('⚠️ No net positions found');
          break;
        }

        hasOpenPositions = false;

        for (const pos of netPositions.data) {
          const netQty = Number(pos.netqty);

          if (!netQty || netQty === 0) continue;

          hasOpenPositions = true; // still positions open

          const closeSide = netQty > 0 ? 'SELL' : 'BUY';
          const closeQty = Math.abs(netQty);

          this.logger.log(
            `🔁 Square-Off → ${pos.tsym} | ${closeSide} ${closeQty}`,
          );

          await this.orderService.placeOrder({
            buy_or_sell: closeSide === 'BUY' ? 'B' : 'S',
            product_type: 'I',
            exchange: pos.exch,
            tradingsymbol: pos.tsym,
            quantity: closeQty,
            price_type: 'MKT',
            price: 0,
            trigger_price: 0,
            discloseqty: 0,
            retention: 'DAY',
            amo: 'NO',
            remarks: `AUTO SQUARE-OFF ${windowCheck.window!.start}-${
              windowCheck.window!.end ?? '∞'
            } IST`,
          });

          // ⏳ wait 2 seconds before next order
          await this.sleep(2000);
        }

        // ⏳ Wait before re-checking positions
        if (hasOpenPositions) {
          this.logger.log('🔄 Re-checking net positions...');
          await this.sleep(4000); // wait for exchange update
        }
      }

      this.logger.log('✅ All positions squared off successfully');
    } catch (err) {
      this.logger.error('❌ Auto square-off failed', err?.message || err);
    } finally {
      this.isRunning = false; // 🔓 release lock
    }
  }

  // @Cron('0 */1 * * * *', { timeZone: 'Asia/Kolkata' })
  // async autoSquareOff(): Promise<void> {
  //   if (!this.activateAutoSquareOff) {
  //     this.logger.log('Auto Square-Off is deactivated. Skipping check.');
  //     return;
  //   }
  //   const windowCheck = this.isWithinSquareOffWindow();
  //   if (!windowCheck.active) return;

  //   this.logger.log(
  //     `⏰ Auto Square-Off Window Active (${windowCheck.window!.start} → ${
  //       windowCheck.window!.end ?? '∞'
  //     } IST)`,
  //   );

  //   try {
  //     const netPositions = await this.orderService.getNetPositions();

  //     if (!netPositions?.data || !Array.isArray(netPositions.data)) {
  //       this.logger.warn('⚠️ No net positions found');
  //       return;
  //     }

  //     for (const pos of netPositions.data) {
  //       const netQty = Number(pos.netqty);

  //       if (!netQty || netQty === 0) continue;

  //       const closeSide = netQty > 0 ? 'SELL' : 'BUY';
  //       const closeQty = Math.abs(netQty);
  //       console.log('position data at auto-squareoff:', pos);
  //       this.logger.log(
  //         `🔁 Square-Off → ${pos.tsym} | ${closeSide} ${closeQty}`,
  //       );

  //       await this.orderService.placeOrder({
  //         buy_or_sell: closeSide === 'BUY' ? 'B' : 'S',
  //         product_type: 'I',
  //         exchange: pos.exch,
  //         tradingsymbol: pos.tsym,
  //         quantity: closeQty,
  //         price_type: 'MKT',
  //         price: 0,
  //         trigger_price: 0,
  //         discloseqty: 0,
  //         retention: 'DAY',
  //         amo: 'NO',
  //         remarks: `AUTO SQUARE-OFF ${windowCheck.window!.start}-${
  //           windowCheck.window!.end ?? '∞'
  //         } IST`,
  //       });
  //     }

  //     this.logger.log('✅ Auto square-off cycle completed');
  //   } catch (err) {
  //     this.logger.error('❌ Auto square-off failed', err?.message || err);
  //   }
  // }
}
