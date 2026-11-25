import type {
  AppRpcRequest,
  DeliveryUpdate,
  HostRpcMessage,
  IncomingPacket,
  MiniAppActivity,
  MiniAppContext,
  MiniAppPeer,
  MiniAppTheme,
  NotifyOptions,
  OmmeshApp,
  PickPeerOptions,
  SendResult,
} from "./types.js";

/**
 * Connects a sandboxed mini-app to the Ommesh host over the private
 * `MessageChannel` port delivered with `ommesh:init`.
 */
export function connect(timeoutMs = 5000): Promise<OmmeshApp> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onInit);
      reject(new Error("timed out waiting for Ommesh host"));
    }, timeoutMs);

    function onInit(event: MessageEvent): void {
      if (event.data?.type !== "ommesh:init" || !event.ports[0]) return;
      clearTimeout(timer);
      window.removeEventListener("message", onInit);
      resolve(attachPort(event.data.context as MiniAppContext, event.ports[0]));
    }

    window.addEventListener("message", onInit);
    window.parent?.postMessage({ type: "ommesh:ready" }, "*");
  });
}

function attachPort(initialContext: MiniAppContext, port: MessagePort): OmmeshApp {
  let nextId = 1;
  let context: MiniAppContext = initialContext;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const packetListeners = new Set<(p: IncomingPacket) => void>();
  const deliveryListeners = new Set<(u: DeliveryUpdate) => void>();
  const themeListeners = new Set<(t: MiniAppTheme) => void>();
  const activityListeners = new Set<(id: string) => void>();

  function applyTheme(theme: MiniAppTheme): void {
    const root = document.documentElement;
    root.dataset.appearance = theme.appearance;
    if (theme.look) root.dataset.look = theme.look;
    else delete root.dataset.look;
    root.style.colorScheme = theme.appearance;
    root.style.setProperty("--text-scale", String(theme.textScale ?? 1));
    for (const [k, v] of Object.entries(theme.tokens)) {
      root.style.setProperty(`--${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`, v);
    }
  }

  applyTheme(context.theme);

  port.onmessage = (event: MessageEvent<HostRpcMessage>) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "rpc:result": {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p.resolve(msg.result);
        }
        return;
      }
      case "rpc:error": {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p.reject(new Error(msg.message));
        }
        return;
      }
      case "event:packet":
        for (const cb of packetListeners) cb(msg.packet);
        return;
      case "event:delivery":
        for (const cb of deliveryListeners) cb(msg.update);
        return;
      case "event:theme":
        context = { ...context, theme: msg.theme };
        applyTheme(msg.theme);
        for (const cb of themeListeners) cb(msg.theme);
        return;
      case "event:openActivity":
        for (const cb of activityListeners) cb(msg.activityId);
        return;
      case "event:peers":
        context = { ...context, grantedPeers: msg.peers };
        return;
    }
  };
  port.start();

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

  function call<T>(req: DistributiveOmit<AppRpcRequest, "id">, transfer?: Transferable[]): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      port.postMessage({ ...req, id }, transfer ?? []);
    });
  }

  return {
    get context() {
      return context;
    },
    peers: {
      list: () => call<MiniAppPeer[]>({ method: "peers.list" }),
      pick: (options?: PickPeerOptions) => call<MiniAppPeer | null>(options ? { method: "peers.pick", options } : { method: "peers.pick" }),
    },
    transport: {
      send(peerPrefix: string, payload: Uint8Array, options?: { retry?: boolean }): Promise<SendResult> {
        const copy = payload.slice();
        return call<SendResult>(
          options?.retry !== undefined
            ? { method: "transport.send", peerPrefix, payload: copy, retry: options.retry }
            : { method: "transport.send", peerPrefix, payload: copy },
          [copy.buffer],
        );
      },
      onPacket(cb) {
        packetListeners.add(cb);
        return () => packetListeners.delete(cb);
      },
      onDelivery(cb) {
        deliveryListeners.add(cb);
        return () => deliveryListeners.delete(cb);
      },
    },
    storage: {
      get: <T = unknown>(key: string) => call<T | null>({ method: "storage.get", key }),
      set: (key: string, value: unknown) => call<void>({ method: "storage.set", key, value }),
      delete: (key: string) => call<void>({ method: "storage.delete", key }),
      list: () => call<string[]>({ method: "storage.list" }),
    },
    ui: {
      setActivities: (activities: MiniAppActivity[]) => call<void>({ method: "ui.setActivities", activities }),
      notify: (options: NotifyOptions) => call<void>({ method: "ui.notify", options }),
      onThemeChange(cb) {
        themeListeners.add(cb);
        return () => themeListeners.delete(cb);
      },
      onOpenActivity(cb) {
        activityListeners.add(cb);
        return () => activityListeners.delete(cb);
      },
      close() {
        void call<void>({ method: "ui.close" });
      },
    },
  };
}

