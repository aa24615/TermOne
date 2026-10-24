//! Invoked by tools/sftp-smoke.mjs against its loopback-only fixture server.
use std::{fs, path::PathBuf};
use term_core::{SftpAuth, SftpRequest};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args:Vec<_>=std::env::args().collect();
    let root=PathBuf::from(&args[2]);
    let req=SftpRequest{host:"127.0.0.1".into(),port:args[1].parse()?,user:Some("fixture".into()),auth:SftpAuth::Key{identity_file:root.join("client-key").to_string_lossy().into_owned()},proxy_jump:None};
    req.mkdir("/docs")?;
    let original=root.join("original.txt");fs::write(&original,b"original")?;
    req.upload(original.to_str().unwrap(),"/docs/fail.bin")?;
    let source=root.join("large.bin");let content:Vec<u8>=(0..52*1024*1024).map(|n|(n%251) as u8).collect();fs::write(&source,&content)?;
    req.upload(source.to_str().unwrap(),"/docs/data.bin")?;
    let rows=req.list("/docs")?;assert!(rows.iter().any(|e|e.name=="data.bin"&&e.size==content.len() as u64));
    println!("PASS: 52 MiB upload and directory listing");
    let dest=root.join("received.bin");fs::write(&dest,b"original-local")?;fs::write(root.join("drop-download"),b"1")?;
    assert!(req.download("/docs/data.bin",dest.to_str().unwrap()).is_err());assert_eq!(fs::read(&dest)?,b"original-local");
    assert!(!fs::read_dir(&root)?.any(|e|e.unwrap().file_name().to_string_lossy().ends_with(".part")));
    println!("PASS: disconnected download preserves existing destination and cleans partial file");
    req.download("/docs/data.bin",dest.to_str().unwrap())?;assert_eq!(fs::read(&dest)?,content);
    println!("PASS: retry download is byte-for-byte identical");
    fs::write(root.join("drop-upload"),b"1")?;
    assert!(req.upload(source.to_str().unwrap(),"/docs/fail.bin").is_err());
    req.download("/docs/fail.bin",original.to_str().unwrap())?;assert_eq!(fs::read(&original)?,b"original");
    println!("PASS: disconnected upload leaves the remote original intact");
    req.upload(source.to_str().unwrap(),"/docs/fail.bin")?;req.download("/docs/fail.bin",dest.to_str().unwrap())?;assert_eq!(fs::read(&dest)?,content);
    assert!(req.mkdir("bad\n!touch unsafe").is_err());
    println!("PASS: upload retry and batch newline-injection rejection");
    Ok(())
}
