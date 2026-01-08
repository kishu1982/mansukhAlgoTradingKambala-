export class PlaceOrderDto {
  uid: string;
  exch: string;
  tsym: string;
  qty: number;
  prc: number;
  prd: string;
  trantype: 'B' | 'S';
  prctyp: 'MKT' | 'LMT' | 'SL-LMT' | 'SL-MKT';
  ret: 'DAY' | 'IOC';
}
