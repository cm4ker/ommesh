/**
 * The commands a repeater, room or sensor answers over the air, for the
 * console's suggestions and its reference: MeshCore's `CommonCLI.cpp` and
 * `simple_repeater`, and the MeshCoreTel fork's Wi-Fi, MQTT and web panel.
 * Left out are the ones the firmware takes only from its serial port (`erase`,
 * `log`, `stats-*`, `set freq`, `get prv.key`, `get acl`): over the air they
 * answer "Unknown command". The connected radio's own console has a list of its
 * own, `RADIO_COMMANDS`.
 *
 * Every command says what it does (`about`, the words in i18n/cli.json) and
 * which part of the reference it belongs to, so the reader can find it without
 * knowing its name.
 */

import { hasMcrsCap, hasMcrsVersion, McrsCap, type McrsInfo } from "@meshnet/meshcore";
import { t, type Key } from "../i18n/index.js";

/** The parts of the reference, in the order it shows them. */
export type CliGroup = "node" | "updates" | "advert" | "where" | "radio" | "repeat" | "access" | "power" | "net" | "sensors";

export const CLI_GROUPS: CliGroup[] = ["node", "updates", "advert", "where", "radio", "repeat", "access", "power", "net", "sensors"];

/** What a group is called: the heading over its commands. */
export const CLI_GROUP_TITLE: Record<CliGroup, Key> = {
  node: "cli.group.node",
  updates: "cli.group.updates",
  advert: "cli.group.advert",
  where: "cli.group.where",
  radio: "cli.group.radio",
  repeat: "cli.group.repeat",
  access: "cli.group.access",
  power: "cli.group.power",
  net: "cli.group.net",
  sensors: "cli.group.sensors",
};

export interface CliCommand {
  /** What is typed; it ends in a space when a value follows. */
  text: string;
  /** What the value is, said beside the field once the command is typed: a key, read in the reader's language by `suggest`. */
  arg?: Key;
  /** The values it takes, offered once the command is typed. */
  values?: string[];
  /** What it does, in the reference and beside what is typed. */
  about: Key;
  /** Where the reference puts it. */
  group: CliGroup;
  /** Minimum `MCRS_VERSION` required; omitted for upstream MeshCore commands. */
  mcrs?: number;
  /** Optional `McrsCap` bitmask required when `McrsInfo` is known. */
  cap?: number;
}

/** What is known about the console target's firmware, used to gate `meshcore-rs` commands. */
export interface CliContext {
  /** `MCRS` info read via opcode `0x70`, when available. */
  mcrs?: McrsInfo | null;
  /** True when the target is known to run `meshcore-rs` even without `mcrs` (e.g. `-rs` version string). */
  isRs?: boolean;
}

const ONOFF = ["on", "off"];

/**
 * A setting read with `get` and written with `set`: the key, and the words of
 * each direction. A setting that is only read has no `write`; a secret that is
 * only written has no `read`.
 */
interface Setting {
  key: string;
  group: CliGroup;
  read?: Key;
  write?: Key;
  arg?: Key;
  values?: string[];
  mcrs?: number;
  cap?: number;
}

