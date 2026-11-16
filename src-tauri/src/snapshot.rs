//! Trae 国际版 SQLCipher 数据库快照解密（由 src/collectors/trae-intl/snapshot.ts 移植）。
//!
//! 输入 database.db（可能加密）+ -wal + -journal，输出一份与 Node 侧
//! `openTraeSnapshot` 完全一致的**明文合并快照字节**，WebView 内直接用 sql.js 读取。

use aes::cipher::{block_padding::NoPadding, BlockDecryptMut, KeyIvInit};
use cbc::Decryptor as Aes256CbcDec;
use hmac::{Hmac, Mac};
use sha2::Sha512;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use subtle::ConstantTimeEq;

const SQLITE_HEADER: &[u8] = b"SQLite format 3\0";
const PAGE_SIZE: u32 = 4096;
const RESERVED: u32 = 80;
const DEFAULT_SQLCIPHER_KEY: &str = "3605f6691095a993f03d5009c918352ef5be31ae31e8f000212b81ff058da773";
const MAX_WAL_INDEX_PAGES: usize = 1024 * 1024;

fn make_error(message: &str) -> String {
    format!("Cannot read TRAE international usage: {message}")
}

fn make_transient_error(message: &str) -> String {
    make_error(message)
}

fn read_u32(data: &[u8], offset: usize, big_endian: bool) -> u32 {
    let bytes = &data[offset..offset + 4];
    if big_endian {
        u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
    } else {
        u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
    }
}

/// SQLite WAL 双校验和计算（与 snapshot.ts 的 checksum 完全一致）。
fn checksum(data: &[u8], big_endian: bool, state: (u32, u32)) -> (u32, u32) {
    let (mut a, mut b) = state;
    let mut index = 0usize;
    while index + 8 <= data.len() {
        let x = read_u32(data, index, big_endian);
        let y = read_u32(data, index + 4, big_endian);
        a = a.wrapping_add(x).wrapping_add(b);
        b = b.wrapping_add(y).wrapping_add(a);
        index += 8;
    }
    (a, b)
}

/// PBKDF2-HMAC-SHA512（与 Node pbkdf2Sync(key, salt, 2, 32, "sha512") 一致）。
fn derive_hmac_key(key: &[u8], salt: &[u8]) -> Result<[u8; 32], String> {
    let mut output = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha512>(key, salt, 2, &mut output);
    Ok(output)
}

fn hmac_sha512(hmac_key: &[u8], chunks: &[&[u8]]) -> Result<[u8; 64], String> {
    let mut mac = Hmac::<Sha512>::new_from_slice(hmac_key).map_err(|e| make_error(&e.to_string()))?;
    for chunk in chunks {
        mac.update(chunk);
    }
    Ok(mac.finalize().into_bytes().into())
}

/// 解密单页（与 snapshot.ts pageDecryptor.decrypt 一致）。page 为待解密页的完整 buffer。
fn decrypt_page(page: &mut [u8], page_number: u32, key: &[u8; 32], hmac_key: &[u8; 32], page_size: u32) -> Result<(), String> {
    let start = if page_number == 1 { 16usize } else { 0 };
    let iv_offset = (page_size - RESERVED) as usize;
    let page_id = (page_number as u32).to_le_bytes();

    let expected = hmac_sha512(hmac_key, &[&page[start..iv_offset + 16], &page_id])?;
    let mac_position = iv_offset + 16;
    if expected
        .ct_eq(&page[mac_position..mac_position + 64])
        .unwrap_u8()
        != 1
    {
        return Err(make_error(
            "SQLCipher authentication failed. The shared Trae key may have changed.",
        ));
    }

    let iv = page[iv_offset..iv_offset + 16].to_vec();
    let cipher =
        Aes256CbcDec::<aes::Aes256>::new_from_slices(key, &iv).map_err(|e| make_error(&e.to_string()))?;
    let mut buffer = page[start..iv_offset].to_vec();
    cipher.decrypt_padded_mut::<NoPadding>(&mut buffer).map_err(|_| {
        page.fill(0);
        make_error("AES-CBC decryption failed.")
    })?;
    page[start..iv_offset].copy_from_slice(&buffer);
    buffer.fill(0);

    if page_number == 1 {
        page[..16].copy_from_slice(SQLITE_HEADER);
        let plaintext_page_size = u16::from_be_bytes([page[16], page[17]]) as u32;
        if plaintext_page_size != page_size || page[20] != RESERVED as u8 {
            return Err(make_error("unsupported SQLCipher page format."));
        }
    }

    Ok(())
}

