/**
 * How long a packet is on the air, and so how long a trace can take. LoRa's
 * time on air is Semtech's formula, with the preamble MeshCore sets: 32
 * symbols up to SF8, 16 above (`RadioLibWrappers.h`), an explicit header and
 * a CRC, and low data rate optimisation once a symbol lasts 16 ms or more.
 */

export interface AirtimeRadio {
  bandwidthHz: number;
  spreadingFactor: number;
  /** The denominator of the coding rate: 5 for 4/5 up to 8 for 4/8. */
  codingRate: number;
}

/** Time on air of a packet of `bytes`, ms. */
export function loraAirtimeMs(bytes: number, radio: AirtimeRadio): number {
  const sf = radio.spreadingFactor;
  const symbolMs = (2 ** sf / radio.bandwidthHz) * 1000;
  const preamble = sf <= 8 ? 32 : 16;
  const lowRate = symbolMs >= 16 ? 1 : 0;
  const bits = 8 * bytes - 4 * sf + 28 + 16;
  const payload = 8 + Math.max(Math.ceil(bits / (4 * (sf - 2 * lowRate))) * radio.codingRate, 0);
  return (preamble + 4.25 + payload) * symbolMs;
}

/**
 * The longest a trace through `hops` hashes of `hashSize` bytes should take
 * to come back, ms. Each relay sends it on after a pause of up to 1.5 times
 * its time on air (`direct.txdelay` 0.3, times 5), so a hop takes at most
 * about 2.5 airtimes; three, and a little for the radios, cover it. The
 * packet grows a byte of SNR a hop, so it is sized as it is halfway.
 */
export function traceBudgetMs(hops: number, hashSize: number, radio: AirtimeRadio): number {
  const bytes = 2 + 9 + hops * hashSize + Math.ceil(hops / 2);
  return 1500 + (hops + 1) * (3 * loraAirtimeMs(bytes, radio) + 80);
}

/**
 * How long a repeater's neighbours take to answer `discover.neighbors`, ms.
 * Each answers once, zero hop, after a random pause of up to twenty times
 * its answer's time on air times its `txdelay` (`simple_repeater`: five
 * times the retransmit delay, widened four times). The wait covers a
 * `txdelay` of 1, twice the default, and stays inside the minute the
 * repeater listens. The answer is 40 bytes: a header, a path length and six
 * bytes of type, SNR and tag before the whole key.
 */
export function neighbourSearchMs(radio: AirtimeRadio): number {
  return Math.min(60_000, 1500 + 20 * loraAirtimeMs(40, radio));
}