const SETTINGS: Setting[] = [
  // Radio and airtime.
  { key: "radio", group: "radio", read: "cli.about.radio", write: "cli.about.radio.set", arg: "node.cli.radio" },
  { key: "freq", group: "radio", read: "cli.about.freq" },
  { key: "tx", group: "radio", read: "cli.about.tx", write: "cli.about.tx.set", arg: "node.cli.dbm" },
  { key: "dutycycle", group: "radio", read: "cli.about.dutycycle", write: "cli.about.dutycycle.set", arg: "node.cli.dutycycle" },
  { key: "af", group: "radio", read: "cli.about.af", write: "cli.about.af.set", arg: "node.cli.af" },
  { key: "radio.rxgain", group: "radio", read: "cli.about.radio.rxgain", write: "cli.about.radio.rxgain.set", values: ONOFF },
  { key: "int.thresh", group: "radio", read: "cli.about.int.thresh", write: "cli.about.int.thresh.set", arg: "node.cli.intThresh" },
  { key: "agc.reset.interval", group: "radio", read: "cli.about.agc.reset.interval", write: "cli.about.agc.reset.interval.set", arg: "node.cli.agcReset" },
  { key: "cad", group: "radio", read: "cli.about.cad", write: "cli.about.cad.set", values: ONOFF },
  { key: "extra.sf", group: "radio", read: "cli.about.extra.sf", write: "cli.about.extra.sf.set", arg: "node.cli.extraSf" },
  { key: "radio.fem.rxgain", group: "radio", read: "cli.about.radio.fem.rxgain", write: "cli.about.radio.fem.rxgain.set", values: ONOFF },
  { key: "radio.fem.txgain", group: "radio", read: "cli.about.radio.fem.txgain", write: "cli.about.radio.fem.txgain.set", values: ONOFF },
  { key: "path.hash.mode", group: "radio", read: "cli.about.path.hash.mode", write: "cli.about.path.hash.mode.set", values: ["0", "1", "2"], arg: "node.cli.pathHash" },
  // Repeating.
  { key: "repeat", group: "repeat", read: "cli.about.repeat", write: "cli.about.repeat.set", values: ONOFF },
  { key: "flood.max", group: "repeat", read: "cli.about.flood.max", write: "cli.about.flood.max.set", arg: "node.cli.hops" },
  { key: "flood.max.advert", group: "repeat", read: "cli.about.flood.max.advert", write: "cli.about.flood.max.advert.set", arg: "node.cli.hops" },
  { key: "flood.max.unscoped", group: "repeat", read: "cli.about.flood.max.unscoped", write: "cli.about.flood.max.unscoped.set", arg: "node.cli.hops" },
  { key: "loop.detect", group: "repeat", read: "cli.about.loop.detect", write: "cli.about.loop.detect.set", values: ["off", "minimal", "moderate", "strict"] },
  { key: "txdelay", group: "repeat", read: "cli.about.txdelay", write: "cli.about.txdelay.set", arg: "node.cli.txdelay" },
  { key: "direct.txdelay", group: "repeat", read: "cli.about.direct.txdelay", write: "cli.about.direct.txdelay.set", arg: "node.cli.txdelay" },
  { key: "rxdelay", group: "repeat", read: "cli.about.rxdelay", write: "cli.about.rxdelay.set", arg: "node.cli.rxdelay" },
  { key: "multi.acks", group: "repeat", read: "cli.about.multi.acks", write: "cli.about.multi.acks.set", values: ["0", "1"] },
  // Adverts and identity.
  { key: "advert.interval", group: "where", read: "cli.about.advert.interval", write: "cli.about.advert.interval.set", arg: "node.cli.advertInterval" },
  { key: "flood.advert.interval", group: "where", read: "cli.about.flood.advert.interval", write: "cli.about.flood.advert.interval.set", arg: "node.cli.floodAdvertInterval" },
  { key: "name", group: "where", read: "cli.about.name", write: "cli.about.name.set", arg: "node.cli.name" },
  { key: "lat", group: "where", read: "cli.about.lat", write: "cli.about.lat.set", arg: "node.cli.degrees" },
  { key: "lon", group: "where", read: "cli.about.lon", write: "cli.about.lon.set", arg: "node.cli.degrees" },
  { key: "owner.info", group: "where", read: "cli.about.owner.info", write: "cli.about.owner.info.set", arg: "node.cli.ownerInfo" },
  { key: "public.key", group: "where", read: "cli.about.public.key" },
  { key: "role", group: "where", read: "cli.about.role" },
  // Access.
  { key: "prv.key", group: "access", write: "cli.about.prv.key.set", arg: "node.cli.privateKey" },
  { key: "guest.password", group: "access", read: "cli.about.guest.password", write: "cli.about.guest.password.set", arg: "node.cli.guestPassword" },
  { key: "allow.read.only", group: "access", read: "cli.about.allow.read.only", write: "cli.about.allow.read.only.set", values: ONOFF },
  // Power and board.
  { key: "adc.multiplier", group: "power", read: "cli.about.adc.multiplier", write: "cli.about.adc.multiplier.set", arg: "node.cli.adcMultiplier" },
  { key: "bootloader.ver", group: "power", read: "cli.about.bootloader.ver" },
  { key: "pwrmgt.support", group: "power", read: "cli.about.pwrmgt.support" },
  { key: "pwrmgt.source", group: "power", read: "cli.about.pwrmgt.source" },
  { key: "pwrmgt.bootreason", group: "power", read: "cli.about.pwrmgt.bootreason" },
  { key: "pwrmgt.bootmv", group: "power", read: "cli.about.pwrmgt.bootmv" },
  { key: "fan", group: "power", read: "cli.about.fan", write: "cli.about.fan.set", values: ["auto", "on", "off", "timeout "] },
  // Bridge builds.
  { key: "bridge.type", group: "net", read: "cli.about.bridge.type" },
  { key: "bridge.enabled", group: "net", read: "cli.about.bridge.enabled", write: "cli.about.bridge.enabled.set", values: ONOFF },
  { key: "bridge.delay", group: "net", read: "cli.about.bridge.delay", write: "cli.about.bridge.delay.set", arg: "node.cli.bridgeDelay" },
  { key: "bridge.source", group: "net", read: "cli.about.bridge.source", write: "cli.about.bridge.source.set", values: ["rx", "tx"] },
  { key: "bridge.baud", group: "net", read: "cli.about.bridge.baud", write: "cli.about.bridge.baud.set", arg: "node.cli.bridgeBaud" },
  { key: "bridge.channel", group: "net", read: "cli.about.bridge.channel", write: "cli.about.bridge.channel.set", arg: "node.cli.bridgeChannel" },
  { key: "bridge.secret", group: "net", read: "cli.about.bridge.secret", write: "cli.about.bridge.secret.set", arg: "node.cli.secret" },
  // MeshCoreTel.
  { key: "web", group: "net", read: "cli.about.web", write: "cli.about.web.set", values: ONOFF },
  { key: "web.stats", group: "net", write: "cli.about.web.stats.set", values: ONOFF },
  { key: "web.status", group: "net", read: "cli.about.web.status" },
  { key: "web.stats.status", group: "net", read: "cli.about.web.stats.status" },
  { key: "wifi.ssid", group: "net", read: "cli.about.wifi.ssid", write: "cli.about.wifi.ssid.set", arg: "node.cli.ssid" },
  { key: "wifi.pwd", group: "net", write: "cli.about.wifi.pwd.set", arg: "node.cli.password" },
  { key: "wifi.powersaving", group: "net", read: "cli.about.wifi.powersaving", write: "cli.about.wifi.powersaving.set", values: ["none", "min", "max"] },
  { key: "wifi.status", group: "net", read: "cli.about.wifi.status" },
  { key: "mqtt.status", group: "net", write: "cli.about.mqtt.status.set", values: ONOFF },
  { key: "mqtt.statuscfg", group: "net", read: "cli.about.mqtt.statuscfg" },
  { key: "mqtt.client_version", group: "net", read: "cli.about.mqtt.client_version" },
  { key: "mqtt.iata", group: "net", read: "cli.about.mqtt.iata", write: "cli.about.mqtt.iata.set", arg: "node.cli.iata" },
  { key: "mqtt.owner", group: "net", read: "cli.about.mqtt.owner", write: "cli.about.mqtt.owner.set", arg: "node.cli.mqttOwner" },
  { key: "mqtt.email", group: "net", read: "cli.about.mqtt.email", write: "cli.about.mqtt.email.set", arg: "node.cli.email" },
  { key: "mqtt.packets", group: "net", read: "cli.about.mqtt.packets", write: "cli.about.mqtt.packets.set", values: ONOFF },
  { key: "mqtt.raw", group: "net", read: "cli.about.mqtt.raw", write: "cli.about.mqtt.raw.set", values: ONOFF },
  { key: "mqtt.tx", group: "net", read: "cli.about.mqtt.tx", write: "cli.about.mqtt.tx.set", arg: "node.cli.value" },
  { key: "mqtt.meshcoretel", group: "net", read: "cli.about.mqtt.meshcoretel", write: "cli.about.mqtt.meshcoretel.set", values: ONOFF },
  { key: "mqtt.letsmesh-eu", group: "net", read: "cli.about.mqtt.letsmesh-eu", write: "cli.about.mqtt.letsmesh-eu.set", values: ONOFF },
  { key: "mqtt.letsmesh-us", group: "net", read: "cli.about.mqtt.letsmesh-us", write: "cli.about.mqtt.letsmesh-us.set", values: ONOFF },
];