/// 索引 WAL 帧（与 snapshot.ts indexWal 一致），返回「页面 → WAL 内偏移」与提交后的总页数。
fn index_wal(wal: &[u8], page_size: u32) -> Result<(HashMap<u32, usize>, Option<u32>), String> {
    let mut pages = HashMap::new();

    if wal.is_empty() {
        return Ok((pages, None));
    }
    if wal.len() < 32 {
        return Err(make_transient_error("incomplete WAL header; retry when Trae is idle."));
    }

    let header = &wal[..32];
    let magic = read_u32(header, 0, true);
    if (magic != 0x377f_0682 && magic != 0x377f_0683)
        || read_u32(header, 4, true) != 3_007_000
        || read_u32(header, 8, true) != page_size
    {
        return Err(make_error("unsupported WAL format."));
    }

    let big_endian = magic == 0x377f_0683;
    let mut sum = checksum(&header[..24], big_endian, (0, 0));
    if sum.0 != read_u32(header, 24, true) || sum.1 != read_u32(header, 28, true) {
        return Err(make_error("WAL header checksum failed."));
    }

    let mut page_count: Option<u32> = None;
    let mut pending: HashMap<u32, usize> = HashMap::new();
    let frame_len = 24usize + page_size as usize;
    let mut offset = 32usize;

    while offset + frame_len <= wal.len() {
        let frame = &wal[offset..offset + frame_len];

        if frame[8..16] != header[16..24] {
            break;
        }

        sum = checksum(&frame[..8], big_endian, sum);
        sum = checksum(&frame[24..], big_endian, sum);
        if sum.0 != read_u32(frame, 16, true) || sum.1 != read_u32(frame, 20, true) {
            break;
        }

        let page_number = read_u32(frame, 0, true);
        let commit = read_u32(frame, 4, true);
        if page_number == 0 || page_number == 0xffff_ffff || commit == 0xffff_ffff {
            return Err(make_error("invalid WAL page number or database size."));
        }

        pending.insert(page_number, offset + 24);
        if pending.len() + pages.len() > MAX_WAL_INDEX_PAGES {
            return Err(make_error(
                "WAL index exceeds the bounded-memory limit; let Trae checkpoint its WAL and retry.",
            ));
        }

        if commit != 0 {
            for (page, position) in pending.drain() {
                pages.insert(page, position);
            }
            page_count = Some(commit);
            pages.retain(|&page, _| page <= commit);
        }

        offset += frame_len;
    }

    Ok((pages, page_count))
}

