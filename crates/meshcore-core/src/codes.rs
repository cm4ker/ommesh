//! The numbers of the MeshCore companion protocol this core reads or writes.
//!
//! Copied from `examples/companion_radio/MyMesh.cpp` in the firmware tree, as
//! `packages/meshcore/src/protocol/codes.ts` is: the firmware is the only
//! specification that cannot be out of date.

// App → radio.
pub const CMD_APP_START: u8 = 1;
pub const CMD_SEND_TXT_MSG: u8 = 2;
pub const CMD_SEND_CHANNEL_TXT_MSG: u8 = 3;
pub const CMD_GET_CONTACTS: u8 = 4;
pub const CMD_GET_DEVICE_TIME: u8 = 5;
pub const CMD_SET_DEVICE_TIME: u8 = 6;
pub const CMD_SEND_SELF_ADVERT: u8 = 7;
pub const CMD_SET_ADVERT_NAME: u8 = 8;
pub const CMD_ADD_UPDATE_CONTACT: u8 = 9;
pub const CMD_SYNC_NEXT_MESSAGE: u8 = 10;
pub const CMD_SET_RADIO_PARAMS: u8 = 11;
pub const CMD_SET_RADIO_TX_POWER: u8 = 12;
pub const CMD_RESET_PATH: u8 = 13;
pub const CMD_SET_ADVERT_LAT_LON: u8 = 14;
pub const CMD_REMOVE_CONTACT: u8 = 15;
pub const CMD_SHARE_CONTACT: u8 = 16;
pub const CMD_EXPORT_CONTACT: u8 = 17;
pub const CMD_IMPORT_CONTACT: u8 = 18;
pub const CMD_REBOOT: u8 = 19;
pub const CMD_GET_BATT_AND_STORAGE: u8 = 20;
pub const CMD_SET_TUNING_PARAMS: u8 = 21;
pub const CMD_DEVICE_QUERY: u8 = 22;
pub const CMD_EXPORT_PRIVATE_KEY: u8 = 23;
pub const CMD_IMPORT_PRIVATE_KEY: u8 = 24;
pub const CMD_SEND_RAW_DATA: u8 = 25;
pub const CMD_SEND_LOGIN: u8 = 26;
pub const CMD_SEND_STATUS_REQ: u8 = 27;
pub const CMD_HAS_CONNECTION: u8 = 28;
pub const CMD_LOGOUT: u8 = 29;
pub const CMD_GET_CONTACT_BY_KEY: u8 = 30;
pub const CMD_GET_CHANNEL: u8 = 31;
pub const CMD_SET_CHANNEL: u8 = 32;
pub const CMD_SEND_TRACE_PATH: u8 = 36;
pub const CMD_SET_DEVICE_PIN: u8 = 37;
pub const CMD_SET_OTHER_PARAMS: u8 = 38;
pub const CMD_SEND_TELEMETRY_REQ: u8 = 39;
pub const CMD_GET_CUSTOM_VARS: u8 = 40;
pub const CMD_SET_CUSTOM_VAR: u8 = 41;
pub const CMD_GET_ADVERT_PATH: u8 = 42;
pub const CMD_GET_TUNING_PARAMS: u8 = 43;
pub const CMD_SEND_BINARY_REQ: u8 = 50;
pub const CMD_FACTORY_RESET: u8 = 51;
pub const CMD_SEND_PATH_DISCOVERY_REQ: u8 = 52;
pub const CMD_SET_FLOOD_SCOPE_KEY: u8 = 54;
pub const CMD_SEND_CONTROL_DATA: u8 = 55;
pub const CMD_GET_STATS: u8 = 56;
pub const CMD_SEND_ANON_REQ: u8 = 57;
pub const CMD_SET_AUTO_ADD_CONFIG: u8 = 58;
pub const CMD_GET_AUTO_ADD_CONFIG: u8 = 59;
pub const CMD_GET_ALLOWED_REPEAT_FREQ: u8 = 60;
pub const CMD_SET_PATH_HASH_MODE: u8 = 61;
pub const CMD_SEND_CHANNEL_DATA: u8 = 62;
pub const CMD_SET_DEFAULT_FLOOD_SCOPE: u8 = 63;
pub const CMD_GET_DEFAULT_FLOOD_SCOPE: u8 = 64;
pub const CMD_RUN_CLI_COMMAND: u8 = 66;