const PLAIN: CliCommand[] = [
  { text: "ver", about: "cli.about.ver", group: "node" },
  { text: "board", about: "cli.about.board", group: "node" },
  { text: "memory", about: "cli.about.memory", group: "node" },
  { text: "clock", about: "cli.about.clock", group: "node" },
  { text: "clock sync", about: "cli.about.clockSync", group: "node" },
  { text: "time ", about: "cli.about.time", group: "node", arg: "node.cli.time" },
  { text: "power", about: "cli.about.power", group: "node" },
  { text: "powersaving", about: "cli.about.powersaving", group: "node" },
  { text: "powersaving ", about: "cli.about.powersaving.set", group: "node", values: ONOFF },
  { text: "reboot", about: "cli.about.reboot", group: "node" },
  { text: "clkreboot", about: "cli.about.clkreboot", group: "node" },
  { text: "poweroff", about: "cli.about.poweroff", group: "node" },
  { text: "shutdown", about: "cli.about.shutdown", group: "node" },
  { text: "start ota", about: "cli.about.startOta", group: "node" },
  { text: "log start", about: "cli.about.logStart", group: "node" },
  { text: "log stop", about: "cli.about.logStop", group: "node" },
  { text: "log erase", about: "cli.about.logErase", group: "node" },
  { text: "clear stats", about: "cli.about.clearStats", group: "node" },
  { text: "advert", about: "cli.about.advert", group: "advert" },
  { text: "advert.zerohop", about: "cli.about.advertZeroHop", group: "advert" },
  { text: "discover.neighbors", about: "cli.about.discoverNeighbors", group: "advert" },
  { text: "neighbors", about: "cli.about.neighbors", group: "advert" },
  { text: "neighbor.remove ", about: "cli.about.neighborRemove", group: "advert", arg: "node.cli.publicKey" },
  { text: "gps", about: "cli.about.gps", group: "where" },
  { text: "gps ", about: "cli.about.gps.set", group: "where", values: ["on", "off", "sync", "setloc", "advert", "diag"] },
  { text: "gps advert ", about: "cli.about.gpsAdvert", group: "where", values: ["none", "share", "prefs"] },
  { text: "region", about: "cli.about.region", group: "where" },
  { text: "region ", about: "cli.about.region.set", group: "where", values: ["load", "save", "home", "default", "get ", "put ", "remove ", "allowf ", "denyf ", "list ", "def "] },
  { text: "region home ", about: "cli.about.regionHome", group: "where", arg: "node.cli.region" },
  { text: "region default ", about: "cli.about.regionDefault", group: "where", arg: "node.cli.regionDefault" },
  { text: "region get ", about: "cli.about.regionGet", group: "where", arg: "node.cli.region" },
  { text: "region put ", about: "cli.about.regionPut", group: "where", arg: "node.cli.regionPut" },
  { text: "region remove ", about: "cli.about.regionRemove", group: "where", arg: "node.cli.region" },
  { text: "region allowf ", about: "cli.about.regionAllow", group: "where", arg: "node.cli.region" },
  { text: "region denyf ", about: "cli.about.regionDeny", group: "where", arg: "node.cli.region" },
  { text: "region list ", about: "cli.about.regionList", group: "where", values: ["allowed", "denied"] },
  { text: "region def ", about: "cli.about.regionDef", group: "where", arg: "node.cli.regionTree" },
  { text: "time.force ", about: "cli.about.timeForce", group: "where", arg: "node.cli.epochSeconds" },
  { text: "tempradio ", about: "cli.about.tempradio", group: "power", arg: "node.cli.tempradio" },
  { text: "password ", about: "cli.about.password", group: "access", arg: "node.cli.newPassword" },
  { text: "setperm ", about: "cli.about.setperm", group: "access", arg: "node.cli.setperm" },
  { text: "eth.status", about: "cli.about.ethStatus", group: "net" },
  { text: "send mqtt.status", about: "cli.about.sendMqttStatus", group: "net" },
  { text: "sensor list", about: "cli.about.sensorList", group: "sensors" },
  { text: "sensor get ", about: "cli.about.sensorGet", group: "sensors", arg: "node.cli.key" },
  { text: "sensor set ", about: "cli.about.sensorSet", group: "sensors", arg: "node.cli.keyValue" },
];