/// 读取并合并 Trae SQLCipher 快照，返回解密后的明文 SQLite 字节。
pub fn read_trae_snapshot(
    database_path: &str,
    key_override: Option<&str>,
) -> Result<Vec<u8>, String> {
    let db_path = Path::new(database_path);
    let wal_string = format!("{database_path}-wal");
    let journal_string = format!("{database_path}-journal");
    let wal_path = Path::new(&wal_string);
    let journal_path = Path::new(&journal_string);

    let db = fs::read(db_path).map_err(|e| make_error(&format!("database no longer exists: {e}")))?;
    let wal = fs::read(wal_path).unwrap_or_default();
    let journal = fs::read(journal_path).unwrap_or_default();

    if !journal.is_empty() && journal.len() >= 8 && journal[..8].iter().any(|&byte| byte != 0) {
        return Err(make_error("a rollback transaction is active; retry when Trae is idle."));
    }

    let size = db.len() as u64;
    if size < 100 {
        return Err(make_error("database is truncated."));
    }

    let encrypted = db[..16] != SQLITE_HEADER[..];
    let encoded_size = if encrypted {
        PAGE_SIZE
    } else {
        u16::from_be_bytes([db[16], db[17]]) as u32
    };
    let page_size = if encoded_size == 1 { 65536 } else { encoded_size };
    if page_size < 512
        || page_size > 65536
        || (page_size & (page_size - 1)) != 0
        || size % page_size as u64 != 0
    {
        return Err(make_error("invalid database page size or truncated database."));
    }

    let (page_key, hmac_key) = if encrypted {
        let hex = key_override.unwrap_or(DEFAULT_SQLCIPHER_KEY).trim();
        if !(hex.len() == 64 && hex.bytes().all(|c| c.is_ascii_hexdigit())) {
            return Err(make_error("TRAE_INTL_SQLCIPHER_KEY must contain 64 hex characters."));
        }
        let key: [u8; 32] = hex::decode(hex)
            .map_err(|e| make_error(&format!("invalid key hex: {e}")))?
            .try_into()
            .map_err(|_| make_error("invalid key length."))?;
        let mut salt = [0u8; 16];
        for (index, byte) in db[..16].iter().enumerate() {
            salt[index] = byte ^ 0x3a;
        }
        let hmac_key = derive_hmac_key(&key, &salt)?;
        (Some(key), hmac_key)
    } else {
        (None, [0u8; 32])
    };

    let (wal_pages, page_count) = index_wal(&wal, page_size)?;
    let final_page_count = page_count.unwrap_or_else(|| (size / page_size as u64) as u32);
    if final_page_count == 0 || final_page_count > 0xfffe_fffe {
        return Err(make_error("invalid database size."));
    }

    let byte_length = final_page_count as u64 * page_size as u64;
    let mut output = vec![0u8; byte_length as usize];

    for page_number in 1..=final_page_count {
        let (source, position): (&[u8], u64) = if let Some(&wal_position) = wal_pages.get(&page_number) {
            (&wal, wal_position as u64)
        } else {
            (&db, (page_number as u64 - 1) * page_size as u64)
        };
        let start = position as usize;
        let page_offset = (page_number as usize - 1) * page_size as usize;
        let page_end = page_offset + page_size as usize;
        let page = &mut output[page_offset..page_end];
        page.copy_from_slice(&source[start..start + page_size as usize]);

        if let Some(key) = &page_key {
            if let Err(error) = decrypt_page(page, page_number, key, &hmac_key, page_size) {
                output.fill(0);
                return Err(error);
            }
        }

        // 与 snapshot.ts getPage 的 page-1 修正一致
        if page_number == 1 {
            page[18] = 1;
            page[19] = 1;
            page[28..32].copy_from_slice(&final_page_count.to_be_bytes());
            let change_counter = page[24..28].to_vec();
            page[92..96].copy_from_slice(&change_counter);
        }
    }

    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decrypts_real_trae_database() {
        let Some(app_data) = std::env::var_os("APPDATA") else {
            eprintln!("SKIP: APPDATA is not available");
            return;
        };
        let path = Path::new(&app_data)
            .join("Trae")
            .join("ModularData")
            .join("ai-agent")
            .join("database.db");
        if !path.exists() {
            eprintln!("SKIP: real Trae database not found at {}", path.display());
            return;
        }

        let snapshot = read_trae_snapshot(&path.to_string_lossy(), None).expect("decrypt Trae snapshot");
        assert!(
            snapshot.starts_with(b"SQLite format 3\0"),
            "decrypted snapshot must carry a plain SQLite header"
        );

        // 用 rusqlite 验证解密结果可被标准 SQLite 引擎读取。
        let temp = std::env::temp_dir().join(format!("token-hall-test-{}.db", std::process::id()));
        fs::write(&temp, &snapshot).expect("write temp db");
        let result = (|| -> Result<i64, String> {
            let conn = rusqlite::Connection::open(&temp).map_err(|e| e.to_string())?;
            conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|e| e.to_string())
        })();
        let _ = fs::remove_file(&temp);

        let table_count = result.expect("decrypted DB must be readable by sqlite");
        assert!(table_count > 0, "decrypted DB contains no tables");
        eprintln!("decrypted snapshot has {table_count} schema objects");
    }
}