// Radio → app, in answer to a command. Always below 0x80.
pub const RESP_OK: u8 = 0;
pub const RESP_ERR: u8 = 1;
pub const RESP_CONTACTS_START: u8 = 2;
pub const RESP_CONTACT: u8 = 3;
pub const RESP_END_OF_CONTACTS: u8 = 4;
pub const RESP_SELF_INFO: u8 = 5;
pub const RESP_SENT: u8 = 6;
pub const RESP_CONTACT_MSG_RECV: u8 = 7;
pub const RESP_CHANNEL_MSG_RECV: u8 = 8;
pub const RESP_CURR_TIME: u8 = 9;
pub const RESP_NO_MORE_MESSAGES: u8 = 10;
pub const RESP_EXPORT_CONTACT: u8 = 11;
pub const RESP_BATT_AND_STORAGE: u8 = 12;
pub const RESP_DEVICE_INFO: u8 = 13;
pub const RESP_PRIVATE_KEY: u8 = 14;
pub const RESP_DISABLED: u8 = 15;
pub const RESP_CONTACT_MSG_RECV_V3: u8 = 16;
pub const RESP_CHANNEL_MSG_RECV_V3: u8 = 17;
pub const RESP_CHANNEL_INFO: u8 = 18;
pub const RESP_CUSTOM_VARS: u8 = 21;
pub const RESP_ADVERT_PATH: u8 = 22;
pub const RESP_TUNING_PARAMS: u8 = 23;
pub const RESP_STATS: u8 = 24;
pub const RESP_AUTO_ADD_CONFIG: u8 = 25;
pub const RESP_ALLOWED_REPEAT_FREQ: u8 = 26;
pub const RESP_CHANNEL_DATA_RECV: u8 = 27;
pub const RESP_DEFAULT_FLOOD_SCOPE: u8 = 28;
pub const RESP_CLI_REPLY: u8 = 29;
/// The highest answer code this core knows.
pub const RESP_LAST: u8 = RESP_CLI_REPLY;

// Radio → app, unprompted. Always 0x80 and above, which is how they are told apart.
pub const PUSH_MSG_WAITING: u8 = 0x83;
pub const PUSH_NEW_ADVERT: u8 = 0x8a;
pub const PUSH_CONTROL_DATA: u8 = 0x8e;
/// Not the firmware's: a text or a reaction the other client sharing the radio sent, as
/// `0xf0`, the command's length, the command, then the radio's answer.
pub const PUSH_MIRROR: u8 = 0xf0;
/// Not the firmware's either: a frame between the two apps sharing the radio, which the mux
/// takes and never writes to the radio. `0xf1`, then what it is: [`PEER_HELLO`] from the mux,
/// or [`PEER_ENTRY`] from one app to the other.
pub const PEER: u8 = 0xf1;
/// `0xf1, 0, version, side`: the mux tells an app, after the radio said who it is, that it
/// shares the radio through the phone, and which side it is (0 the phone's own page, 1 a computer).
pub const PEER_HELLO: u8 = 0;
/// `0xf1, 1, key length, key, value`: one thing the app keeps alike with the other, the latest
/// by its key standing for every one before it (`r:<conversation>` a read mark, `s:<name>` a setting).
pub const PEER_ENTRY: u8 = 1;
/// What the mux's hello says it can do.
pub const PEER_VERSION: u8 = 1;

// Control packets, by the first byte of their payload (`onControlDataRecv` in
// `examples/simple_repeater/MyMesh.cpp`).
/// "Who hears me"; the low bit asks for key prefixes only.
pub const CTL_TYPE_NODE_DISCOVER_REQ: u8 = 0x80;
/// The answer; the low four bits are the node's advert type.
pub const CTL_TYPE_NODE_DISCOVER_RESP: u8 = 0x90;

// Text types.
pub const TXT_TYPE_CLI_DATA: u8 = 1;
pub const TXT_TYPE_SIGNED_PLAIN: u8 = 2;
/// Protocol 14: someone asked this radio to run a console command it would not run.
pub const TXT_TYPE_CLI_COMMAND: u8 = 3;

// Advert types: what kind of node a contact is.
pub const ADV_TYPE_CHAT: u8 = 1;
pub const ADV_TYPE_REPEATER: u8 = 2;
pub const ADV_TYPE_ROOM: u8 = 3;
pub const ADV_TYPE_SENSOR: u8 = 4;

pub const PUB_KEY_SIZE: usize = 32;
/// A contact is named on the wire by the first six bytes of its key.
pub const PUB_KEY_PREFIX_SIZE: usize = 6;
pub const MAX_PATH_SIZE: usize = 64;

/// Whether a code is a push rather than an answer.
pub fn is_push(code: u8) -> bool {
    code >= 0x80
}

/// The answers that carry a message from the radio's queue.
pub fn is_message(code: u8) -> bool {
    matches!(
        code,
        RESP_CONTACT_MSG_RECV
            | RESP_CHANNEL_MSG_RECV
            | RESP_CONTACT_MSG_RECV_V3
            | RESP_CHANNEL_MSG_RECV_V3
            | RESP_CHANNEL_DATA_RECV
    )
}
