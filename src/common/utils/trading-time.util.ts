import { ConfigService } from '@nestjs/config';

/**
 * Exchanges where trading time restriction applies
 */
const TIME_RESTRICTED_EXCHANGES = new Set(['NSE', 'NFO', 'BSE', 'BFO']);

/**
 * Check if trading is allowed for given exchange (IST based)
 */
export function isTradingAllowedForExchange(
  exchange: string,
  configService: ConfigService,
): boolean {
  // ✅ No restriction → always allowed
  if (!TIME_RESTRICTED_EXCHANGES.has(exchange)) {
    return true;
  }

  const startTime = configService.get<string>('TRADING_START_TIMES', '09:20');
  const endTime = configService.get<string>('TRADING_END_TIME', '15:25');

  //   console.log(
  //     ` Trading Time Check for ${exchange} : ${startTime} - ${endTime} `,
  //   );

  // Current IST time
  const now = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
  );

  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);

  const start = new Date(now);
  start.setHours(sh, sm, 0, 0);

  const end = new Date(now);
  end.setHours(eh, em, 0, 0);

  return now >= start && now <= end;
}

/*
=============================================
// cunction to be called 
    // ============================
    // Time Restriction Check
    // ============================
    import { isTradingAllowedForExchange } from 'src/common/utils/trading-time.util';

    const exchange = position.exchange;

    if (!isTradingAllowedForExchange(exchange, this.ConfigService)) {
      this.logger.warn(
        `⏰ Trading time restricted. Skipping signal for ${exchange}|${exchange.token}|${exchange.symbol}`,
      );
      return;
    }


=============================================
*/
