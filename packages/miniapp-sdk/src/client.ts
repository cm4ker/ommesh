import type {
  AppRpcRequest,
  DeliveryUpdate,
  HostRpcMessage,
  IncomingPacket,
  MiniAppActivity,
  MiniAppContext,
  MiniAppPeer,
  MiniAppTheme,
  MiniAppViewport,
  NotifyOptions,
  OmmeshApp,
  PickPeerOptions,
  SendResult,
} from "./types.js";

const MAX_BUFFERED_EVENTS = 64;

function isEditableElement(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName === "INPUT") {
    const type = ((el as HTMLInputElement).type || "text").toLowerCase();
    return !["button", "submit", "reset", "checkbox", "radio", "range", "file", "hidden", "image", "color"].includes(type);
  }
  return false;
}

function applyViewportCss(vp: MiniAppViewport | undefined): void {
  if (!vp) return;
  const root = document.documentElement;
  root.style.setProperty("--safe-bottom", `${Math.max(0, Math.round(vp.safeBottom))}px`);
  root.style.setProperty("--safe-left", `${Math.max(0, Math.round(vp.safeLeft))}px`);
  root.style.setProperty("--safe-right", `${Math.max(0, Math.round(vp.safeRight))}px`);
  root.style.setProperty("--keyboard-height", `${Math.max(0, Math.round(vp.keyboardHeight))}px`);
  root.dataset.keyboard = vp.keyboardOpen ? "open" : "closed";
  root.dataset.mobile = vp.mobile ? "1" : "0";
}

