//! The numbers of the MeshCore companion protocol this core reads or writes.
//!
//! Copied from `examples/companion_radio/MyMesh.cpp` in the firmware tree, as
//! `packages/meshcore/src/protocol/codes.ts` is: the firmware is the only
//! specification that cannot be out of date.

// App → radio.
pub const CMD_SEND_TXT_MSG: u8 = 2;
pub const CMD_SEND_CHANNEL_TXT_MSG: u8 = 3;
pub const CMD_GET_CONTACTS: u8 = 4;
pub const CMD_ADD_UPDATE_CONTACT: u8 = 9;
pub const CMD_SYNC_NEXT_MESSAGE: u8 = 10;
pub const CMD_RESET_PATH: u8 = 13;
pub const CMD_REMOVE_CONTACT: u8 = 15;
pub const CMD_REBOOT: u8 = 19;
pub const CMD_SEND_TELEMETRY_REQ: u8 = 39;
pub const CMD_FACTORY_RESET: u8 = 51;
pub const CMD_SEND_CONTROL_DATA: u8 = 55;

// Radio → app, in answer to a command. Always below 0x80.
pub const RESP_OK: u8 = 0;
pub const RESP_ERR: u8 = 1;
pub const RESP_END_OF_CONTACTS: u8 = 4;
pub const RESP_SENT: u8 = 6;
pub const RESP_CONTACT_MSG_RECV: u8 = 7;
pub const RESP_CHANNEL_MSG_RECV: u8 = 8;
pub const RESP_NO_MORE_MESSAGES: u8 = 10;
pub const RESP_CONTACT_MSG_RECV_V3: u8 = 16;
pub const RESP_CHANNEL_MSG_RECV_V3: u8 = 17;
pub const RESP_CHANNEL_DATA_RECV: u8 = 27;

// Radio → app, unprompted. Always 0x80 and above, which is how they are told apart.
pub const PUSH_MSG_WAITING: u8 = 0x83;
pub const PUSH_NEW_ADVERT: u8 = 0x8a;
pub const PUSH_CONTROL_DATA: u8 = 0x8e;
/// Not the firmware's: what the other client sharing the radio sent, as
/// `0xf0`, the command's length, the command, then the radio's answer.
pub const PUSH_MIRROR: u8 = 0xf0;

// Control packets, by the first byte of their payload (`onControlDataRecv` in
// `examples/simple_repeater/MyMesh.cpp`).
/// "Who hears me"; the low bit asks for key prefixes only.
pub const CTL_TYPE_NODE_DISCOVER_REQ: u8 = 0x80;
/// The answer; the low four bits are the node's advert type.
pub const CTL_TYPE_NODE_DISCOVER_RESP: u8 = 0x90;

// Text types.
pub const TXT_TYPE_CLI_DATA: u8 = 1;
pub const TXT_TYPE_SIGNED_PLAIN: u8 = 2;

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
