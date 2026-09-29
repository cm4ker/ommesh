import { test } from "node:test";
import assert from "node:assert/strict";
import { UpdateController, type Progress, type UpdateHandle } from "./updateController.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
/** Lets the feed be read again before a download starts. */
const settle = () => new Promise((resolve) => setImmediate(resolve));
function handle(overrides: Partial<UpdateHandle> = {}): UpdateHandle {
  return { version: "0.3.0", body: "Release notes", download: async () => {}, install: async () => {}, close: async () => {}, ...overrides };
}

test("offline check can be retried; checking never overlaps or changes channel", async () => {
  let calls = 0;
  const pending = deferred<UpdateHandle | null>();
  const controller = new UpdateController(() => { calls++; return pending.promise; }, "stable");
  const checking = controller.check();
  assert.equal(controller.setChannel("dev"), false);
  await controller.check();
  assert.equal(calls, 1);
  pending.reject(new Error("offline"));
  await checking;
  assert.equal(controller.getState().phase, "idle");
  assert.match(controller.getState().error!, /offline/);
  await controller.check();
  assert.equal(calls, 2);
});

test("download completion alone cannot enable install before signature verification", async () => {
  const pending = deferred<void>();
  let progress!: (event: Progress) => void;
  let downloads = 0;
  let installs = 0;
  const controller = new UpdateController(async () => handle({
    download: (callback) => { downloads++; progress = callback; return pending.promise; },
    install: async () => { installs++; },
  }), "dev");
  await controller.check();
  const downloading = controller.download();
  await controller.download();
  await settle();
  assert.equal(downloads, 1);
  assert.equal(controller.setChannel("stable"), false);
  progress({ event: "Started", data: { contentLength: 100 } });
  progress({ event: "Progress", data: { chunkLength: 100 } });
  progress({ event: "Finished" });
  await controller.install(async () => async () => {});
  assert.equal(installs, 0);
  assert.equal(controller.getState().phase, "downloading");
  pending.reject(new Error("Invalid signature"));
  await downloading;
  assert.equal(controller.getState().phase, "available");
  assert.match(controller.getState().error!, /Invalid signature/);
});

test("retry downloads and channel changes discard the old native resource", async () => {
  let downloads = 0;
  let closed = 0;
  const controller = new UpdateController(async () => handle({
    download: async () => { if (++downloads === 1) throw new Error("connection lost"); },
    close: async () => { closed++; },
  }), "stable");
  await controller.check();
  await controller.download();
  await controller.download();
  assert.equal(controller.getState().phase, "ready");
  // Each download read the feed again and let go of the update it replaced.
  assert.equal(closed, 2);
  await controller.check();
  assert.equal(closed, 2);
  assert.equal(controller.setChannel("dev"), true);
  assert.equal(closed, 3);
  assert.equal(controller.getState().phase, "idle");
  assert.equal(controller.getState().version, null);
});

test("a failed check preserves an already discovered update", async () => {
  let calls = 0;
  const controller = new UpdateController(async () => { if (calls++) throw new Error("offline"); return handle(); }, "stable");
  await controller.check();
  await controller.check();
  assert.equal(controller.getState().version, "0.3.0");
  await controller.download();
  assert.equal(controller.getState().phase, "ready");
});

test("download takes the feed's newest build, not the one found hours before (#56)", async () => {
  let feed = "0.4.0-dev.122.1";
  const downloaded: string[] = [];
  const closed: string[] = [];
  const controller = new UpdateController(async () => {
    const version = feed;
    return handle({
      version,
      download: async () => { if (version === "0.4.0-dev.122.1") throw new Error("404 Not Found"); downloaded.push(version); },
      close: async () => { closed.push(version); },
    });
  }, "dev");
  await controller.check();
  feed = "0.4.0-dev.124.1";
  await controller.download();
  assert.deepEqual(downloaded, ["0.4.0-dev.124.1"]);
  assert.deepEqual(closed, ["0.4.0-dev.122.1"]);
  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().version, "0.4.0-dev.124.1");
  assert.equal(controller.getState().error, null);
});

test("download says the app is up to date once the feed offers nothing newer", async () => {
  let downloads = 0;
  let calls = 0;
  const controller = new UpdateController(async () => calls++ ? null : handle({ download: async () => { downloads++; } }), "stable");
  await controller.check();
  await controller.download();
  assert.equal(downloads, 0);
  assert.equal(controller.getState().phase, "current");
  assert.equal(controller.getState().version, null);
});

test("failed persistence prevents install; failed install restores the radio", async () => {
  let installs = 0;
  let restored = 0;
  const controller = new UpdateController(async () => handle({ install: async () => { installs++; throw new Error("installer blocked"); } }), "stable");
  await controller.check();
  await controller.download();
  await controller.install(async () => { throw new Error("disk full"); });
  assert.equal(installs, 0);
  assert.equal(controller.getState().phase, "ready");
  assert.match(controller.getState().error!, /disk full/);
  await controller.install(async () => async () => { restored++; });
  assert.equal(installs, 1);
  assert.equal(restored, 1);
  assert.equal(controller.getState().phase, "ready");
  assert.match(controller.getState().error!, /installer blocked/);
});

test("install waits for preparation, requests restart, and ignores repeated clicks", async () => {
  const preparation = deferred<() => Promise<void>>();
  let installs = 0;
  const controller = new UpdateController(async () => handle({ install: async (options) => { installs++; assert.equal(options.restartAfterInstall, true); } }), "stable");
  await controller.check();
  await controller.download();
  const installing = controller.install(() => preparation.promise);
  await controller.install(() => { throw new Error("must not run twice"); });
  assert.equal(installs, 0);
  assert.equal(controller.setChannel("dev"), false);
  preparation.resolve(async () => {});
  await installing;
  assert.equal(installs, 1);
  assert.equal(controller.getState().phase, "installing");
});