function scrollActiveFieldIntoView(): void {
  const active = document.activeElement;
  if (!isEditableElement(active)) return;
  try {
    active.scrollIntoView({ block: "nearest", inline: "nearest" });
  } catch {
    active.scrollIntoView();
  }
}

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
  const viewportListeners = new Set<(v: MiniAppViewport) => void>();
  const activityListeners = new Set<(id: string) => void>();
  // Events that arrive before the mini-app finishes async startup (e.g. awaiting storage.get)
  // are queued here so no LoRa packet or delivery ACK is lost during initialization.
  const bufferedPackets: IncomingPacket[] = [];
  const bufferedDeliveries: DeliveryUpdate[] = [];
  let bufferedActivity: string | null = null;
  let lastTyping = false;

  function reportTyping(next: boolean): void {
    if (next === lastTyping) return;
    lastTyping = next;
    window.parent?.postMessage({ type: "ommesh:focus", typing: next }, "*");
  }

  document.addEventListener("focusin", () => {
    const typing = isEditableElement(document.activeElement);
    reportTyping(typing);
    if (typing) {
      requestAnimationFrame(scrollActiveFieldIntoView);
      setTimeout(scrollActiveFieldIntoView, 280);
    }
  });
  document.addEventListener("focusout", () => {
    setTimeout(() => reportTyping(isEditableElement(document.activeElement)), 50);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") reportTyping(false);
  });
  window.addEventListener("resize", () => {
    if (isEditableElement(document.activeElement)) {
      requestAnimationFrame(scrollActiveFieldIntoView);
    }
  });

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
  applyViewportCss(context.viewport);

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
        if (packetListeners.size === 0) {
          bufferedPackets.push(msg.packet);
          if (bufferedPackets.length > MAX_BUFFERED_EVENTS) bufferedPackets.shift();
        } else {
          for (const cb of packetListeners) cb(msg.packet);
        }
        return;
      case "event:delivery":
        if (deliveryListeners.size === 0) {
          bufferedDeliveries.push(msg.update);
          if (bufferedDeliveries.length > MAX_BUFFERED_EVENTS) bufferedDeliveries.shift();
        } else {
          for (const cb of deliveryListeners) cb(msg.update);
        }
        return;
      case "event:theme":
        context = { ...context, theme: msg.theme };
        applyTheme(msg.theme);
        for (const cb of themeListeners) cb(msg.theme);
        return;
      case "event:viewport":
        context = { ...context, viewport: msg.viewport };
        applyViewportCss(msg.viewport);
        if (msg.viewport.keyboardOpen) {
          requestAnimationFrame(scrollActiveFieldIntoView);
          setTimeout(scrollActiveFieldIntoView, 280);
        }
        for (const cb of viewportListeners) cb(msg.viewport);
        return;
      case "event:openActivity":
        if (activityListeners.size === 0) {
          bufferedActivity = msg.activityId;
        } else {
          for (const cb of activityListeners) cb(msg.activityId);
        }
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
        if (bufferedPackets.length > 0) {
          const queued = bufferedPackets.splice(0, bufferedPackets.length);
          queueMicrotask(() => {
            for (const pkt of queued) {
              if (packetListeners.has(cb)) cb(pkt);
            }
          });
        }
        return () => packetListeners.delete(cb);
      },
      onDelivery(cb) {
        deliveryListeners.add(cb);
        if (bufferedDeliveries.length > 0) {
          const queued = bufferedDeliveries.splice(0, bufferedDeliveries.length);
          queueMicrotask(() => {
            for (const upd of queued) {
              if (deliveryListeners.has(cb)) cb(upd);
            }
          });
        }
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
      onViewportChange(cb) {
        viewportListeners.add(cb);
        return () => viewportListeners.delete(cb);
      },
      onOpenActivity(cb) {
        activityListeners.add(cb);
        if (bufferedActivity !== null) {
          const actId = bufferedActivity;
          bufferedActivity = null;
          queueMicrotask(() => {
            if (activityListeners.has(cb)) cb(actId);
          });
        }
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
  var NON_TEXT_INPUTS = { button: 1, submit: 1, reset: 1, checkbox: 1, radio: 1, range: 1, file: 1, hidden: 1, image: 1, color: 1 };
  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    var tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") return !NON_TEXT_INPUTS[String(el.type || "text").toLowerCase()];
    return false;
  }
  function scrollFieldIntoView() {
    var el = document.activeElement;
    if (!isEditable(el)) return;
    try { el.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
  }
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
  function applyViewport(vp) {
    if (!vp) return;
    var root = document.documentElement;
    root.style.setProperty("--safe-bottom", Math.max(0, Math.round(vp.safeBottom || 0)) + "px");
    root.style.setProperty("--safe-left", Math.max(0, Math.round(vp.safeLeft || 0)) + "px");
    root.style.setProperty("--safe-right", Math.max(0, Math.round(vp.safeRight || 0)) + "px");
    root.style.setProperty("--keyboard-height", Math.max(0, Math.round(vp.keyboardHeight || 0)) + "px");
    root.dataset.keyboard = vp.keyboardOpen ? "open" : "closed";
    root.dataset.mobile = vp.mobile ? "1" : "0";
  }
  var lastTyping = false;
  function reportTyping(next) {
    if (next === lastTyping) return;
    lastTyping = next;
    try { window.parent.postMessage({ type: "ommesh:focus", typing: next }, "*"); } catch (e) {}
  }
  document.addEventListener("focusin", function () {
    var t = isEditable(document.activeElement);
    reportTyping(t);
    if (t) {
      requestAnimationFrame(scrollFieldIntoView);
      setTimeout(scrollFieldIntoView, 280);
    }
  });
  document.addEventListener("focusout", function () {
    setTimeout(function () { reportTyping(isEditable(document.activeElement)); }, 50);
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") reportTyping(false);
  });
  window.addEventListener("resize", function () {
    if (isEditable(document.activeElement)) requestAnimationFrame(scrollFieldIntoView);
  });
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
      var onPkt = new Set(), onDel = new Set(), onTheme = new Set(), onVp = new Set(), onAct = new Set();
      var pktQueue = [], delQueue = [], actQueue = null;
      applyTheme(ctx.theme);
      applyViewport(ctx.viewport);
      port.onmessage = function (e) {
        var m = e.data;
        if (!m) return;
        if (m.type === "rpc:result") { var p = pending.get(m.id); if (p) { pending.delete(m.id); p.resolve(m.result); } }
        else if (m.type === "rpc:error") { var p2 = pending.get(m.id); if (p2) { pending.delete(m.id); p2.reject(new Error(m.message)); } }
        else if (m.type === "event:packet") {
          if (onPkt.size === 0) { pktQueue.push(m.packet); if (pktQueue.length > 64) pktQueue.shift(); }
          else onPkt.forEach(function (fn) { fn(m.packet); });
        }
        else if (m.type === "event:delivery") {
          if (onDel.size === 0) { delQueue.push(m.update); if (delQueue.length > 64) delQueue.shift(); }
          else onDel.forEach(function (fn) { fn(m.update); });
        }
        else if (m.type === "event:theme") { ctx = Object.assign({}, ctx, { theme: m.theme }); applyTheme(m.theme); onTheme.forEach(function (fn) { fn(m.theme); }); }
        else if (m.type === "event:viewport") {
          ctx = Object.assign({}, ctx, { viewport: m.viewport });
          applyViewport(m.viewport);
          if (m.viewport && m.viewport.keyboardOpen) {
            requestAnimationFrame(scrollFieldIntoView);
            setTimeout(scrollFieldIntoView, 280);
          }
          onVp.forEach(function (fn) { fn(m.viewport); });
        }
        else if (m.type === "event:openActivity") {
          if (onAct.size === 0) actQueue = m.activityId;
          else onAct.forEach(function (fn) { fn(m.activityId); });
        }
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
          onPacket: function (fn) {
            onPkt.add(fn);
            if (pktQueue.length) {
              var queued = pktQueue.splice(0, pktQueue.length);
              Promise.resolve().then(function () { queued.forEach(function (pkt) { if (onPkt.has(fn)) fn(pkt); }); });
            }
            return function () { onPkt.delete(fn); };
          },
          onDelivery: function (fn) {
            onDel.add(fn);
            if (delQueue.length) {
              var queued = delQueue.splice(0, delQueue.length);
              Promise.resolve().then(function () { queued.forEach(function (upd) { if (onDel.has(fn)) fn(upd); }); });
            }
            return function () { onDel.delete(fn); };
          }
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
          onViewportChange: function (fn) { onVp.add(fn); return function () { onVp.delete(fn); }; },
          onOpenActivity: function (fn) {
            onAct.add(fn);
            if (actQueue !== null) {
              var actId = actQueue;
              actQueue = null;
              Promise.resolve().then(function () { if (onAct.has(fn)) fn(actId); });
            }
            return function () { onAct.delete(fn); };
          },
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
