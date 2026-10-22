/**
 * Settings kept alike with another app, the rules without the stores: what
 * `sharedSettings.ts` does for the two apps sharing one radio through a phone.
 *
 * Each setting carries when it was last changed here, and the later change
 * wins. A setting a chat or a node may have of its own goes one entry per id,
 * so two apps that each set a different chat's both stand. A setting nobody
 * has changed since this came in has no time: one away from its default
 * counts as changed at the dawn of time, and between two such the phone's
 * stands, since the radio is the phone's. An entry put back to its default
 * keeps its time, so the other app puts its own back too. A change made here
 * is never dated before the change it follows, so a clock running behind the
 * other app's still wins with what is changed after.
 *
 * While sharing is off here, what the other app sends is kept, the latest of
 * each, and taken when it is turned on: the other app has no reason to send
 * it again.
 *
 * Between the apps a setting is named `s:<key>`, or `s:<key>:<id>` for one
 * id's, and its value is JSON: `[time, value]`, the value null for an entry
 * put back to its default.
 */

import { fromUtf8, SETTING_PREFIX, utf8, type PeerSide } from "@meshnet/meshcore";

/** One setting: its key between the apps, which has no colon, and how to read and write it here. */
export interface One<T> {
  key: string;
  read(): T;
  write(value: T): void;
  /** Whether a value from the other app is one this app takes. */
  valid(value: unknown): value is T;
  fallback: T;
}

/** A setting each chat or node may have of its own, by id. */
export interface Many<T> {
  key: string;
  /** Every one set, by id; null while there is nothing to read them for (no radio). */
  entries(): Readonly<Record<string, T>> | null;
  /** Sets one id's, or with null puts it back to the default. */
  write(id: string, value: T | null): void;
  valid(value: unknown): value is T;
  /** Whether an entry is one nobody chose: Public's pin on a radio nobody pinned anything for. */
  untouched?(value: T): boolean;
  /** Whose the entries are, the radio's for pins: when that changes they are another's, not changed ones. */
  scope?(): string;
}

export interface SyncOptions {
  /** Which app this is on a radio shared through a phone, while it can carry settings; null when it cannot. */
  side(): PeerSide | null;
  /** Hands the other app a setting, under its name between the apps. */
  tell(key: string, value: Uint8Array): void;
  /** Whether settings go to the other app and are taken from it. */
  enabled(): boolean;
  /** The times kept from earlier runs, and the place to keep them. */
  times: Record<string, number>;
  saveTimes(times: Record<string, number>): void;
  /** What the other app sent while sharing was off, by name, as it came; and the place to keep it. */
  held: Record<string, string>;
  saveHeld(held: Record<string, string>): void;
  now(): number;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** A name between the apps, without its `s:`, split into its key and the id in it; a setting of its own has no id. */
function split(name: string): { key: string; id: string | null } {
  const at = name.indexOf(":");
  return at < 0 ? { key: name, id: null } : { key: name.slice(0, at), id: name.slice(at + 1) };
}

export class SettingsSync {
  private readonly ones = new Map<string, One<unknown>>();
  private readonly manys = new Map<string, Many<unknown>>();
  /** Each setting as it was last looked at, as JSON. */
  private readonly seen = new Map<string, string>();
  private readonly scopes = new Map<string, string>();
  private readonly times: Record<string, number>;
  private held: Record<string, string>;

  constructor(private readonly options: SyncOptions) {
    this.times = { ...options.times };
    this.held = { ...options.held };
  }

  share<T>(one: One<T>): void {
    this.ones.set(one.key, one as One<unknown>);
    this.seen.set(one.key, json(one.read()));
  }

  shareEach<T>(many: Many<T>): void {
    this.manys.set(many.key, many as Many<unknown>);
    this.baseline(many as Many<unknown>);
  }

  /** Finds what changed since the last look: each gets the time now, and goes to the other app. */
  look(): void {
    const changed: string[] = [];
    for (const one of this.ones.values()) {
      const value = json(one.read());
      if (this.seen.get(one.key) === value) continue;
      this.seen.set(one.key, value);
      changed.push(one.key);
    }
    for (const many of this.manys.values()) {
      if (this.scopes.get(many.key) !== (many.scope?.() ?? "")) {
        this.baseline(many);
        continue;
      }
      const entries = many.entries();
      if (!entries) continue;
      const prefix = `${many.key}:`;
      const ids = new Set(Object.keys(entries));
      for (const name of this.seen.keys()) if (name.startsWith(prefix)) ids.add(name.slice(prefix.length));
      for (const id of ids) {
        const name = prefix + id;
        const value = json(entries[id]);
        if ((this.seen.get(name) ?? "null") === value) continue;
        if (entries[id] === undefined) this.seen.delete(name);
        else this.seen.set(name, value);
        changed.push(name);
      }
    }
    if (!changed.length) return;
    const now = this.options.now();
    for (const name of changed) this.times[name] = Math.max(now, (this.times[name] ?? 0) + 1);
    this.options.saveTimes(this.times);
    if (this.carrying()) for (const name of changed) this.tell(name);
  }

