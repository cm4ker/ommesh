# Radio copy format

Ommesh saves a whole radio to one file, and writes it back onto the same radio or another, under Settings › Copy and move. It is how you move to a new radio: save a copy on the old one, connect the new one, choose Restore from a copy, and the new radio becomes the same node, with the same contacts, channels and chats.

The file is JSON, `ommesh-backup` version 1. It holds the radio's private key, so it is not for passing on: whoever has it can write as that radio. A [history file](history-format.md) is the one to share.

## A file

```json
{
  "format": "ommesh-backup",
  "version": 1,
  "saved": "2026-10-22T08:12:40.000Z",
  "by": "Ommesh 0.9.1",
  "key": { "name": "Node-21", "publicKey": "a2f04c…4a2c", "privateKey": "…128 hex digits…" },
  "radio": {
    "name": "Node-21",
    "publicKey": "a2f04c…4a2c",
    "settings": {
      "radio": { "frequencyKhz": 869618, "bandwidthHz": 62500, "spreadingFactor": 8, "codingRate": 8 },
      "txPower": 22,
      "location": { "lat": 55.75, "lon": 37.61 },
      "other": { "manualAddContacts": 0, "telemetryModeBase": 0, "telemetryModeLocation": 0, "telemetryModeEnvironment": 0, "advertLocPolicy": 0, "multiAcks": 0 },
      "tuning": { "rxDelayBase": 0, "airtimeFactor": 1 },
      "pathHashMode": 0,
      "blePin": 482913
    },
    "channels": [{ "slot": 0, "name": "Public", "secret": "8b3387e9c5cdea6ac9e5edbaa115cd72" }]
  },
  "history": { "format": "ommesh-history", "version": 1, "radio": { "key": "a2f04c…4a2c" }, "channels": [], "contacts": [], "messages": [] },
  "app": { "settings": { "theme": "one-dark", "chatLevel:ch:1": "mentions" }, "routing": { "resetAfterMin": 60, "contacts": {} }, "channelRegions": {} }
}
```

## Parts

- `key`: the radio's key pair, as the key file `ommesh-key` holds it. Null when the radio's firmware does not give its key out; a copy without a key makes another radio a node of its own. The private key has to be the one `radio.publicKey` comes from.
- `radio.settings`: what the companion firmware lets an app set. Each field may be left out, and then the radio keeps what it has. `radio.repeat` (firmware 9), `autoAdd`, `pathHashMode` (firmware 10) and `region` (firmware 11) are only there when the radio said them, and only written to a radio that has them. A `txPower` higher than the new radio's amplifier gives is lowered to what it gives.
- `radio.channels`: each channel with the slot it had. On the radio it goes to, a channel takes the same slot while that is free, else the first free one; one the radio has already, by its secret, is not written again.
- `history`: a whole history file. Its contacts with `on: "radio"` (or no `on`) are written onto the radio, favourites first, then those written with, then by their last advert, until the radio is full; the rest, and those removed or only heard, go to the app's Removed list as a history file's do. Its messages join the radio's chats on this device once the radio holds the copy's key.
- `app`: what this app keeps for the radio beside its history. `settings` are named as two apps sharing a radio name them, `<setting>` or `<setting>:<id>`, a chat's id being `ch:<slot>` or `c:<key>` and a pin's `<radio>/<chat>`; a channel's settings follow it to the slot it went to. `routing` and `channelRegions` are the routes pinned or set by hand and the channels' own regions, as the app keeps them. Node passwords, drafts and consoles are not in a copy.

## Writing a copy back

1. The key, first. A firmware that takes no key says so before anything else is written, and the radio reads its contacts anew when it takes one, so contacts written before it would be lost.
2. The settings, each only where the radio has it otherwise.
3. The channels.
4. The contacts, one at a time.
5. The name.
6. A reboot, when the radio took a key or a Bluetooth PIN: it takes both only when it starts. The link that comes back finds the radio holding the copy's key, and the chats and the app's settings are brought in.

Between two writes Ommesh waits 250 ms: each is a write to the radio's flash, and some boards fall over when they come back to back. What the radio already has is skipped, so a copy that stopped half way can be written again.

The radio's own contacts and channels stay. Two radios with one key get in each other's way on the air, so the old radio should be switched off or reset once the new one has its key; Ommesh says so when the old one is connected again.

The key and history pages take a copy too: Restore the key takes its key, and Chat history its history.