function commandsOf(plain: CliCommand[], settings: Setting[]): CliCommand[] {
  return [
    ...plain,
    ...settings.flatMap((s) =>
      s.read
        ? [
            {
              text: `get ${s.key}`,
              about: s.read,
              group: s.group,
              ...(s.mcrs !== undefined ? { mcrs: s.mcrs } : {}),
              ...(s.cap !== undefined ? { cap: s.cap } : {}),
            },
          ]
        : [],
    ),
    ...settings.flatMap((s) =>
      s.write
        ? [
            {
              text: `set ${s.key} `,
              about: s.write,
              group: s.group,
              ...(s.arg ? { arg: s.arg } : {}),
              ...(s.values ? { values: s.values } : {}),
              ...(s.mcrs !== undefined ? { mcrs: s.mcrs } : {}),
              ...(s.cap !== undefined ? { cap: s.cap } : {}),
            },
          ]
        : [],
    ),
  ];
}

export const COMMANDS: CliCommand[] = commandsOf(PLAIN, SETTINGS);

/**
 * What the connected radio itself answers on its own console (protocol 14): upstream
 * MeshCore's companion `handleCommand` and `CommonRadioPrefs`. A build without Wi-Fi
 * answers the `wifi.*` ones "Unknown command".
 */
const RADIO_SETTINGS: Setting[] = [
  { key: "radio", group: "radio", read: "cli.about.radio", write: "cli.about.radio.set", arg: "node.cli.radio" },
  { key: "freq", group: "radio", read: "cli.about.freq" },
  { key: "tx", group: "radio", read: "cli.about.tx", write: "cli.about.tx.set", arg: "node.cli.dbm" },
  { key: "dutycycle", group: "radio", read: "cli.about.dutycycle", write: "cli.about.dutycycle.set", arg: "node.cli.dutycycle" },
  { key: "af", group: "radio", read: "cli.about.af", write: "cli.about.af.set", arg: "node.cli.af" },
  { key: "radio.rxgain", group: "radio", read: "cli.about.radio.rxgain", write: "cli.about.radio.rxgain.set", values: ONOFF },
  { key: "int.thresh", group: "radio", read: "cli.about.int.thresh", write: "cli.about.int.thresh.set", arg: "node.cli.intThresh" },
  { key: "cad", group: "radio", read: "cli.about.cad", write: "cli.about.cad.set", values: ONOFF },
  // Heltec V4, V4 R8, Tracker V2 and T096 only; other boards answer "Unknown command".
  { key: "radio.fem.rxgain", group: "radio", read: "cli.about.radio.fem.rxgain", write: "cli.about.radio.fem.rxgain.set", values: ONOFF },
  { key: "agc.reset.interval", group: "radio", read: "cli.about.agc.reset.interval", write: "cli.about.agc.reset.interval.set", arg: "node.cli.agcReset" },
  { key: "path.hash.mode", group: "radio", read: "cli.about.path.hash.mode", write: "cli.about.path.hash.mode.set", values: ["0", "1", "2"], arg: "node.cli.pathHash" },
  { key: "txdelay", group: "repeat", read: "cli.about.txdelay", write: "cli.about.txdelay.set", arg: "node.cli.txdelay" },
  { key: "direct.txdelay", group: "repeat", read: "cli.about.direct.txdelay", write: "cli.about.direct.txdelay.set", arg: "node.cli.txdelay" },
  { key: "rxdelay", group: "repeat", read: "cli.about.rxdelay", write: "cli.about.rxdelay.set", arg: "node.cli.rxdelay" },
  { key: "multi.acks", group: "repeat", read: "cli.about.multi.acks", write: "cli.about.multi.acks.set", values: ["0", "1"] },
  { key: "name", group: "where", read: "cli.about.name", write: "cli.about.name.set", arg: "node.cli.name" },
  { key: "pin", group: "access", write: "cli.about.pin", arg: "node.cli.pin" },
  { key: "tz.offset", group: "where", read: "cli.about.tz.offset", write: "cli.about.tz.offset.set", arg: "node.cli.tzOffset" },
  { key: "wifi.ssid", group: "net", read: "cli.about.wifi.ssid", write: "cli.about.wifi.ssid.set", arg: "node.cli.ssid" },
  { key: "wifi.pwd", group: "net", write: "cli.about.wifi.pwd.set", arg: "node.cli.password" },
  { key: "wifi.enabled", group: "net", write: "cli.about.wifi.enabled", values: ["0", "1"] },
  { key: "wifi.status", group: "net", read: "cli.about.wifi.status" },
  { key: "wifi.ip", group: "net", read: "cli.about.wifi.ip" },
];

