import { test } from "node:test";
import assert from "node:assert/strict";
import { getUnits, pressureIn, setPressureUnit, setTemperatureUnit, temperatureIn } from "./units.js";

test("a pressure and a temperature read in the other units", () => {
  assert.equal(pressureIn(1012.4, "hpa"), 1012.4);
  assert.equal(pressureIn(1012.4, "mmhg").toFixed(1), "759.4");
  assert.equal(pressureIn(1013.25, "mmhg").toFixed(2), "760.00", "one atmosphere");
  assert.equal(temperatureIn(18.4, "c"), 18.4);
  assert.equal(temperatureIn(0, "f"), 32);
  assert.equal(temperatureIn(-40, "f"), -40);
  assert.equal(temperatureIn(100, "f"), 212);
});

test("a unit picked stays picked", () => {
  setPressureUnit("mmhg");
  setTemperatureUnit("f");
  assert.deepEqual(getUnits(), { pressure: "mmhg", temperature: "f" });
  setPressureUnit("hpa");
  setTemperatureUnit("c");
  assert.deepEqual(getUnits(), { pressure: "hpa", temperature: "c" });
});
