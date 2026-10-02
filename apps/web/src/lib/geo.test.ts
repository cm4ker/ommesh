import { test } from "node:test";
import assert from "node:assert/strict";
import { AdvType } from "@meshnet/meshcore";
import { bearingDeg, compass, destination, distanceKm, formatDistance, formatLatLon, formatRoundDistance, freshness, hasPosition, metresPerPixel, parseLatLon, pointDecimal, scaleBar } from "./geo.js";

test("0, 0 is no position, and so is anything off the globe", () => {
  assert.equal(hasPosition(0, 0), false);
  assert.equal(hasPosition(43.2381, 76.9452), true);
  assert.equal(hasPosition(0, 12), true);
  assert.equal(hasPosition(91, 10), false);
});

test("a degree of latitude is about 111 km, and due north is 0°", () => {
  assert.ok(Math.abs(distanceKm(43, 77, 44, 77) - 111.2) < 0.2);
  assert.ok(Math.abs(bearingDeg(43, 77, 44, 77)) < 0.01);
  assert.equal(compass(bearingDeg(43, 77, 43, 78)), "E");
  assert.equal(compass(bearingDeg(43, 77, 42.9, 76.9)), "SW");
});

test("short distances read in metres, long ones without decimals", () => {
  assert.equal(formatDistance(0.579), "579 m");
  assert.equal(formatDistance(6.44), "6.4 km");
  assert.equal(formatDistance(312.4), "312 km");
});

test("a distance picked on a slider keeps no figure it was not picked to", () => {
  assert.equal(formatRoundDistance(0.5), "500 m");
  assert.equal(formatRoundDistance(2.5), "2.5 km");
  assert.equal(formatRoundDistance(5), "5 km");
  assert.equal(formatRoundDistance(20), "20 km");
});

test("a map's scale shows the longest round length that fits it", () => {
  // A street in Omsk: under a metre and a half to the pixel.
  const street = metresPerPixel(55, 15);
  assert.ok(Math.abs(street - 1.37) < 0.01);
  assert.deepEqual(scaleBar(street, 96), { metres: 100, px: 73 });
  // Each zoom out doubles the ground a pixel covers.
  assert.ok(Math.abs(metresPerPixel(55, 10) / street - 32) < 1e-9);
  assert.equal(scaleBar(metresPerPixel(55, 10), 96).metres, 2000);
  assert.equal(scaleBar(1, 96).metres, 50);
  assert.equal(scaleBar(1, 100).metres, 100);
  assert.ok(scaleBar(0.37, 96).px <= 96);
});

test("a point so far along a bearing is that far, in that direction", () => {
  const p = destination(55.05, 73.4, 25, 60);
  assert.ok(Math.abs(distanceKm(55.05, 73.4, p.lat, p.lon) - 25) < 0.01);
  assert.ok(Math.abs(bearingDeg(55.05, 73.4, p.lat, p.lon) - 60) < 0.2);
  assert.ok(Math.abs(destination(0, 179.9, 50, 90).lon + 179.65) < 0.01);
});

test("a repeater stays fresh for hours, a person for an hour", () => {
  assert.equal(freshness(AdvType.Chat, 30 * 60), "fresh");
  assert.equal(freshness(AdvType.Chat, 3 * 3600), "aging");
  assert.equal(freshness(AdvType.Chat, 2 * 86400), "stale");
  assert.equal(freshness(AdvType.Repeater, 3 * 3600), "fresh");
  assert.equal(freshness(AdvType.Repeater, 30 * 3600), "aging");
});

test("a position pasted from a map, or a geo: link, gives both halves", () => {
  assert.deepEqual(parseLatLon("55.75580, 37.61730"), { lat: 55.7558, lon: 37.6173 });
  assert.deepEqual(parseLatLon(" -33.8688,151.2093 "), { lat: -33.8688, lon: 151.2093 });
  assert.deepEqual(parseLatLon("43.2381 76.9452"), { lat: 43.2381, lon: 76.9452 });
  assert.deepEqual(parseLatLon("geo:43.2381,76.9452;u=35"), { lat: 43.2381, lon: 76.9452 });
  assert.equal(parseLatLon("55.7558"), null);
  assert.equal(parseLatLon("95.1, 37.6"), null);
  assert.equal(parseLatLon("55.7, 37.6, 12z"), null);
  assert.equal(parseLatLon("Moscow"), null);
});

test("a half typed with a decimal comma reads as one number", () => {
  assert.equal(pointDecimal("55,7558"), "55.7558");
  assert.equal(pointDecimal(" -33,8688 "), "-33.8688");
  assert.equal(pointDecimal("55.7558"), "55.7558");
  assert.equal(pointDecimal("55.75580, 37.61730"), "55.75580, 37.61730");
  assert.equal(parseLatLon(pointDecimal("55,75")), null);
});

test("a spot reads as a map copies it, and reads back the same", () => {
  assert.equal(formatLatLon(55.7558, -37.6173), "55.75580, -37.61730");
  assert.deepEqual(parseLatLon(formatLatLon(55.7558, -37.6173)), { lat: 55.7558, lon: -37.6173 });
});
