import { test } from "node:test";
import assert from "node:assert/strict";
import { findPlaces, placeMessage, placeOfMark, placeText, pointFromText, roughPoint, textWithPlaces, tileMetresPerPixel, zoomToFit } from "./place.js";

test("an exact place keeps five decimals and the phone's accuracy", () => {
  assert.equal(placeText(55.7496694, 37.6239451, false, 8.4), "geo:55.74967,37.62395;u=8");
  assert.equal(placeText(55.7496694, 37.6239451, false), "geo:55.74967,37.62395");
  assert.equal(placeText(-33.86882, 151.20929, false, 0), "geo:-33.86882,151.20929");
});

test("a rough place is the text itself rounded to the grid, with a kilometre round it", () => {
  assert.equal(placeText(55.7496694, 37.6239451, true, 8), "geo:55.75,37.62;u=1000");
  assert.deepEqual(roughPoint(55.7496694, 37.6239451), { lat: 55.75, lon: 37.62 });
  // Sent again from a few metres away, it says the same.
  assert.equal(placeText(55.7491, 37.6202, true), placeText(55.7496694, 37.6239451, true));
});

test("geo: is read with its uncertainty, and two decimals or fewer read as rough", () => {
  assert.deepEqual(placeOfMark("geo:55.74967,37.62395;u=8"), { lat: 55.74967, lon: 37.62395, u: 8, rough: false, label: "" });
  assert.deepEqual(placeOfMark("geo:55.75,37.62;u=1000"), { lat: 55.75, lon: 37.62, u: 1000, rough: true, label: "" });
  assert.deepEqual(placeOfMark("geo:55.75,37.62"), { lat: 55.75, lon: 37.62, u: 1000, rough: true, label: "" });
  assert.equal(placeOfMark("geo:55.7,37.6")?.u, 10_000);
  assert.equal(placeOfMark("geo:55.7558,37.6173")?.rough, false);
  assert.equal(placeOfMark("geo:95.1,37.6"), null);
});

test("other clients' marks are places too", () => {
  assert.deepEqual(placeOfMark("m:55.75820,37.64150|Родник|poi"), { lat: 55.7582, lon: 37.6415, u: null, rough: false, label: "Родник" });
  assert.deepEqual(placeOfMark("[WAY]55.75820,37.64150"), { lat: 55.7582, lon: 37.6415, u: null, rough: false, label: "" });
  assert.equal(placeOfMark("[LOC]55.74967,37.62395")?.lat, 55.74967);
});

test("places are found where they stand in a text", () => {
  const text = "Встречаемся у geo:55.7497,37.6239 в восемь, потом [WAY]55.7582,37.6415 Родник";
  const found = findPlaces(text);
  assert.equal(found.length, 2);
  assert.equal(text.slice(found[0]!.start, found[0]!.end), "geo:55.7497,37.6239");
  assert.equal(text.slice(found[1]!.start, found[1]!.end), "[WAY]55.7582,37.6415");
  assert.deepEqual(findPlaces("no place here, 55.7 37.6"), []);
});

test("a mark cut short is no place, while a full stop after one is only a full stop", () => {
  // A quote cut at fifteen characters left this of Alice's place: read whole, it was a place 100 km wide at 55°, 73°.
  assert.deepEqual(findPlaces("@[Alice] >geo:55.04212,73…\nOn my way"), []);
  assert.deepEqual(findPlaces("geo:55.04212,73.3..."), []);
  assert.deepEqual(findPlaces("[LOC]55.04212,73.39…"), []);
  assert.equal(findPlaces("Встречаемся тут: geo:55.75,37.62.").length, 1);
});

test("a place in the line a reply quotes is not the reply's own", () => {
  const reply = "@[Alice] >geo:55.04212,73.39208\nOn my way";
  assert.equal(placeMessage(reply, "@[Alice] >geo:55.04212,73.39208\n".length), null);
  assert.equal(placeMessage(`${reply} geo:55.03,73.37;u=1000`, "@[Alice] >geo:55.04212,73.39208\n".length)?.place.lat, 55.03);
});

test("one place makes a place message, the rest of the text its caption", () => {
  assert.deepEqual(placeMessage("geo:55.74967,37.62395;u=8 Мы тут"), { place: placeOfMark("geo:55.74967,37.62395;u=8"), caption: "Мы тут" });
  assert.equal(placeMessage("@[Коля] geo:55.75,37.62;u=1000 рядом")?.caption, "@[Коля] рядом");
  assert.equal(placeMessage("geo:55.75,37.62")?.caption, "");
  assert.equal(placeMessage("geo:55.75,37.62 и geo:55.76,37.63"), null);
  assert.equal(placeMessage("просто текст"), null);
});

test("a line with no room for a map says there is a place", () => {
  assert.equal(textWithPlaces("geo:55.74967,37.62395;u=8 Мы тут"), "📍 Мы тут");
  assert.equal(textWithPlaces("geo:55.75,37.62;u=1000"), "📍 Place");
  assert.equal(textWithPlaces("m:55.7582,37.6415|Родник|poi"), "📍 Родник");
  assert.equal(textWithPlaces("from geo:55.75,37.62 to geo:55.76,37.63"), "from 📍 Place to 📍 Place");
  assert.equal(textWithPlaces("no place"), "no place");
});

test("a pasted spot is read from coordinates, marks and map links", () => {
  assert.deepEqual(pointFromText("55.75580, 37.61730"), { lat: 55.7558, lon: 37.6173 });
  assert.deepEqual(pointFromText("55,7558 37,6173"), { lat: 55.7558, lon: 37.6173 });
  assert.deepEqual(pointFromText("55,7558, 37,6173"), { lat: 55.7558, lon: 37.6173 });
  assert.deepEqual(pointFromText("geo:55.7558,37.6173;u=12"), { lat: 55.7558, lon: 37.6173 });
  assert.deepEqual(pointFromText("m:55.7582,37.6415|Родник|poi"), { lat: 55.7582, lon: 37.6415 });
  // Yandex puts the longitude first.
  assert.deepEqual(pointFromText("https://yandex.ru/maps/?ll=37.6173%2C55.7558&z=16"), { lat: 55.7558, lon: 37.6173 });
  assert.deepEqual(pointFromText("https://www.google.com/maps/@55.7558,37.6173,17z"), { lat: 55.7558, lon: 37.6173 });
  assert.deepEqual(pointFromText("https://www.openstreetmap.org/#map=17/55.7558/37.6173"), { lat: 55.7558, lon: 37.6173 });
  assert.deepEqual(pointFromText("https://maps.apple.com/?ll=55.7558,37.6173&q=Pin"), { lat: 55.7558, lon: 37.6173 });
  assert.equal(pointFromText("https://yandex.ru/maps/-/CDabcXYZ"), null);
  assert.equal(pointFromText("где-то у моста"), null);
  assert.equal(pointFromText(""), null);
});

test("a picture's zoom fits the circle or the street it is asked to", () => {
  // At 55° zoom 12 is about 22 m a pixel, so a kilometre takes 46 px: within 45 px only zoom 11 holds it.
  assert.equal(zoomToFit(55.75, 1000, 45), 11);
  assert.equal(zoomToFit(55.75, 1000, 50), 12);
  assert.ok(Math.abs(tileMetresPerPixel(55.75, 12) - 21.5) < 0.5);
  assert.equal(zoomToFit(0, 1, 1000), 17);
  assert.equal(zoomToFit(0, 1e9, 1), 2);
});
