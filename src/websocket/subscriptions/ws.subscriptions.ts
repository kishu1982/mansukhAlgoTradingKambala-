// Central place to manage all WS subscriptions

export const WS_SUBSCRIPTIONS = {
  DEFAULT: [
    'NSE|2885', // RELIANCE
    'NSE|1594', // INFY
    'NFO|35003', // NIFTY FUT
    'MCX|472780', // GOLDM
  ],

  EQUITIES: ['NSE|22', 'NSE|1594'],

  DERIVATIVES: ['NFO|35003'],

  COMMODITIES: ['MCX|487866'],
};
