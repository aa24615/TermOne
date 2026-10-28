use std::time::{Duration, Instant};
use term_core::{monitor::{MonitorConnection, MonitorStatus, MonitorTarget}, SshAuth};
fn wait(connection: &MonitorConnection, check: impl Fn(&MonitorStatus) -> bool) -> MonitorStatus {
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        let status = connection.status();
        if check(&status) { return status; }
        assert!(Instant::now() < deadline, "monitor timeout: {status:?}");
        std::thread::sleep(Duration::from_millis(50));
    }
}
fn main() {
    let port = std::env::args().nth(1).unwrap().parse().unwrap();
    let root = std::env::args().nth(2).unwrap();
    let target = |user: &str| MonitorTarget { host: "127.0.0.1".into(), port, user: Some(user.into()), auth: SshAuth::Agent, proxy_jump: None };
    let connection = MonitorConnection::start(target("agent"), 2).unwrap();
    let status = wait(&connection, |s| s.sample.as_ref().is_some_and(|s| s.sequence >= 2));
    assert!(status.sample.unwrap().cpu_pct.is_some());
    assert!(connection.authenticate("not-an-auth-prompt").is_err());
    connection.stop(); assert_eq!(connection.status().phase, "stopped");
    let connection = MonitorConnection::start(target("password"), 2).unwrap();
    wait(&connection, |s| s.phase == "auth");
    assert!(connection.authenticate("bad\ncommand").is_err());
    connection.authenticate("monitor-test").unwrap();
    wait(&connection, |s| s.sample.as_ref().is_some_and(|s| s.sequence >= 2));
    assert!(!format!("{:?}", connection.status()).contains("monitor-test"));
    drop(connection);
    let mut key_target = target("key");
    key_target.auth = SshAuth::Key { identity_file: format!("{root}/client-key") };
    let connection = MonitorConnection::start(key_target, 2).unwrap();
    wait(&connection, |s| s.sample.is_some()); drop(connection);
    let connection = MonitorConnection::start(target("unsupported"), 2).unwrap();
    assert!(wait(&connection, |s| s.phase == "error").error.unwrap().contains("Linux"));
    drop(connection);
    let connection = MonitorConnection::start(target("linux"), 2).unwrap();
    let sample = wait(&connection, |s| s.sample.as_ref().is_some_and(|s| s.sequence >= 2)).sample.unwrap();
    assert!(sample.memory_total > 0 && !sample.disks.is_empty() && !sample.network.is_empty());
    drop(connection);
    let connection = MonitorConnection::start(target("drop"), 2).unwrap();
    wait(&connection, |s| s.phase == "error");
    println!("monitor SSH smoke: agent, password, key, Linux collector, unsupported OS, disconnect and stop passed");
}