  /** Every setting changed here at some time, for the other app to catch up on. */
  tellAll(): void {
    if (!this.carrying()) return;
    const names = new Set<string>(this.ones.keys());
    for (const many of this.manys.values()) {
      for (const id of Object.keys(many.entries() ?? {})) names.add(`${many.key}:${id}`);
    }
    // Entries put back to their default, which the other app may still have.
    for (const name of Object.keys(this.times)) if (split(name).id !== null) names.add(name);
    for (const name of names) if (this.timeOf(name) > 0) this.tell(name);
  }

  /**
   * Every setting as it stands here, by its name between the apps, those at
   * their default left out: what a copy of the radio carries to another
   * device (`backup/format.ts`).
   */
  snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const one of this.ones.values()) {
      const value = one.read();
      if (json(value) !== json(one.fallback)) out[one.key] = value;
    }
    for (const many of this.manys.values()) {
      for (const [id, value] of Object.entries(many.entries() ?? {})) if (!many.untouched?.(value)) out[`${many.key}:${id}`] = value;
    }
    return out;
  }

  /** Writes the settings of a snapshot, each one this app would take from the other app; returns how many it wrote. */
  adopt(values: Readonly<Record<string, unknown>>): number {
    let written = 0;
    for (const [name, value] of Object.entries(values)) {
      const { key, id } = split(name);
      if (id === null) {
        const one = this.ones.get(key);
        if (!one?.valid(value)) continue;
        one.write(value);
      } else {
        const many = this.manys.get(key);
        if (!many?.valid(value)) continue;
        many.write(id, value);
      }
      written++;
    }
    return written;
  }

  /** Sharing was turned on here: what the other app sent meanwhile is taken, and what is here goes to it. */
  resume(): void {
    const held = this.held;
    this.held = {};
    this.options.saveHeld(this.held);
    for (const [name, text] of Object.entries(held)) this.take(SETTING_PREFIX + name, utf8(text));
    this.tellAll();
  }

  /** A setting from the other app: taken when its change is the later one. */
  take(key: string, value: Uint8Array): void {
    if (!key.startsWith(SETTING_PREFIX)) return;
    const name = key.slice(SETTING_PREFIX.length);
    const text = fromUtf8(value);
    if (!this.options.enabled()) {
      this.held[name] = text;
      this.options.saveHeld(this.held);
      return;
    }
    let said: unknown;
    try {
      said = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(said) || said.length !== 2 || typeof said[0] !== "number") return;
    const [at, theirs] = said as [number, unknown];
    const mine = this.timeOf(name);
    // Two changes as old as each other: the phone's stands.
    if (at < mine || (at === mine && this.options.side() !== "computer")) return;
    const { key: family, id } = split(name);
    if (json(theirs) !== json(this.current(name))) {
      if (id === null) {
        const one = this.ones.get(family);
        if (!one || !one.valid(theirs)) return;
        one.write(theirs);
        this.seen.set(name, json(one.read()));
      } else {
        const many = this.manys.get(family);
        if (!many || (theirs !== null && !many.valid(theirs))) return;
        many.write(id, theirs);
        const now = many.entries()?.[id];
        if (now === undefined) this.seen.delete(name);
        else this.seen.set(name, json(now));
      }
    } else if (!this.ones.has(family) && !this.manys.has(family)) {
      return;
    }
    this.times[name] = at;
    this.options.saveTimes(this.times);
  }

  private carrying(): boolean {
    return this.options.enabled() && this.options.side() !== null;
  }

  private tell(name: string): void {
    this.options.tell(SETTING_PREFIX + name, utf8(JSON.stringify([this.timeOf(name), this.current(name)])));
  }

  /** Takes a family's entries as they are now, as none changed. */
  private baseline(many: Many<unknown>): void {
    const prefix = `${many.key}:`;
    for (const name of [...this.seen.keys()]) if (name.startsWith(prefix)) this.seen.delete(name);
    for (const [id, value] of Object.entries(many.entries() ?? {})) this.seen.set(prefix + id, json(value));
    this.scopes.set(many.key, many.scope?.() ?? "");
  }

  private current(name: string): unknown {
    const { key, id } = split(name);
    if (id === null) return this.ones.get(key)?.read() ?? null;
    return this.manys.get(key)?.entries()?.[id] ?? null;
  }

  /** When a setting was last changed here: its time, or the dawn of time for one away from its default, or never. */
  private timeOf(name: string): number {
    const at = this.times[name];
    if (at !== undefined) return at;
    const { key, id } = split(name);
    if (id === null) {
      const one = this.ones.get(key);
      return one && json(one.read()) !== json(one.fallback) ? 1 : 0;
    }
    const many = this.manys.get(key);
    const value = many?.entries()?.[id];
    return value !== undefined && !many?.untouched?.(value) ? 1 : 0;
  }
}
