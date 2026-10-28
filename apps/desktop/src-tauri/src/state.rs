use std::sync::Mutex;

use term_core::{Db, SessionManager};

pub struct AppState {
    pub sessions: SessionManager,
    pub db: Mutex<Db>,
    pub screen_lock: Mutex<crate::screen_lock::ScreenLock>,
    pub monitor: Mutex<crate::monitor::MonitorRegistry>,
}