const RADIO_PLAIN: CliCommand[] = [
  { text: "ver", about: "cli.about.ver", group: "node" },
  { text: "board", about: "cli.about.board", group: "node" },
  { text: "set wifi.clear", about: "cli.about.wifiClear", group: "net" },
  { text: "reboot", about: "cli.about.reboot", group: "node" },
  { text: "poweroff", about: "cli.about.poweroff", group: "node" },
  { text: "shutdown", about: "cli.about.shutdown", group: "node" },
];

export const RADIO_COMMANDS: CliCommand[] = commandsOf(RADIO_PLAIN, RADIO_SETTINGS);

/** `meshcore-rs` settings common to both companions and repeaters/rooms. */
const MCRS_SHARED_SETTINGS: Setting[] = [
  { key: "fw.auto", group: "updates", read: "cli.about.fw.auto", write: "cli.about.fw.auto.set", values: ["off", "download", "install"], mcrs: 1 },
  { key: "fw.channel", group: "updates", read: "cli.about.fw.channel", write: "cli.about.fw.channel.set", values: ["stable", "dev"], mcrs: 1 },
  { key: "fw.source", group: "updates", read: "cli.about.fw.source", write: "cli.about.fw.source.set", arg: "node.cli.fwSource", values: ["auto"], mcrs: 1 },
  { key: "fw.server", group: "updates", read: "cli.about.fw.server", write: "cli.about.fw.server.set", arg: "node.cli.fwServer", mcrs: 1, cap: McrsCap.Wifi },
  { key: "fw.root", group: "updates", read: "cli.about.fw.root", write: "cli.about.fw.root.set", arg: "node.cli.fwKeys", mcrs: 1 },
  { key: "fw.owner", group: "updates", read: "cli.about.fw.owner", write: "cli.about.fw.owner.set", arg: "node.cli.fwKeys", mcrs: 1 },
  { key: "time.status", group: "node", read: "cli.about.time.status", mcrs: 1, cap: McrsCap.TimeSync },
  { key: "time.sync", group: "node", read: "cli.about.time.sync", write: "cli.about.time.sync.set", values: ["off", "listen", "auto"], mcrs: 1, cap: McrsCap.TimeSync },
  { key: "screen", group: "power", read: "cli.about.screen", write: "cli.about.screen.set", values: ["auto", "manual", "off"], mcrs: 1, cap: McrsCap.Screen },
  { key: "led", group: "power", read: "cli.about.led", write: "cli.about.led.set", values: ONOFF, mcrs: 1, cap: McrsCap.Led },
];

