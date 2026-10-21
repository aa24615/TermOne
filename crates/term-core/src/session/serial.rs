//! 串口会话：基于 serialport crate 的读写。

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serialport::{available_ports, DataBits, FlowControl, Parity, SerialPortType, StopBits};

use super::{ExitSink, OutputSink, SessionId, SessionKind, Spawned};
use crate::error::{Result, TermError};

#[derive(serde::Serialize, Clone, Debug)]
pub struct PortInfo {
    pub name: String,
    pub product: Option<String>,
    pub manufacturer: Option<String>,
}

pub fn list_ports() -> Result<Vec<PortInfo>> {
    let ports = available_ports().map_err(|e| TermError::Serial(e.to_string()))?;
    Ok(ports
        .into_iter()
        .map(|p| {
            let (product, manufacturer) = match &p.port_type {
                SerialPortType::UsbPort(info) => (info.product.clone(), info.manufacturer.clone()),
                _ => (None, None),
            };
            PortInfo {
                name: p.port_name,
                product,
                manufacturer,
            }
        })
        .collect())
}

/// 包装串口句柄为 `Write`，避免 trait 对象向上转型（兼容较旧工具链）。
struct PortWriter(Box<dyn serialport::SerialPort>);

impl Write for PortWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn(
    id: SessionId,
    path: String,
    baud: u32,
    data_bits: u8,
    parity: String,
    stop_bits: u8,
    flow_control: String,
    closing: Arc<AtomicBool>,
    output: OutputSink,
    exit: ExitSink,
) -> Result<Spawned> {
    let data_bits = if data_bits == 7 {
        DataBits::Seven
    } else {
        DataBits::Eight
    };
    let parity = match parity.as_str() {
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => Parity::None,
    };
    let stop_bits = if stop_bits == 2 {
        StopBits::Two
    } else {
        StopBits::One
    };
    let flow_control = match flow_control.as_str() {
        "xon" | "software" => FlowControl::Software,
        "rtscts" | "hardware" => FlowControl::Hardware,
        _ => FlowControl::None,
    };

    let port = serialport::new(&path, baud)
        .data_bits(data_bits)
        .parity(parity)
        .stop_bits(stop_bits)
        .flow_control(flow_control)
        .timeout(Duration::from_millis(40))
        .open()
        .map_err(|e| TermError::Serial(e.to_string()))?;

    let mut reader_port = port
        .try_clone()
        .map_err(|e| TermError::Serial(e.to_string()))?;

    {
        let closing = closing.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                if closing.load(Ordering::Relaxed) {
                    break;
                }
                match reader_port.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => output(id, buf[..n].to_vec()),
                    Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                    Err(_) => break,
                }
            }
            exit(id, None);
        });
    }

    Ok(Spawned {
        title: format!("{path} @ {baud}"),
        kind: SessionKind::Serial,
        writer: Box::new(PortWriter(port)),
        master: None,
        killer: None,
    })
}
