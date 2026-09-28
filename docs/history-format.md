# History file format

Ommesh saves a radio's chats, contacts and messages to a file, and brings them in from one, under Settings › Chat history. The file is JSON in the format described here, `ommesh-history` version 1. Any program may write or read it: a file another program writes by these rules comes into Ommesh the same way as one Ommesh saved.

- Schema: [`schema/history-v1.json`](schema/history-v1.json) (JSON Schema 2020-12). Each file names it in `$schema`.
- Example: [`schema/history-v1.example.json`](schema/history-v1.example.json).

The app's tests check both against the code: every field Ommesh writes has to be in the schema, and the example has to come in.

## A file

```json
{
  "$schema": "https://raw.githubusercontent.com/cm4ker/ommesh/master/docs/schema/history-v1.json",
  "format": "ommesh-history",
  "version": 1,
  "exportedAt": "2026-09-28T14:03:11.000Z",
  "app": "Ommesh 0.4.0",
  "radio": { "key": "a2f04c…4a2c", "name": "Node-21" },
  "channels": [{ "secret": "8b3387e9c5cdea6ac9e5edbaa115cd72", "name": "Public" }],
  "contacts": [{ "key": "b0c4e1…19ad", "name": "Kolya", "kind": "chat", "on": "radio", "route": ["b9", "3a"] }],
  "messages": [
    {
      "chat": { "channel": "8b3387e9c5cdea6ac9e5edbaa115cd72" },
      "direction": "in",
      "text": "всем привет",
      "from": { "name": "Alice" },
      "sentAt": "2026-09-28T13:59:40.000Z",
      "receivedAt": "2026-09-28T13:59:41.300Z",
      "snr": 7.5,
      "hops": 1
    }
  ]
}
```

A file holds the history of one radio, named by its public key in `radio.key`. Only `format`, `version` and `radio.key` are required at the top; `channels`, `contacts` and `messages` may be left out when there are none.

## Values

| What | How it is written |
| --- | --- |
| Times | RFC 3339 strings. Ommesh writes UTC with a `Z` and milliseconds. |
| Keys | A node's public key is 64 hex digits; the start of one (`from.key`, `chat.prefix`) is whole bytes of it. |
| Channel secrets | 32 hex digits, the channel's 16-byte secret. |
| Paths | A list of relays, first relay first, each the hex hash it signs the path with: one to four bytes, the same size for every relay of one path. |

Hex is written lower-case and read in either case.

## Channels

`{ "secret", "name" }`. A channel is known by its secret, not by the slot it sits in, because slots differ from radio to radio. A message goes to the slot of the radio that holds the same secret; when no slot does, the message is left out, and Ommesh says which channels and how many messages.

## Contacts

| Field | |
| --- | --- |
| `key` | Required. |
| `name` | The name it advertised, or the one given to it. |
| `kind` | `chat`, `repeater`, `room` or `sensor`; `chat` when absent. |
| `on` | `radio`: the radio held it. `removed`: taken off the radio and kept to be put back. `heard`: its advert was heard but the radio did not keep it. `radio` when absent. |
| `removedBy` | For a removed one: `you`, `tidy` (the tidy-up rule) or `radio` (the radio itself, when it was full or another app removed it). |
| `flags` | The contact's flags byte as MeshCore firmware keeps it; bit 0 marks a favourite. |
| `lat`, `lon` | Degrees, from its advert. Absent when it gave no position. |
| `lastAdvert` | When its last advert was sent, by the node's clock. |
| `lastHeard` | When it was last heard, by the clock of the device that kept the history. |
| `route` | The route the radio held to it: `null` for none (the next message floods), `[]` for a neighbour reached direct. |

## Messages

| Field | |
| --- | --- |
| `id` | Any string. Ommesh keeps it; it does not decide whether two messages are the same. |
| `chat` | Exactly one of `{ "channel": secret }`, `{ "contact": key }`, or `{ "prefix": key start }` for a sender the radio could not name. A room's posts are in the room's chat. |
| `direction` | `in`, or `out` for one sent from this radio. |
| `text` | On a channel, without the sender's name in front. |
| `sentAt` | By the sender's clock, which can be far off. |
| `receivedAt` | When it came in or was written, by the device's clock. Taken as `sentAt` when absent. |
| `from` | For one that came in: `name` and `key` (the start of the sender's key), as far as known. On a channel only the name travels. In a room, the author of the post. |
| `roomPost` | `true` for a post a room server relayed, signed by its author. |
| `snr`, `hops` | How well the radio heard it (dB), and how many relays it passed. |
| `status` | For an out message: `queued`, `sending`, `sent`, `delivered`, `unheard`, `unconfirmed` or `failed`. |
| `roundTripMs`, `error`, `route` | For an out direct message: from sending to the acknowledgement, what went wrong, and the relays it went along. |
| `echoes` | Copies the radio heard, one per path, each `{ "path", "snr" }`: for an out channel message, repeaters sending it on; for one that came in, each copy that reached the radio. |

## Changes to the format

Readers pass over fields they do not know. A new field that an older reader can do without comes as an optional one, and the version stays 1. `version` goes up only when a reader of version 1 would read the file wrong; Ommesh refuses a file of a version newer than it knows and asks for an update.

## What Ommesh does with a file

Ommesh brings a file in to the radio it is connected to, or whose chats it shows, and refuses a file of another radio. Before anything is added it shows how many messages, chats and contacts the file brings, the days they span, and what is left out.

- A message is added once. Two messages are the same when their chat, direction, `sentAt` to the second, sender and text match, so bringing the same file in twice adds nothing.
- Messages brought in are not counted as unread.
- A message of ours that was `queued` elsewhere is marked `failed` rather than sent now, and one still `sending` is marked `unconfirmed`.
- A contact the radio holds stays as the radio has it. One the file has on the radio or removed, and the radio does not hold, goes to Removed, to be put back from there. A node heard but not kept comes in when it was heard within the last week, as nodes heard by the app do.
- Everything in the file comes in, however old.

Node passwords, read marks, drafts, routes set by hand, a node's console and readings, and the app's settings are not in the file. The file does hold private messages and channel secrets, so it should be kept as carefully as a password.

## The MeshCore app's database

Ommesh also brings in the database the official MeshCore app exports (an SQLite file). It is read into this same format first, then brought in the same way:

| MeshCore app | History file |
| --- | --- |
| `channels`: `secret`, `name` | `channels` |
| `contacts` | `contacts`, `on: "radio"`; `custom_name` over `adv_name`; `adv_lat`, `adv_lon` in millionths of a degree; `out_path_len` of −1 is no route |
| `discovered_contacts` not among `contacts` | `contacts`, `on: "heard"`, heard when their last advert was sent |
| `channel_messages` | `messages` in `{ "channel": channel_secret }`; `from` set marks one of ours; others split `Name: text` into `from.name` and `text` |
| `channel_message_heard_repeats` | `echoes` of our channel messages |
| `contact_messages` | `messages` in `{ "contact": key }`; `status` `received` is one that came in, `delivered`, `failed` and `sending` are ours; `room_post_author_pub_key_prefix` makes a room post |
| `sender_timestamp` (s), `timestamp` (ms) | `sentAt`, `receivedAt` |
| `path_len` | `hops` (its low six bits; −1 came direct) |
| `contact_messages` with `txt_type` 1 | Left out: a node's console |

The radio a database belongs to is taken from its own messages, which carry the radio's key.
