use std::sync::Mutex;

use term_core::{Db, SessionManager};

pub struct AppState {
    pub sessions: SessionManager,
    pub db: Mutex<Db>,
}