/** `meshcore-rs` plain commands common to both companions and repeaters/rooms. */
const MCRS_SHARED_PLAIN: CliCommand[] = [
  { text: "mcrs", about: "cli.about.mcrs", group: "node", mcrs: 1 },
  { text: "fw", about: "cli.about.fw", group: "updates", mcrs: 1 },
  { text: "fw check", about: "cli.about.fwCheck", group: "updates", mcrs: 1 },
  { text: "fw update", about: "cli.about.fwUpdate", group: "updates", mcrs: 1, cap: McrsCap.Ota },
  { text: "fw install", about: "cli.about.fwInstall", group: "updates", mcrs: 1, cap: McrsCap.Ota },
  { text: "fw rollback", about: "cli.about.fwRollback", group: "updates", mcrs: 1, cap: McrsCap.Ota },
  { text: "time sync", about: "cli.about.timeSync", group: "node", mcrs: 1, cap: McrsCap.TimeSync },
  { text: "sensor scan", about: "cli.about.sensorScan", group: "sensors", mcrs: 1 },
];

/** Extra `meshcore-rs` settings on a repeater or room. */
const MCRS_NODE_SETTINGS: Setting[] = [
  ...MCRS_SHARED_SETTINGS,
  { key: "fw.serve", group: "updates", read: "cli.about.fw.serve", write: "cli.about.fw.serve.set", values: ONOFF, mcrs: 1, cap: McrsCap.Wifi },
  { key: "time.serve", group: "node", read: "cli.about.time.serve", write: "cli.about.time.serve.set", values: ONOFF, mcrs: 1, cap: McrsCap.Wifi },
  { key: "time.server", group: "node", read: "cli.about.time.server", write: "cli.about.time.server.set", arg: "node.cli.timeServer", mcrs: 1, cap: McrsCap.Wifi },
  { key: "time.beacon", group: "node", read: "cli.about.time.beacon", write: "cli.about.time.beacon.set", arg: "node.cli.timeBeacon", mcrs: 1, cap: McrsCap.Wifi },
  { key: "time.key", group: "node", read: "cli.about.time.key", write: "cli.about.time.key.set", arg: "node.cli.timeKey", mcrs: 1 },
  { key: "dyncr", group: "radio", read: "cli.about.dyncr", write: "cli.about.dyncr.set", values: ONOFF, mcrs: 1 },
  { key: "room", group: "node", read: "cli.about.room", write: "cli.about.room.set", values: ONOFF, mcrs: 1 },
  { key: "buzzer", group: "power", read: "cli.about.buzzer", write: "cli.about.buzzer.set", values: ONOFF, mcrs: 1, cap: McrsCap.Buzzer },
  { key: "mqtt.ommesh", group: "net", read: "cli.about.mqtt.ommesh", write: "cli.about.mqtt.ommesh.set", values: ONOFF, mcrs: 1, cap: McrsCap.Mqtt },
];

const MCRS_NODE_PLAIN: CliCommand[] = [
  ...MCRS_SHARED_PLAIN,
  { text: "fw ble", about: "cli.about.fwBle", group: "updates", mcrs: 1, cap: McrsCap.BleOta },
  { text: "fw wifi", about: "cli.about.fwWifi", group: "updates", mcrs: 1, cap: McrsCap.WifiOta },
  { text: "powersaving stats", about: "cli.about.powersavingStats", group: "power", mcrs: 1, cap: McrsCap.Powersaving },
  { text: "sensor add ", about: "cli.about.sensorAdd", group: "sensors", arg: "node.cli.sensorAdd", mcrs: 1 },
  { text: "sensor del ", about: "cli.about.sensorDel", group: "sensors", arg: "node.cli.sensorDel", mcrs: 1 },
];

/** Extra `meshcore-rs` settings on a connected companion radio. */
const MCRS_RADIO_SETTINGS: Setting[] = [
  ...MCRS_SHARED_SETTINGS,
  { key: "rtpath", group: "repeat", read: "cli.about.rtpath", write: "cli.about.rtpath.set", values: ONOFF, mcrs: 1 },
  { key: "ui.show_clock", group: "power", read: "cli.about.ui.show_clock", write: "cli.about.ui.show_clock.set", values: ["0", "1"], mcrs: 1, cap: McrsCap.Screen },
  { key: "advert.interval", group: "where", read: "cli.about.advert.interval", write: "cli.about.advert.interval.set", arg: "node.cli.advertInterval", mcrs: 1 },
  { key: "flood.advert.interval", group: "where", read: "cli.about.flood.advert.interval", write: "cli.about.flood.advert.interval.set", arg: "node.cli.floodAdvertInterval", mcrs: 1 },
  { key: "adc.multiplier", group: "power", read: "cli.about.adc.multiplier", write: "cli.about.adc.multiplier.set", arg: "node.cli.adcMultiplier", mcrs: 1, cap: McrsCap.AdcMult },
  { key: "wifi.enabled", group: "net", read: "cli.about.wifi.enabled.read", mcrs: 1, cap: McrsCap.Wifi },
];

