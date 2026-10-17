import { test } from "node:test";
import assert from "node:assert/strict";
import { ErrCode, MeshCoreError } from "@meshnet/meshcore";
import { errorText } from "./errors.js";

test("a send the radio had no room for reads as a busy radio; a full table elsewhere keeps the radio's words", () => {
  assert.match(errorText(new MeshCoreError(ErrCode.TableFull, "sendTracePath")), /^The radio is busy/);
  assert.match(errorText(new MeshCoreError(ErrCode.TableFull, "sendTextMessage")), /^The radio is busy/);
  assert.equal(errorText(new MeshCoreError(ErrCode.TableFull, "sendAnonReq")), "The radio refused: sendAnonReq: table full");
  assert.equal(errorText(new MeshCoreError(ErrCode.TableFull, "addUpdateContact")), "The radio refused: addUpdateContact: table full");
  assert.equal(errorText(new MeshCoreError(ErrCode.NotFound, "sendTracePath")), "The radio refused: sendTracePath: not found");
});