/**
 * Tiny inline bootstrap script injected by the Ommesh host into every sandboxed
 * iframe before the mini-app's own scripts, exposing `window.ommeshReady`
 * (`Promise<OmmeshApp>`) so zero-build single-HTML `.omapp` bundles work out of the box.
 */
export const INLINE_SDK_BRIDGE = `
(function () {
  function applyTheme(theme) {
    if (!theme || !theme.tokens) return;
    var root = document.documentElement;
    root.dataset.appearance = theme.appearance || "dark";
    if (theme.look) root.dataset.look = theme.look;
    else delete root.dataset.look;
    root.style.colorScheme = theme.appearance || "dark";
    root.style.setProperty("--text-scale", String(theme.textScale || 1));
    for (var k in theme.tokens) {
      if (Object.prototype.hasOwnProperty.call(theme.tokens, k)) {
        var cssName = "--" + k.replace(/[A-Z]/g, function (m) { return "-" + m.toLowerCase(); });
        root.style.setProperty(cssName, theme.tokens[k]);
      }
    }
  }
  window.ommeshReady = new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { reject(new Error("Ommesh host timeout")); }, 6000);
    function onInit(ev) {
      if (!ev.data || ev.data.type !== "ommesh:init" || !ev.ports || !ev.ports[0]) return;
      clearTimeout(timer);
      window.removeEventListener("message", onInit);
      var port = ev.ports[0];
      var ctx = ev.data.context;
      var nextId = 1;
      var pending = new Map();
      var onPkt = new Set(), onDel = new Set(), onTheme = new Set(), onAct = new Set();
      applyTheme(ctx.theme);
      port.onmessage = function (e) {
        var m = e.data;
        if (!m) return;
        if (m.type === "rpc:result") { var p = pending.get(m.id); if (p) { pending.delete(m.id); p.resolve(m.result); } }
        else if (m.type === "rpc:error") { var p2 = pending.get(m.id); if (p2) { pending.delete(m.id); p2.reject(new Error(m.message)); } }
        else if (m.type === "event:packet") { onPkt.forEach(function (fn) { fn(m.packet); }); }
        else if (m.type === "event:delivery") { onDel.forEach(function (fn) { fn(m.update); }); }
        else if (m.type === "event:theme") { ctx = Object.assign({}, ctx, { theme: m.theme }); applyTheme(m.theme); onTheme.forEach(function (fn) { fn(m.theme); }); }
        else if (m.type === "event:openActivity") { onAct.forEach(function (fn) { fn(m.activityId); }); }
        else if (m.type === "event:peers") { ctx = Object.assign({}, ctx, { grantedPeers: m.peers }); }
      };
      port.start();
      function call(req, xfer) {
        return new Promise(function (res, rej) {
          var id = nextId++;
          pending.set(id, { resolve: res, reject: rej });
          port.postMessage(Object.assign({ id: id }, req), xfer || []);
        });
      }
      var api = {
        get context() { return ctx; },
        peers: {
          list: function () { return call({ method: "peers.list" }); },
          pick: function (options) { return call({ method: "peers.pick", options: options }); }
        },
        transport: {
          send: function (peerPrefix, payload, options) {
            var copy = payload instanceof Uint8Array ? payload.slice() : new Uint8Array(payload);
            return call({ method: "transport.send", peerPrefix: peerPrefix, payload: copy, retry: options && options.retry }, [copy.buffer]);
          },
          onPacket: function (fn) { onPkt.add(fn); return function () { onPkt.delete(fn); }; },
          onDelivery: function (fn) { onDel.add(fn); return function () { onDel.delete(fn); }; }
        },
        storage: {
          get: function (key) { return call({ method: "storage.get", key: key }); },
          set: function (key, value) { return call({ method: "storage.set", key: key, value: value }); },
          delete: function (key) { return call({ method: "storage.delete", key: key }); },
          list: function () { return call({ method: "storage.list" }); }
        },
        ui: {
          setActivities: function (activities) { return call({ method: "ui.setActivities", activities: activities }); },
          notify: function (options) { return call({ method: "ui.notify", options: options }); },
          onThemeChange: function (fn) { onTheme.add(fn); return function () { onTheme.delete(fn); }; },
          onOpenActivity: function (fn) { onAct.add(fn); return function () { onAct.delete(fn); }; },
          close: function () { call({ method: "ui.close" }); }
        }
      };
      window.ommesh = api;
      resolve(api);
    }
    window.addEventListener("message", onInit);
    window.parent.postMessage({ type: "ommesh:ready" }, "*");
  });
})();
`;