const MCRS_RADIO_PLAIN: CliCommand[] = [
  ...MCRS_SHARED_PLAIN,
  { text: "log", about: "cli.about.log", group: "node", mcrs: 1 },
  { text: "gps", about: "cli.about.gps", group: "where", mcrs: 1, cap: McrsCap.Gps },
  { text: "gps ", about: "cli.about.gps.set", group: "where", values: ["on", "off", "sync", "setloc", "advert", "diag"], mcrs: 1, cap: McrsCap.Gps },
  { text: "gps advert ", about: "cli.about.gpsAdvert", group: "where", values: ["none", "share", "prefs"], mcrs: 1 },
];

export const MCRS_NODE_COMMANDS: CliCommand[] = commandsOf(MCRS_NODE_PLAIN, MCRS_NODE_SETTINGS);
export const MCRS_RADIO_COMMANDS: CliCommand[] = commandsOf(MCRS_RADIO_PLAIN, MCRS_RADIO_SETTINGS);

/** Which console a suggestion is for: a node's over the air, or the connected radio's own. */
export type CliTarget = "node" | "radio";

/**
 * The commands available on `target`, extended with `meshcore-rs` commands
 * when `ctx` says the target runs it. When full `McrsInfo` is available,
 * hardware-dependent commands are filtered by its capability bitmask.
 */
export function commandsFor(target: CliTarget, ctx?: CliContext): CliCommand[] {
  const base = target === "radio" ? RADIO_COMMANDS : COMMANDS;
  const mcrs = ctx?.mcrs ?? null;
  if (!mcrs && !ctx?.isRs) return base;
  const extra = target === "radio" ? MCRS_RADIO_COMMANDS : MCRS_NODE_COMMANDS;
  const filtered = extra.filter((c) => {
    const need = c.mcrs ?? 1;
    if (mcrs) {
      if (!hasMcrsVersion(mcrs, need)) return false;
      if (c.cap !== undefined && !hasMcrsCap(mcrs, c.cap)) return false;
      return true;
    }
    return need <= 1;
  });
  return [...base, ...filtered];
}

/** Offered before anything is typed. */
const FIRST: Record<CliTarget, string[]> = {
  node: ["ver", "clock", "neighbors", "get radio", "get dutycycle", "advert"],
  radio: ["ver", "get radio", "get tx", "get name", "board"],
};

export interface Suggestion {
  /** What the chip says. */
  label: string;
  /** What a tap puts in the field. */
  fill: string;
  /** What it does; a value has none. */
  about?: Key;
  /** What the value after this command is, when it takes one. */
  hint?: string;
}

export interface Suggestions {
  chips: Suggestion[];
  /** What the value after the first chip is, once a command that takes one is in front. */
  hint: string | null;
  /** How many commands match what is typed, of which the chips are the first `limit`. */
  total: number;
}

/**
 * What to offer for what is typed so far. Typed up to a command that takes
 * a value: the values it takes, and what a value is. Otherwise the commands
 * that start with it, then those with it anywhere in them, so "duty" finds
 * both `get dutycycle` and `set dutycycle`. Each comes with the words of what
 * it does, for the list beside the field and the reference.
 */
export function suggest(draft: string, target: CliTarget = "node", limit = 12, ctx?: CliContext): Suggestions {
  const list = commandsFor(target, ctx);
  const typed = draft.replace(/^\s+/, "").replace(/\s+/g, " ").toLowerCase();
  if (typed.trim() === "") {
    const starters = ctx?.mcrs || ctx?.isRs ? [...FIRST[target], "fw"] : FIRST[target];
    const chips = starters.map((text): Suggestion => {
      const found = list.find((c) => c.text.trim() === text);
      return { label: text, fill: text, ...(found ? { about: found.about } : {}) };
    });
    return { chips, hint: null, total: chips.length };
  }
  // The longest command typed in full, with its value to come or on its way; "set repeat" is as good as "set repeat ".
  const full = list.some((c) => c.values && c.text === `${typed} `) ? `${typed} ` : typed;
  const at = list.filter((c) => c.text.endsWith(" ") && full.startsWith(c.text) && (c.arg || c.values)).sort((a, b) => b.text.length - a.text.length)[0];
  if (at) {
    const rest = full.slice(at.text.length);
    const deeper = list.filter((c) => c !== at && c.text.startsWith(full) && c.text.length > full.length);
    if (deeper.length === 0 || rest.length > 0 || at.values) {
      const chips: Suggestion[] = (at.values ?? []).filter((v) => v.startsWith(rest) && v !== rest).map((v) => ({ label: v.trim(), fill: at.text + v }));
      const seen = new Set(chips.map((c) => c.fill.trim()));
      for (const d of deeper) {
        const sub = d.text.slice(at.text.length);
        if (!seen.has(d.text.trim()) && sub.trim() !== rest.trim()) {
          seen.add(d.text.trim());
          chips.push({ label: sub.trim(), fill: d.text, about: d.about, ...(d.arg ? { hint: t(d.arg) } : {}) });
        }
      }
      return { chips, hint: at.arg ? t(at.arg) : null, total: chips.length };
    }
  }
  const word = typed.trim();
  const starts = list.filter((c) => c.text.startsWith(typed) && c.text.trim() !== word);
  const inside = word.length >= 2 ? list.filter((c) => !c.text.startsWith(typed) && c.text.includes(word)) : [];
  const seen = new Set<string>();
  const chips: Suggestion[] = [];
  let total = 0;
  for (const c of [...starts, ...inside]) {
    const label = c.text.trim();
    if (seen.has(label)) continue;
    seen.add(label);
    total += 1;
    if (chips.length < limit) chips.push({ label, fill: c.text, about: c.about, ...(c.arg ? { hint: t(c.arg) } : {}) });
  }
  // What the value after the first suggestion is: that is what Tab fills in.
  return { chips, hint: chips[0]?.hint ?? null, total };
}

