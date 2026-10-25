//! Node passwords in the system's credential store: Windows Credential
//! Manager, the macOS keychain, the Secret Service on Linux. The client asks
//! for them by an id of its own (`node-<key>`); the store files them under the
//! service `meshnet`.

use keyring::{Entry, Error};

const SERVICE: &str = "meshnet";

fn entry(id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, id).map_err(|e| e.to_string())
}

/// The saved secret, or nothing when none is kept under this id.
#[tauri::command]
pub fn secret_get(id: String) -> Result<Option<String>, String> {
    match entry(&id)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_set(id: String, value: String) -> Result<(), String> {
    entry(&id)?.set_password(&value).map_err(|e| e.to_string())
}

/// Deleting what is not there is not an error.
#[tauri::command]
pub fn secret_delete(id: String) -> Result<(), String> {
    match entry(&id)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