/**
 * Steps the arrow-key highlight through the list of suggestions shown above the
 * console field: `null` means typing freely (Enter sends what is typed), while an
 * index points to that row (Enter or Tab puts it in the field). Moving past
 * either end returns to the field, so a stray arrow press can be undone in one step.
 */
export function stepPick(current: number | null, count: number, key: "ArrowUp" | "ArrowDown"): number | null {
  if (count <= 0) return null;
  if (current === null) return key === "ArrowDown" ? 0 : count - 1;
  const next = current + (key === "ArrowDown" ? 1 : -1);
  return next < 0 || next >= count ? null : next;
}

export interface ConsoleAssistInput {
  draft: string;
  suggestions: Suggestions;
  focused: boolean;
  recall: number | null;
  picked: number | null;
  dismissed: boolean;
  dismissedHint: string | null;
  limit: number;
}

export interface ConsoleAssist {
  /** Rows offered in the floating list above the field (empty when hidden). */
  shown: Suggestion[];
  /** Highlighted row in `shown`, or null when typing freely. */
  activePick: number | null;
  /** Value hint for the highlighted row or typed command, if any. */
  activeHint: string | null;
  /** True when the floating command/value card should show over the log. */
  showList: boolean;
  /** True when a standalone value hint should sit in flow inside the composer frame. */
  showHintBar: boolean;
}

/**
 * Decides what aid the console shows for the current draft: matching commands
 * and discrete values float over the log while the field has focus, whereas a
 * standalone value hint (once the command itself is typed) sits inside the
 * composer frame so it never covers the last line of the terminal.
 */
export function consoleAssist(input: ConsoleAssistInput): ConsoleAssist {
  const { draft, suggestions, focused, recall, picked, dismissed, dismissedHint, limit } = input;
  const typed = draft.trim() !== "";
  const matched = typed && recall === null ? suggestions.chips.slice(0, limit) : [];
  const shown = focused && !dismissed ? matched : [];
  const activePick = picked !== null && picked < shown.length ? picked : null;
  const activeHint =
    activePick !== null ? (shown[activePick]?.about ? (shown[activePick]?.hint ?? null) : suggestions.hint) : suggestions.hint;
  const showList = shown.length > 0;
  const showHintBar = Boolean(typed && recall === null && matched.length === 0 && activeHint && activeHint !== dismissedHint);
  return { shown, activePick, activeHint, showList, showHintBar };
}

export interface HistoryWalk {
  /** Index into `past`, or null when back at the draft. */
  index: number | null;
  /** Text now in the field. */
  draft: string;
  /** What was typed before entering history, kept until leaving it again. */
  saved: string;
}

/**
 * Steps through sent commands with Up and Down. Down on a field that is not
 * walking history does nothing instead of wiping what is typed; Up remembers
 * whatever was in the field so walking back down restores it.
 */
export function stepHistory(current: HistoryWalk, past: readonly string[], key: "ArrowUp" | "ArrowDown"): HistoryWalk | null {
  if (past.length === 0) return null;
  if (current.index === null) {
    if (key === "ArrowDown") return null;
    return { index: past.length - 1, draft: past[past.length - 1]!, saved: current.draft };
  }
  const next = current.index + (key === "ArrowUp" ? -1 : 1);
  if (next < 0) return { ...current, index: 0, draft: past[0]! };
  if (next >= past.length) return { index: null, draft: current.saved, saved: "" };
  return { ...current, index: next, draft: past[next]! };
}

/** Settings whose empty value must be sent with a trailing space (`set <key> `) for upstream firmware. */
const CLEARABLE_SET = /^(?:room\s+)?set\s+(?:guest\.password|owner\.info)$/;

/**
 * Prepares a typed console command for the radio: strips surrounding whitespace,
 * then restores the single trailing space upstream `CommonCLI` requires when
 * clearing `guest.password` or `owner.info`.
 */
export function prepareConsoleCommand(draft: string): string {
  const trimmed = draft.trim();
  if (!trimmed) return "";
  return CLEARABLE_SET.test(trimmed) ? `${trimmed} ` : trimmed;
}
